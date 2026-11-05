import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSubagentManager } from "../subagents/src/client.ts";
import { Orchestrator } from "./src/orchestrator.ts";
import { HerdrWorkspaces } from "./src/herdr.ts";
import { GithubPublisher } from "./src/github.ts";
import { sharedWorkers } from "./src/workers.ts";
import type { Run } from "./src/domain.ts";
import {
  formatRun,
  formatPlan,
  formatProgress,
  milestoneKey,
  widgetLines,
} from "./src/presentation.ts";
import {
  renderCard,
  renderWidget,
  expansionHint,
  type DisplayDetails,
} from "./src/render.ts";

export function overview(run: Run | undefined) {
  if (!run) return { status: "No run loaded" };
  return {
    run: run.id,
    paused: run.paused,
    cancelled: run.cancelled,
    jobs: Object.values(run.jobs).map((job) => ({
      id: job.id,
      stage: job.stage,
      state: job.state,
      repairs: job.repairs,
      source: job.source,
      checks: job.checks.map(({ name, code, sha, cancelled, timedOut }) => ({
        name,
        code,
        sha,
        cancelled,
        timedOut,
      })),
      verified: job.verification?.sha,
      worker: job.executor?.id,
      publication: job.publication,
      ci: job.ci?.state,
      integration: job.integration,
      blocker: job.blocker,
      workspace: job.workspace?.workspaceId,
      path: job.workspace?.path,
      cleanup: job.cleanup,
    })),
    integration: run.integration && {
      state: run.integration.state,
      sha: run.integration.sha,
      published: run.integration.publication,
      blocker: run.integration.blocker,
      workspace: run.integration.workspace?.workspaceId,
    },
  };
}

