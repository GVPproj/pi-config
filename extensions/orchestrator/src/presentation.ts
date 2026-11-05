import type { CheckEvidence, Integration, Job, Plan, Run } from "./domain.ts";

// Escape rather than execute terminal controls (including bidi overrides). Keeping
// escapes visible also avoids silently changing an approved shell command.
function text(value: unknown): string {
  return String(value).replace(
    /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function short(value: unknown, limit = 160): string {
  const safe = text(String(value).replace(/\s+/g, " ")).trim();
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}
function outcome(check: CheckEvidence): string {
  if (check.timedOut) return "timed out";
  if (check.cancelled) return "cancelled";
  if (check.code === null) return "missing result";
  return check.code === 0 ? "passed" : `failed (exit ${check.code})`;
}
function staleJob(job: Job): boolean {
  return (
    ["workspace", "setup", "implementation"].includes(job.stage) ||
    ["implementation", "compose-prerequisites", "repair"].includes(
      job.intent?.kind ?? "",
    )
  );
}
function checkSummary(
  plan: Plan,
  evidence: CheckEvidence[],
  sha?: string,
  stale = false,
): string {
  const counts = new Map<string, number>();
  for (const spec of plan.checks) {
    const check = [...evidence]
      .reverse()
      .find((item) => item.name === spec.name && item.command === spec.command);
    const status = !check
      ? "missing"
      : stale || !sha || check.sha !== sha
        ? `stale (${outcome(check)})`
        : outcome(check);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return short(
    [...counts].map(([status, count]) => `${count} ${status}`).join(", "),
    200,
  );
}
function ciSummary(job: Job): string {
  if (!job.ci) return "missing";
  return `${job.ci.state}${staleJob(job) || job.ci.sha !== job.source ? " (stale)" : ""}`;
}
function phase(job: Job): string {
  if (job.state === "blocked") return "Needs attention";
  if (job.state === "failed") return "Failed";
  if (job.state === "cancelled") return "Cancelled";
  if (job.state === "complete") return "Job complete";
  if (job.state === "queued") return "Waiting to start";
  return {
    workspace: "Preparing isolated workspace",
    setup: "Installing & setting up",
    implementation: job.repairs ? "Repairing" : "Implementing",
    checking: "Running checks",
    review: "Independent review",
    verified: "Verified",
    publication: "Publishing draft PR",
    ci: "Waiting for required CI",
    integration: "Integrating",
  }[job.stage];
}
function mark(state: Job["state"]): string {
  return state === "complete"
    ? "✓"
    : ["blocked", "failed"].includes(state)
      ? "!"
      : state === "running"
        ? "●"
        : "○";
}
function jobLine(run: Run, job: Job): string {
  const review = !job.verification
    ? "missing"
    : staleJob(job) || job.verification.sha !== job.source
      ? "stale"
      : "recorded";
  return [
    `${mark(job.state)} ${short(job.id, 64)} · ${phase(job)}${job.repairs ? ` · Repair ${job.repairs}/${run.plan.repairLimit}` : ""}`,
    ...(job.checks.length ||
    ["checking", "review", "verified"].includes(job.stage)
      ? [
          `  checks: ${checkSummary(run.plan, job.checks, job.source, staleJob(job))}${review !== "missing" ? ` · review: ${review}` : ""}`,
        ]
      : []),
    ...(run.plan.delivery !== "integration"
      ? [
          ...(job.publication
            ? [
                `  Draft PR: ${job.publication.sha === job.source && !staleJob(job) ? "published" : "stale"} · ${short(job.publication.url, 240)}`,
              ]
            : []),
          ...(job.ci ? [`  CI: ${ciSummary(job)}`] : []),
        ]
      : []),
    ...(job.blocker ? [`  blocker: ${short(job.blocker, 240)}`] : []),
    ...(job.feedback && job.state !== "complete"
      ? [`  repair feedback: ${short(job.feedback, 240)}`]
      : []),
    ...(job.stage === "implementation" && job.repairs
      ? ["  Revised code still needs fresh checks and independent review."]
      : []),
  ].join("\n");
}
function integrationLine(run: Run): string {
  const integration = run.integration;
  if (!integration)
    return `Integration: ${run.plan.integration ? "missing / pending" : "not requested"}`;
  // Accepted SHA is not the candidate being merged/repaired. Never present its
  // old checks as current while the checkout may be changing.
  const stale =
    ["workspace", "merge", "repair", "setup"].includes(
      integration.intent?.kind ?? "",
    ) || Boolean(integration.feedback);
  const sha =
    integration.intent?.kind === "checking"
      ? integration.intent.sha
      : (integration.candidate ?? integration.sha);
  return [
    `Integration: ${integration.state}${integration.job ? ` / ${short(integration.job, 64)}` : ""}${integration.intent ? ` / ${integration.intent.kind}` : ""}`,
    ...(integration.state === "complete" && run.plan.integration
      ? [
          `  Branch: ${short(run.plan.integration.branch, 180)} · Worktree retained`,
        ]
      : []),
    ...(integration.checks.length
      ? [`  checks: ${checkSummary(run.plan, integration.checks, sha, stale)}`]
      : []),
    ...(integration.publication
      ? [
          `  Publication: ${integration.publication === integration.sha ? "recorded" : "stale"}`,
        ]
      : []),
    ...(integration.blocker ? [`blocker: ${short(integration.blocker)}`] : []),
    ...(integration.feedback
      ? [`repair feedback: ${short(integration.feedback)}`]
      : []),
  ].join("\n");
}
function control(run: Run): string {
  return run.cancelled
    ? "cancelled"
    : run.paused
      ? "paused — active work may still finish"
      : run.plan.jobs.every(
            (spec) => run.jobs[spec.id]?.state === "complete",
          ) &&
          (!run.plan.integration || run.integration?.state === "complete")
        ? "delivery complete"
        : "in progress";
}
function jobs(run: Run): Job[] {
  return Object.values(run.jobs).sort((a, b) => a.id.localeCompare(b.id));
}
function priority(job: Job): number {
  return job.blocker || ["blocked", "failed", "cancelled"].includes(job.state)
    ? 0
    : job.feedback
      ? 1
      : job.state === "running"
        ? 2
        : job.state === "queued"
          ? 3
          : 4;
}
function prioritized(run: Run): Job[] {
  return jobs(run).sort((a, b) => priority(a) - priority(b));
}
function counts(run: Run): string {
  const all = jobs(run);
  const count = (state: Job["state"]) =>
    all.filter((job) => job.state === state).length;
  return [
    `Jobs: ${count("complete")}/${run.plan.jobs.length} complete`,
    ...(["running", "queued", "blocked", "failed", "cancelled"] as const)
      .filter((state) => count(state))
      .map((state) => `${count(state)} ${state}`),
  ].join(" · ");
}
function delivery(run: Run): string {
  const complete =
    run.plan.jobs.every((spec) => run.jobs[spec.id]?.state === "complete") &&
    (!run.plan.integration || run.integration?.state === "complete");
  return `Delivery: ${run.plan.delivery}; ${run.cancelled ? "cancelled" : complete ? "complete" : "pending"}${run.plan.integration ? `; integration ${run.integration?.state ?? "missing"}` : ""}`;
}
function limitedJobs(run: Run, selected: Job[], limit: number): string[] {
  const shown = selected.slice(0, limit);
  const hidden = selected.slice(limit);
  return [
    ...shown.map((job) => jobLine(run, job)),
    ...(hidden.length
      ? [
          `${hidden.length} more jobs (${hidden.filter((job) => priority(job) === 0).length} blocked/failed/cancelled or with blockers); expand for details.`,
        ]
      : []),
  ];
}

/** Compact, bounded overview by default; expanded includes retained evidence. */
export function formatRun(
  run: Run | undefined,
  expanded = false,
  jobId?: string,
): string {
  if (!run) return "No orchestrator run.";
  if (jobId && !run.jobs[jobId])
    return `Unknown orchestrator job: ${text(jobId)}`;
  const selected = jobId ? [run.jobs[jobId]] : prioritized(run);
  const lines = [
    `Orchestrator · ${control(run)}`,
    counts(run),
    ...limitedJobs(run, selected, expanded ? Infinity : 6),
    delivery(run),
    ...(!jobId ? [integrationLine(run)] : []),
  ];
  if (expanded) {
    lines.push(
      `Repository: ${text(run.repo)}`,
      `Identity: ${text(run.identity)}`,
      `Approval: ${text(run.approval)} at ${text(run.approvedAt)}`,
    );
    lines.push(`Run: ${text(run.id)}`);
    for (const job of selected)
      lines.push(
        ...details(`Job ${text(job.id)}`, {
          source: job.source,
          base: job.base,
          workspace: job.workspace,
          checks: job.checks,
          setupEvidence: job.setupEvidence,
          verification: job.verification && {
            sha: job.verification.sha,
            time: job.verification.time,
            reviewArtifact: job.verification.review.artifact,
          },
          workers: job.executors,
          publication: job.publication,
          ci: job.ci,
          integration: job.integration,
          blocker: job.blocker,
          feedback: job.feedback,
          artifacts: job.artifacts,
          cleanup: job.cleanup,
        }),
      );
    if (run.integration && !jobId)
      lines.push(...details("Integration", run.integration));
    lines.push(
      ...details("Run artifacts", run.artifacts),
      ...(!jobId
        ? details("Recent history (last 10)", run.history.slice(-10))
        : []),
    );
  }
  return lines.join("\n");
}

// Recursive labeled plain text, not terminal markup. Do not truncate expanded
// evidence: full SHAs, commands, paths and worker sessions are inspection aids.
function details(label: string, value: unknown, indent = ""): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object")
    return [`${indent}${label}: ${text(value)}`];
  const entries = Object.entries(value);
  if (!entries.length) return [`${indent}${label}: none`];
  return [
    `${indent}${label}:`,
    ...entries.flatMap(([key, item]) =>
      details(text(key), item, `${indent}  `),
    ),
  ];
}

/** The approval surface is deliberately unabridged, unlike live status. */
export function formatPlan(plan: Plan, digest: string): string {
  const lines = [
    "Orchestrator approval plan",
    `Approval digest: ${text(digest)}`,
    `Base SHA: ${text(plan.base)}`,
    `Delivery: ${plan.delivery} (PRs are draft only; no automatic merge or issue closure)`,
    `Concurrency: ${plan.concurrency}; repair limit per job: ${plan.repairLimit}`,
    `Cleanup: ${plan.cleanup} (workspaces and artifacts retained)`,
    ...details("Destination", plan.destination ?? "none"),
    ...details("Integration", plan.integration ?? "none"),
    ...details("Models (frozen choices)", plan.models),
    ...details("Permissions", plan.permissions),
    ...details(
      "Baseline exceptions (not permission to ignore new failures)",
      plan.baselineExceptions,
    ),
  ];
  for (const [label, commands] of [
    ["Setup", plan.setup],
    ["Checks", plan.checks],
  ] as const) {
    lines.push(`${label}: ${commands.length ? "" : "none"}`);
    for (const command of commands)
      lines.push(
        `  ${text(command.name)}; timeout ${command.timeoutMs} ms`,
        `    command: ${text(command.command)}`,
      );
  }
  lines.push(...details("Required CI", plan.requiredCI));
  for (const job of plan.jobs) {
    lines.push(
      `Job ${text(job.id)}; branch: ${text(job.branch)}`,
      ...details("Dependencies", job.dependencies, "  "),
      `  PR base: ${text(job.prBaseJob ? `job ${job.prBaseJob}` : (plan.destination?.prBase ?? "not applicable"))}`,
      ...details(
        "Issues / acceptance",
        job.issues.map(({ material: _material, ...issue }) => issue),
        "  ",
      ),
    );
  }
  lines.push(
    "Safety: exact-source checks and independent review required; missing evidence is not passing. Children cannot spawn agents, push, publish, deploy, close issues, create other worktrees, weaken tests or change the approved plan. No second writer. Publication is parent-owned and limited to approved delivery.",
    "Full issue source material remains in the plan file and run artifacts.",
    "External control characters are displayed as literal Unicode escapes.",
    "Nothing has started. Approve this exact plan with:",
    `/orchestrator approve ${text(digest)}`,
  );
  return lines.join("\n");
}

/** At most five single-line rows; the TUI truncates rather than wrapping them. */
export function widgetLines(run: Run): string[] {
  const selected = prioritized(run);
  const all = jobs(run);
  const blocked = all.filter((job) =>
    ["blocked", "failed"].includes(job.state),
  ).length;
  return [
    `Orchestrator · ${control(run)} · ${all.filter((job) => job.state === "complete").length}/${all.length} jobs complete${blocked ? ` · ${blocked} blocked` : ""}`,
    ...selected
      .slice(0, 2)
      .map(
        (job) =>
          `${mark(job.state)} ${short(job.id, 64)} · ${phase(job)}${job.repairs ? ` · Repair ${job.repairs}/${run.plan.repairLimit}` : ""}${job.blocker ? ` · ${short(job.blocker)}` : ""}`,
      ),
    `Delivery: ${run.plan.delivery}${run.integration ? ` · Integration ${run.integration.state}` : ""} · Worktrees retained`,
    "/orchestrator status for details",
  ];
}

function jobMilestone(job: Job): unknown {
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    repairs: job.repairs,
    attempts: job.attempts,
    blocker: job.blocker,
    feedback: job.feedback,
    source: job.source,
    verification: job.verification?.sha,
    invalidations: job.invalidations,
    publication: job.publication,
    ci: job.ci && { sha: job.ci.sha, state: job.ci.state },
    integration: job.integration,
  };
}
function integrationMilestone(integration?: Integration): unknown {
  if (!integration) return null;
  return {
    state: integration.state,
    job: integration.job,
    sha: integration.sha,
    candidate: integration.candidate,
    publication: integration.publication,
    blocker: integration.blocker,
    feedback: integration.feedback,
    // Checking intents repeat for every command; their timestamps are noise.
    phase: integration.intent?.kind,
  };
}
/** Stable across command-by-command evidence, artifacts and CI polling noise. */
export function milestoneKey(run: Run): string {
  return text(
    JSON.stringify([
      run.id,
      run.paused,
      run.cancelled,
      jobs(run).map(jobMilestone),
      integrationMilestone(run.integration),
    ]),
  );
}

/** No unchanged job/integration lines; an unchanged snapshot yields no text. */
export function formatProgress(run: Run, previous?: Run): string {
  if (previous?.id !== run.id) previous = undefined;
  const lines: string[] = [];
  if (
    !previous ||
    run.paused !== previous.paused ||
    run.cancelled !== previous.cancelled
  )
    lines.push(`Orchestrator · ${control(run)}`);
  const changed = prioritized(run).filter(
    (job) =>
      !previous ||
      JSON.stringify(jobMilestone(job)) !==
        JSON.stringify(
          previous.jobs[job.id] && jobMilestone(previous.jobs[job.id]),
        ),
  );
  // Large batches stay compact; omitted jobs are disclosed and expandable.
  lines.push(...limitedJobs(run, changed, 6));
  if (
    !previous ||
    JSON.stringify(integrationMilestone(run.integration)) !==
      JSON.stringify(integrationMilestone(previous.integration))
  )
    lines.push(integrationLine(run));
  if (!previous || delivery(run) !== delivery(previous))
    lines.push(delivery(run));
  return lines.join("\n");
}
