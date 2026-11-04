import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  BackendRegistry,
  type SubagentBackend,
} from "../subagents/src/backend.ts";
import type { SubagentClient } from "../subagents/src/client.ts";
import type {
  SubagentEvent,
  SubagentOwner,
  SubagentSnapshot,
} from "../subagents/src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
} from "../subagents/src/manager.ts";
import { makeStubBackend } from "../subagents/test/stub-backend.ts";
import type { CheckEvidence, ModelChoice, Plan } from "./src/domain.ts";
import type { Publisher, Publication } from "./src/github.ts";
import type { Workspaces } from "./src/herdr.ts";
import { Orchestrator } from "./src/orchestrator.ts";
import { sharedWorkers } from "./src/workers.ts";

const model = { model: "test/model", thinking: "off" as const };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function until(description: string, ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(5);
  }
}

function plan(): Plan {
  return {
    base: "HEAD",
    delivery: "draft-pr",
    destination: {
      remote: "origin",
      url: "https://github.com/test/shared-runner.git",
      repository: "test/shared-runner",
      prBase: "main",
    },
    jobs: ["cancelled", "repair"].map((id) => ({
      id,
      branch: `orchestrator/shared-runner/${id}`,
      issues: [
        {
          id: `ISSUE-${id}`,
          source: "local:test",
          title: "Write the completed result",
          material: "result.txt must contain ready, committed locally.",
          acceptance: ["result.txt contains ready"],
          retrievedAt: "2026-01-01T00:00:00Z",
        },
      ],
      dependencies: [],
    })),
    setup: [],
    checks: [
      { name: "ready", command: "grep -qx ready result.txt", timeoutMs: 2_000 },
    ],
    requiredCI: [],
    concurrency: 2,
    repairLimit: 1,
    permissions: ["create commits", "push owned branches and create draft PRs"],
    baselineExceptions: [],
    cleanup: "retain",
    models: { implementation: model, review: model, conflict: model },
  };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-runner-"));
  const repo = join(dir, "repo");
  const sessions = new Set<string>();
  const engines: Orchestrator[] = [];
  const stub = (cadenceMs: number) =>
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "test/model",
      contextWindow: 200_000,
      toolName: "bash",
      cadenceMs,
    });
  const quick = stub(1);
  // Ordinary agents stay occupied until explicitly cancelled. Their stub
  // tool events never execute commands or change any checkout.
  const occupied = stub(60_000);
  const turns: Array<{
    session: string;
    role: "implementation" | "review";
    prompt: string;
    sha: string;
    model: ModelChoice;
  }> = [];
  const backend: SubagentBackend = {
    ...quick,
    spawn: (task) =>
      Effect.gen(function* () {
        const session = yield* (task.execution ? quick : occupied).spawn(task);
        const originalMeta = yield* session.meta;
        const sessionFile = originalMeta.sessionFilePath!;
        sessions.add(sessionFile);
        const execution = task.execution;
        const actual = execution
          ? {
              modelLabel: `${execution.model.provider}/${execution.model.id}`,
              thinkingLevel: execution.thinkingLevel,
            }
          : {};
        let turn = 0;
        let prompt = task.prompt;
        return {
          ...session,
          meta: Effect.map(session.meta, (meta) => ({ ...meta, ...actual })),
          events: session.events.pipe(
            Stream.mapEffect((event) =>
              Effect.sync((): SubagentEvent => {
                if (event._tag === "MetaChanged")
                  return { ...event, meta: { ...event.meta, ...actual } };
                if (event._tag === "UserMessage") prompt = event.text;
                if (
                  !execution ||
                  event._tag !== "RunSettled" ||
                  event.outcome._tag !== "Completed"
                )
                  return event;
                const role = task.readOnly ? "review" : "implementation";
                if (role === "implementation") {
                  writeFileSync(
                    join(task.cwd, "result.txt"),
                    ++turn === 1 ? "not ready\n" : "ready\n",
                  );
                  git(task.cwd, "add", "result.txt");
                  git(task.cwd, "commit", "-m", `Implementation turn ${turn}`);
                }
                turns.push({
                  session: sessionFile,
                  role,
                  prompt,
                  sha: git(task.cwd, "rev-parse", "HEAD"),
                  model: {
                    model: actual.modelLabel!,
                    thinking: execution.thinkingLevel,
                  },
                });
                return {
                  _tag: "RunSettled",
                  outcome: {
                    _tag: "Completed",
                    finalText:
                      role === "review"
                        ? JSON.stringify({ verdict: "pass", findings: [] })
                        : `Committed implementation turn ${turn}`,
                  },
                };
              }),
            ),
          ),
        };
      }),
  };
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(Layer.succeed(BackendRegistry, new Map([["pi", backend]]))),
    ),
  );
  t.after(async () => {
    try {
      for (const engine of engines) await engine.close();
    } finally {
      await runtime.dispose();
      await Promise.all([...sessions].map((path) => rm(path, { force: true })));
      await rm(dir, { recursive: true, force: true });
    }
  });
  await mkdir(join(repo, "docs/agents"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Shared runner test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "core.hooksPath", "/dev/null");
  await writeFile(
    join(repo, "docs/agents/issue-tracker.md"),
    "Local issues.\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Baseline");
  const base = git(repo, "rev-parse", "HEAD");
  const manager = await runtime.runPromise(SubagentManager);
  const parent = { parentCwd: repo, projectTrusted: false };
  const ordinaryNotifications: Array<{ id: string; consumed: boolean }> = [];
  manager.view.setOnSettled((snapshot, consumed) => {
    ordinaryNotifications.push({ id: snapshot.id, consumed });
  });
  const occupancy: Array<{ ordinary: number; owned: number }> = [];
  const unsubscribe = manager.view.subscribe(() => {
    const running = manager.view.list().filter((s) => s.status === "running");
    occupancy.push({
      ordinary: running.filter((s) => !s.ownerId).length,
      owned: running.filter((s) => s.ownerId).length,
    });
  });
  t.after(unsubscribe);

  // Instrument the public client boundary, retaining the exact capability
  // identity on every forwarded operation; the manager itself is never mocked.
  const owners = new Map<SubagentOwner, SubagentOwner>();
  const completions: Array<{
    owner: SubagentOwner;
    snapshot: SubagentSnapshot;
  }> = [];
  const continuations: Array<{
    owner: SubagentOwner;
    id: string;
    text: string;
  }> = [];
  function delegated(owner: SubagentOwner) {
    const result = owners.get(owner);
    assert.ok(result, "Continuation/cancellation must use its original owner");
    return result;
  }
  const client: SubagentClient = {
    spawnOwned(task, owner) {
      const delegate = {
        id: owner.id,
        onSettled(snapshot: SubagentSnapshot) {
          completions.push({ owner, snapshot });
          owner.onSettled(snapshot);
        },
      };
      assert.ok(
        !owners.has(owner),
        "Each new worker has a fresh owner capability",
      );
      owners.set(owner, delegate);
      return runtime.runPromise(
        manager.spawnOwned({ ...task, parent }, delegate),
      );
    },
    sendOwned(owner, id, text) {
      continuations.push({ owner, id, text });
      return runtime.runPromise(manager.sendOwned(delegated(owner), id, text));
    },
    cancelOwned(owner, ids) {
      return runtime.runPromise(manager.cancelOwned(delegated(owner), ids));
    },
    get: (id) => manager.view.get(id),
    list: () => manager.view.list(),
    availableSlots: () => manager.view.availableSlots(),
    subscribe: (listener) => manager.view.subscribe(listener),
    async openWorker() {
      throw new Error("This headless test must not open a worker UI");
    },
  };
  const workspaces: Workspaces = {
    async preflight() {},
    async create(input) {
      git(
        input.repo,
        "worktree",
        "add",
        "-b",
        input.branch,
        input.path,
        input.base,
      );
      return {
        path: input.path,
        branch: input.branch,
        workspaceId: input.label,
      };
    },
    async reconcile(workspace) {
      return workspace;
    },
    async open() {},
    async status() {},
  };
  const publications: Publication[] = [];
  const publisher: Publisher = {
    async preflight() {},
    async publish(input) {
      const publication = {
        number: publications.length + 1,
        url: "https://github.com/test/shared-runner/pull/1",
        sha: input.sha,
      };
      publications.push(publication);
      return publication;
    },
    async ci(_destination, sha) {
      return { sha, state: "passed", checks: [] };
    },
    async pushIntegration() {
      throw new Error("Unexpected integration push");
    },
  };
  const checks = new Map<string, CheckEvidence>();
  const engine = new Orchestrator({
    repo,
    dataDir: join(dir, "data"),
    workspaces,
    publisher,
    workers: sharedWorkers(client),
    models: {
      async validate(choice) {
        assert.deepEqual(choice, model);
      },
    },
    changed(run) {
      for (const check of run.jobs.repair.checks) checks.set(check.sha, check);
    },
  });
  engines.push(engine);
  return {
    engine,
    repo,
    base,
    manager,
    runtime,
    parent,
    turns,
    completions,
    continuations,
    ordinaryNotifications,
    occupancy,
    publications,
    checks,
  };
}