export default function (pi: ExtensionAPI) {
  let engine: Orchestrator | undefined;
  let context: ExtensionContext | undefined;
  let proposal: Awaited<ReturnType<Orchestrator["prepare"]>> | undefined;
  let lastMilestone = "";
  let notification: ReturnType<typeof setTimeout> | undefined;
  let pendingRun: Run | undefined;
  let lastDisplayed: Run | undefined;
  let shuttingDown = false;
  pi.registerMessageRenderer(
    "orchestrator-progress",
    (message, options, theme) => {
      const details = message.details as Partial<DisplayDetails> | undefined;
      const fallback =
        typeof message.content === "string"
          ? message.content
          : "Orchestrator update";
      return renderCard(
        (options.expanded ? details?.expanded : details?.summary) ?? fallback,
        theme,
        options.outputPad,
        !options.expanded && details?.expanded
          ? expansionHint(options, "for evidence and workspaces")
          : undefined,
      );
    },
  );
  const sendStatus = (run: Run | undefined, summary = formatRun(run)) => {
    pi.sendMessage(
      {
        customType: "orchestrator-progress",
        content: summary,
        display: true,
        details: { summary, expanded: formatRun(run, true), run: run?.id },
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  };
  const spaces = new HerdrWorkspaces();
  const flush = () => {
    notification = undefined;
    if (!context || shuttingDown || !pendingRun) return;
    const run = pendingRun;
    pendingRun = undefined;
    sendStatus(run, formatProgress(run, lastDisplayed));
    lastDisplayed = structuredClone(run);
  };
  const changed = (run: Run) => {
    if (shuttingDown) return;
    const jobs = Object.values(run.jobs);
    context?.ui.setStatus(
      "orchestrator",
      `${jobs.filter((j) => j.state === "complete").length}/${jobs.length} jobs · ${jobs.filter((j) => j.state === "blocked").length} blocked`,
    );
    if (context?.hasUI) {
      const lines = widgetLines(run);
      if (context.mode === "tui") {
        context.ui.setWidget("orchestrator", (_tui, theme) =>
          renderWidget(lines, theme),
        );
      } else context.ui.setWidget("orchestrator", lines);
    }
    const milestone = milestoneKey(run);
    if (milestone === lastMilestone) return;
    lastMilestone = milestone;
    pendingRun = structuredClone(run);
    if (!notification) notification = setTimeout(flush, 500);
    for (const job of jobs)
      if (job.workspace)
        void spaces
          .status(job.workspace, `${job.stage}: ${job.state}`)
          .catch(() => {});
  };
  const getEngine = async (ctx: ExtensionContext) => {
    if (engine) return engine;
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the repository before orchestration");
    const client = await getSubagentManager(pi);
    engine = new Orchestrator({
      repo: ctx.cwd,
      dataDir: getAgentDir(),
      workspaces: spaces,
      publisher: new GithubPublisher(),
      workers: sharedWorkers(client),
      changed,
      models: {
        async validate(choice) {
          const slash = choice.model.indexOf("/");
          const model = ctx.modelRegistry.find(
            choice.model.slice(0, slash),
            choice.model.slice(slash + 1),
          );
          if (
            slash < 1 ||
            !model ||
            !ctx.modelRegistry
              .getAvailable()
              .some((m) => m.provider === model.provider && m.id === model.id)
          )
            throw new Error(`Unavailable model: ${choice.model}; no fallback`);
          if (clampThinkingLevel(model, choice.thinking) !== choice.thinking)
            throw new Error(
              `Unsupported thinking level: ${choice.model}/${choice.thinking}`,
            );
        },
      },
    });
    return engine;
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearTimeout(notification);
    pendingRun = undefined;
    await engine?.close();
    engine = undefined;
    context?.ui.setStatus("orchestrator", undefined);
    context?.ui.setWidget("orchestrator", undefined);
    context = undefined;
  });
  pi.registerTool({
    name: "orchestrator",
    label: "Issue orchestrator",
    description:
      "Prepare an issue-batch plan or inspect/control an approved run. Read the orchestrate skill first. Prepare never executes; the user approves via /orchestrator approve <digest>. Returns compact outcomes; full evidence stays in artifact files. Active checkouts must not have a second writer.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Unsafe<
        "prepare" | "inspect" | "pause" | "resume" | "cancel" | "open"
      >({
        type: "string",
        enum: ["prepare", "inspect", "pause", "resume", "cancel", "open"],
      }),
      planPath: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      jobId: Type.Optional(Type.String()),
      acceptRevision: Type.Optional(Type.String()),
      acceptIntegrationRevision: Type.Optional(Type.String()),
      retrySetup: Type.Optional(Type.Boolean()),
      recoverWorkspace: Type.Optional(Type.Boolean()),
    }),
    renderCall(args, theme) {
      return renderCard(
        `Orchestrator · ${args.action ?? "working"}${args.jobId ? ` · ${args.jobId}` : ""}`,
        theme,
      );
    },
    renderResult(result, options, theme, ctx) {
      const display = (
        result.details as { display?: DisplayDetails } | undefined
      )?.display;
      const fallback = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return renderCard(
        options.isPartial
          ? "Orchestrator · working…"
          : ((options.expanded ? display?.expanded : display?.summary) ??
              fallback),
        theme,
        0,
        !options.expanded && display
          ? expansionHint(ctx, "for details")
          : undefined,
      );
    },
    async execute(_id, input, signal, _update, ctx) {
      const current = await getEngine(ctx);
      signal?.throwIfAborted();
      let details: unknown;
      if (input.action === "prepare") {
        if (!input.planPath) throw new Error("planPath required");
        const raw = await readFile(
          resolve(ctx.cwd, input.planPath.replace(/^@/, "")),
          "utf8",
        );
        if (raw.length > 2_000_000)
          throw new Error("Plan exceeds 2MB; use focused issue material");
        const plan = JSON.parse(raw);
        const inherited = ctx.model && {
          model: `${ctx.model.provider}/${ctx.model.id}`,
          thinking: ctx.thinkingLevel,
        };
        const implementation = plan.models?.implementation ?? inherited;
        plan.models = {
          ...plan.models,
          implementation,
          review: plan.models?.review ?? inherited,
          conflict: plan.models?.conflict ?? implementation,
        };
        proposal = await current.prepare(plan);
        details = {
          digest: proposal.digest,
          plan: {
            ...proposal.plan,
            jobs: proposal.plan.jobs.map((j) => ({
              ...j,
              issues: j.issues.map(
                ({ material: _material, ...issue }) => issue,
              ),
            })),
          },
          approvalCommand: `/orchestrator approve ${proposal.digest}`,
        };
      } else if (input.action === "pause") details = overview(current.pause());
      else if (input.action === "cancel")
        details = overview(await current.cancel(input.jobId));
      else if (input.action === "resume") {
        if (!ctx.hasUI)
          throw new Error(
            "Explicit interactive confirmation required for resume",
          );
        const summary = `Reconcile retained work and resume ${input.runId ?? "current run"}${input.jobId ? ` / ${input.jobId}` : ""}. ${input.acceptRevision ? `Accept scoped source revision ${input.acceptRevision}, invalidate verification.` : ""} ${input.acceptIntegrationRevision ? `Accept integration candidate ${input.acceptIntegrationRevision}; re-review and recheck.` : ""} ${input.retrySetup ? "Explicitly replay the pending approved setup command after inspecting its ambiguous prior outcome." : ""} ${input.recoverWorkspace ? "Adopt existing verified checkouts into the current herdr session; do not recreate them." : ""} No new permissions or scope are approved.`;
        if (
          !(await ctx.ui.confirm("Resume orchestrator?", summary, { signal }))
        )
          throw new Error("Resume not approved");
        await current.resume(input);
        await current.start();
        details = overview(current.inspect());
      } else if (input.action === "open") {
        const job = current.inspect()?.jobs[input.jobId ?? ""];
        if (!job?.workspace) throw new Error("Job workspace unavailable");
        await spaces.open(job.workspace);
        details = {
          opened: job.id,
          warning: "Active checkout is not safe for a second writer",
        };
      } else {
        const run = current.inspect();
        details =
          input.jobId && run
            ? {
                ...overview(run),
                artifacts: run.jobs[input.jobId]?.artifacts,
                history: run.history.slice(-10),
              }
            : overview(run);
      }
      const run = current.inspect();
      const summary =
        input.action === "prepare" && proposal
          ? formatPlan(proposal.plan, proposal.digest)
          : input.action === "open"
            ? `Opened ${input.jobId}\nActive checkout is not safe for a second writer.`
            : formatRun(run, false, input.jobId);
      const displaySummary =
        input.action === "prepare" && proposal
          ? [
              "Orchestrator · Ready for approval",
              "Nothing started. Isolated worktrees will be retained.",
              `${proposal.plan.jobs.length} job(s) · ${proposal.plan.delivery} delivery · concurrency ${proposal.plan.concurrency} · repair limit ${proposal.plan.repairLimit}`,
              `Permissions: ${proposal.plan.permissions.join("; ") || "none"}`,
              "Expand to review the full scope, commands, models and destination before approving.",
              `/orchestrator approve ${proposal.digest}`,
            ].join("\n")
          : summary;
      const expanded =
        input.action === "prepare" || input.action === "open"
          ? summary
          : formatRun(run, true, input.jobId);
      const text =
        input.jobId && input.action === "inspect" ? expanded : summary;
      return {
        content: [
          {
            type: "text",
            text:
              text.length > 24_000
                ? `${text.slice(0, 24_000)}\n[Truncated; inspect individual jobs or the plan file.]`
                : text,
          },
        ],
        details: {
          overview: details,
          display: { summary: displaySummary, expanded },
        },
      };
    },
  });
  pi.registerCommand("orchestrator", {
    description:
      "approve <digest> | status | pause | cancel [job] | worker <job> | release",
    getArgumentCompletions(prefix) {
      const choices = ["status", "pause", "cancel", "worker", "release"];
      if (proposal) choices.unshift(`approve ${proposal.digest}`);
      const items = choices
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      const [action, value] = args.trim().split(/\s+/);
      try {
        const current = await getEngine(ctx);
        if (action === "approve") {
          if (!proposal || value !== proposal.digest)
            throw new Error(
              "No matching proposal; prepare and inspect a plan first",
            );
          await current.approve(value);
          proposal = undefined;
          await current.start();
        } else if (action === "pause") current.pause();
        else if (action === "cancel") await current.cancel(value);
        else if (action === "worker") {
          const job = current.inspect()?.jobs[value];
          const worker =
            job?.executor?.id ?? job?.verification?.review.worker.id;
          if (!worker)
            throw new Error(
              "No live-registry worker; inspect retained artifacts/session files",
            );
          await (await getSubagentManager(pi)).openWorker(ctx, worker);
          return;
        } else if (action === "release") {
          await current.close();
          engine = undefined;
          proposal = undefined;
          clearTimeout(notification);
          notification = undefined;
          pendingRun = undefined;
          lastDisplayed = undefined;
          lastMilestone = "";
          ctx.ui.setStatus("orchestrator", undefined);
          ctx.ui.setWidget("orchestrator", undefined);
          ctx.ui.notify(
            "Orchestrator released. Worktrees and evidence retained.",
            "info",
          );
          return;
        } else if (action && action !== "status")
          throw new Error(
            "Use approve <digest>, status, pause, cancel [job], worker <job>, or release",
          );
        // Control changes already schedule a milestone; avoid duplicate cards.
        if (!action || action === "status") sendStatus(current.inspect());
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