test(
  "approved jobs share ordinary capacity, cancel only their own queue, and repair in the owned session before fresh review",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const { engine, manager, runtime } = f;
    const ordinary = await runtime.runPromise(
      Effect.forEach([1, 2, 3, 4], (n) =>
        manager.spawn({
          title: `ordinary ${n}`,
          prompt: "Stay occupied without editing files",
          cwd: f.repo,
          parent: f.parent,
        }),
      ),
    );
    assert.equal(manager.view.availableSlots(), 0);
    const proposal = await engine.prepare(plan());
    const approved = await engine.approve(proposal.digest);
    assert.equal(approved.approval, proposal.digest);
    await engine.start();
    await until("both jobs waiting for shared capacity", () =>
      Object.values(engine.inspect()!.jobs).every(
        (job) =>
          job.stage === "implementation" &&
          job.intent?.kind === "implementation",
      ),
    );
    assert.equal(manager.view.list().length, 4);
    assert.ok(
      Object.values(engine.inspect()!.jobs).every(
        (job) => !job.executors.length,
      ),
    );
    assert.equal(f.turns.length, 0);

    await engine.cancel("cancelled");
    const queued = engine.inspect()!;
    assert.equal(queued.jobs.cancelled.state, "cancelled");
    assert.equal(queued.jobs.repair.state, "running");
    assert.equal(queued.jobs.repair.executors.length, 0);
    assert.equal(manager.view.availableSlots(), 0);
    assert.ok(
      ordinary.every((s) => manager.view.get(s.id)?.status === "running"),
    );
    assert.equal(f.ordinaryNotifications.length, 0);
    assert.equal(f.completions.length, 0);
    assert.equal(f.continuations.length, 0);

    // Free exactly one slot: three ordinary agents compete with every owned turn.
    await runtime.runPromise(manager.cancel([ordinary[0].id]));
    await engine.settled();
    const run = engine.inspect()!;
    const job = run.jobs.repair;
    assert.equal(
      job.state,
      "complete",
      job.blocker ?? "Repair job must complete",
    );
    assert.equal(run.jobs.cancelled.state, "cancelled");
    assert.equal(run.jobs.cancelled.executors.length, 0);
    assert.equal(job.attempts, 2);
    assert.equal(job.repairs, 1);
    assert.deepEqual(
      [...f.checks.values()].map((c) => c.code),
      [1, 0],
    );
    assert.ok([...f.checks.values()].every((c) => !c.cancelled && !c.timedOut));
    assert.deepEqual(
      job.executors.map((e) => e.role),
      ["implementation", "implementation", "review"],
    );
    const [initial, repair, reviewer] = job.executors;
    assert.equal(repair.id, initial.id);
    assert.ok(initial.session);
    assert.equal(repair.session, initial.session);
    assert.notEqual(reviewer.id, initial.id);
    assert.ok(reviewer.session);
    assert.notEqual(reviewer.session, initial.session);
    assert.equal(f.continuations.length, 1);
    assert.equal(f.continuations[0].id, initial.id);
    assert.match(
      f.continuations[0].text,
      /Repair feedback: Check failed: ready/,
    );
    assert.deepEqual(
      f.turns.map((turn) => turn.role),
      ["implementation", "implementation", "review"],
    );
    assert.deepEqual(
      f.turns.map((turn) => turn.session),
      [initial.session, initial.session, reviewer.session],
    );
    assert.notEqual(f.turns[0].sha, f.turns[1].sha);
    assert.deepEqual([...f.checks.keys()], [f.turns[0].sha, f.turns[1].sha]);
    assert.equal(
      f.turns[1].sha,
      f.turns[2].sha,
      "Review must not edit the checkout",
    );
    assert.equal(manager.view.get(reviewer.id)?.readOnly, true);
    assert.deepEqual(
      f.turns.map((turn) => turn.model),
      [model, model, model],
    );
    assert.deepEqual(
      job.executors.map((executor) => executor.model),
      [model, model, model],
    );
    assert.deepEqual(job.verification?.review.worker.model, model);
    assert.equal(job.verification?.review.worker.id, reviewer.id);
    assert.equal(job.verification?.sha, f.turns[1].sha);
    assert.equal(job.verification?.checks[0].sha, job.source);
    assert.equal(job.publication?.sha, job.source);
    assert.equal(f.publications.length, 1);

    // Exactly one owner delivery per turn, and no owned results on the ordinary hook.
    assert.deepEqual(
      f.completions.map(({ snapshot }) => snapshot.id),
      [initial.id, initial.id, reviewer.id],
    );
    assert.ok(
      f.completions.every(
        ({ owner, snapshot }) =>
          owner.id === `${run.id}:repair` &&
          snapshot.ownerId === owner.id &&
          snapshot.status === "done" &&
          snapshot.outcome === "Completed",
      ),
    );
    assert.deepEqual(
      f.completions.map(({ snapshot }) => ({
        model: snapshot.meta.modelLabel,
        thinking: snapshot.meta.thinkingLevel,
      })),
      [model, model, model],
    );
    assert.equal(f.completions[0].owner, f.continuations[0].owner);
    assert.equal(f.completions[1].owner, f.completions[0].owner);
    assert.notEqual(f.completions[2].owner, f.completions[0].owner);
    assert.deepEqual(f.ordinaryNotifications, [
      { id: ordinary[0].id, consumed: true },
    ]);
    assert.ok(
      ordinary
        .slice(1)
        .every((s) => manager.view.get(s.id)?.status === "running"),
    );
    assert.ok(
      f.occupancy.every(({ ordinary, owned }) => ordinary + owned <= 4),
    );
    assert.ok(
      f.occupancy.some(({ ordinary, owned }) => ordinary === 4 && owned === 0),
    );
    assert.ok(
      f.occupancy.some(({ ordinary, owned }) => ordinary === 3 && owned === 1),
    );
    assert.equal(manager.view.availableSlots(), 1);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    assert.equal(git(job.workspace!.path, "show", "HEAD:result.txt"), "ready");
    assert.equal(git(job.workspace!.path, "status", "--porcelain"), "");
  },
);
