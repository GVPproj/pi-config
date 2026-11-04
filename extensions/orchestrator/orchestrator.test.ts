import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { Orchestrator } from "./src/orchestrator.ts";
import type { Plan, Workers, WorkerResult } from "./src/domain.ts";
import type { Workspaces } from "./src/herdr.ts";
import { GithubPublisher, type Publisher } from "./src/github.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function repository(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-orchestrator-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "initial.txt"), "baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "baseline");
  return { dir, repo, base: git(repo, "rev-parse", "HEAD") };
}

const model = { model: "test/model", thinking: "off" as const };
function plan(base: string): Plan {
  return {
    base,
    delivery: "draft-pr",
    destination: {
      remote: "origin",
      url: "https://github.com/test/repo.git",
      repository: "test/repo",
      prBase: "main",
    },
    jobs: [
      {
        id: "one",
        branch: "orchestrator/test/one",
        issues: [
          {
            id: "ISSUE-1",
            source: "local:test",
            title: "Add one",
            material: "Add one.txt",
            acceptance: ["one.txt exists"],
            retrievedAt: "2026-01-01T00:00:00Z",
          },
        ],
        dependencies: [],
      },
    ],
    setup: [],
    checks: [{ name: "focused", command: "test -f one.txt", timeoutMs: 1000 }],
    requiredCI: [],
    concurrency: 2,
    repairLimit: 2,
    permissions: ["create commits", "push owned branches and create draft PRs"],
    baselineExceptions: [],
    cleanup: "retain",
    models: { implementation: model, review: model, conflict: model },
  };
}
async function tracker(repo: string) {
  await mkdir(join(repo, "docs/agents"), { recursive: true });
  await writeFile(
    join(repo, "docs/agents/issue-tracker.md"),
    "Issues are local Markdown.\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "tracker convention");
}
const available = { async validate() {} };
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected external effect before execution");
};
const workspaces: Workspaces = {
  async preflight() {},
  create: unexpected,
  reconcile: unexpected,
  open: unexpected,
  status: unexpected,
};
const publisher: Publisher = {
  async preflight() {},
  publish: unexpected,
  ci: unexpected,
  pushIntegration: unexpected,
};

test("planning freezes an exact revision and needs matching approval before retaining a run", async (t) => {
  const { repo, dir } = await repository(t);
  await tracker(repo);
  const engine = new Orchestrator({
    repo,
    dataDir: join(dir, "data"),
    models: available,
    workspaces,
    publisher,
  });
  t.after(() => engine.close());
  const proposal = await engine.prepare(plan("HEAD"));
  assert.equal(proposal.plan.base, git(repo, "rev-parse", "HEAD"));
  assert.equal(engine.inspect(), undefined);
  await assert.rejects(engine.approve("wrong-digest"), /approval/i);
  const run = await engine.approve(proposal.digest);
  assert.equal(run.approval, proposal.digest);
  assert.equal(run.jobs.one.state, "queued");
  assert.equal(run.plan.models.review.model, "test/model");
  assert.ok(run.artifacts.some((p) => p.endsWith("tracker.md")));
});

test("planning rejects cyclic or missing dependencies and incoherent dependent PRs", async (t) => {
  const { repo, dir } = await repository(t);
  await tracker(repo);
  const engine = new Orchestrator({
    repo,
    dataDir: join(dir, "data"),
    models: available,
    workspaces,
    publisher,
  });
  const p = plan("HEAD");
  p.jobs[0].dependencies = ["missing"];
  await assert.rejects(engine.prepare(p), /prerequisite/i);
  p.jobs[0].dependencies = ["one"];
  await assert.rejects(engine.prepare(p), /cycle/i);
  p.jobs[0].dependencies = [];
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
    dependencies: ["one"],
  });
  await assert.rejects(engine.prepare(p), /stacked|prBaseJob/i);
  p.jobs[1].prBaseJob = "one";
  await engine.prepare(p);
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  await assert.rejects(
    engine.prepare(p),
    /PR.only.*integration|integration.*PR.only/i,
  );
});

async function harness(
  t: Parameters<typeof repository>[0],
  mutate?: (
    input: Parameters<Workers["run"]>[0],
    signal: AbortSignal,
  ) => Promise<string>,
) {
  const { repo, dir } = await repository(t);
  await tracker(repo);
  const spaces: Workspaces = {
    async preflight() {},
    async create(input) {
      git(repo, "worktree", "add", "-b", input.branch, input.path, input.base);
      return {
        path: input.path,
        branch: input.branch,
        workspaceId: `space-${input.branch}`,
      };
    },
    async reconcile(w) {
      return w;
    },
    async open() {},
    async status() {},
  };
  let workerCount = 0;
  const workers: Workers = {
    async run(input, signal): Promise<WorkerResult> {
      const id = `worker-${++workerCount}`;
      input.onStart(id, `${id}.jsonl`);
      let text: string;
      if (mutate) text = await mutate(input, signal);
      else if (input.role === "review")
        text = JSON.stringify({ verdict: "pass", findings: [] });
      else {
        await writeFile(join(input.cwd, "one.txt"), "implemented\n");
        git(input.cwd, "add", ".");
        git(input.cwd, "commit", "-m", "implement one");
        text = "Implemented";
      }
      return {
        id,
        session: `${id}.jsonl`,
        model: input.model,
        status: "done",
        text,
      };
    },
  };
  const publications = new Map<
    string,
    { url: string; number: number; sha: string }
  >();
  const host: Publisher = {
    async preflight() {},
    async publish(input) {
      const existing = publications.get(input.branch);
      if (!existing && !input.allowCreate)
        throw new Error(
          "Ambiguous publication: no PR observed; reconciliation required",
        );
      const p = existing
        ? { ...existing, sha: input.sha }
        : {
            url: `https://github.com/test/repo/pull/${publications.size + 1}`,
            number: publications.size + 1,
            sha: input.sha,
          };
      publications.set(input.branch, p);
      return p;
    },
    async ci(_dest, sha) {
      return { sha, state: "passed", checks: [] };
    },
    async pushIntegration() {},
  };
  const options = {
    repo,
    dataDir: join(dir, "data"),
    workspaces: spaces,
    publisher: host,
    workers,
    models: available,
  };
  const engine = new Orchestrator(options);
  return { engine, options, repo, dir, publications };
}

test("one approved issue becomes a retained draft PR with independently recorded exact-SHA checks and review", async (t) => {
  const { engine, publications, repo } = await harness(t);
  const proposed = await engine.prepare(plan("HEAD"));
  await engine.approve(proposed.digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!,
    job = run.jobs.one;
  assert.equal(job.state, "complete");
  assert.equal(job.verification?.sha, job.publication?.sha);
  assert.equal(job.verification?.checks[0].code, 0);
  assert.equal(job.verification?.checks[0].sha, job.source);
  assert.equal(job.verification?.review.worker.id, "worker-2");
  assert.equal(job.cleanup, "retained");
  assert.equal(publications.size, 1);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  await engine.close();
});

test("check and review feedback share at most two repair cycles", async (t) => {
  let implementation = 0;
  const { engine, publications } = await harness(t, async (input) => {
    if (input.role === "review")
      return JSON.stringify({
        verdict: "repair",
        findings: ["Missing acceptance behavior"],
      });
    implementation++;
    await writeFile(join(input.cwd, "one.txt"), `attempt ${implementation}\n`);
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "attempt");
    return "done";
  });
  const p = plan("HEAD");
  p.checks = [
    {
      name: "first fails",
      command: "! grep -q 'attempt 1' one.txt",
      timeoutMs: 1000,
    },
  ];
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const job = engine.inspect()!.jobs.one;
  assert.equal(job.state, "blocked");
  assert.equal(job.repairs, 2);
  assert.equal(job.attempts, 3);
  assert.match(job.blocker!, /repair.*exhausted/i);
  assert.equal(publications.size, 0);
  await engine.close();
});

test("resume reconciles retained checkouts and invalidates verification on unapproved edits", async (t) => {
  const { engine, options } = await harness(t);
  await engine.approve((await engine.prepare(plan("HEAD"))).digest);
  await engine.start();
  await engine.settled();
  const prior = engine.inspect()!;
  await engine.close();
  const job = prior.jobs.one;
  await writeFile(join(job.workspace!.path, "one.txt"), "manual change\n");
  const recovered = new Orchestrator(options);
  await recovered.resume({ runId: prior.id });
  assert.equal(recovered.inspect()!.jobs.one.state, "blocked");
  assert.equal(recovered.inspect()!.jobs.one.verification, undefined);
  assert.match(recovered.inspect()!.jobs.one.blocker!, /dirty|diverg/i);
  assert.equal(recovered.inspect()!.jobs.one.publication?.sha, job.source);
  await recovered.close();
});

test("a second owner cannot acquire the same repository", async (t) => {
  const { engine, options } = await harness(t);
  const first = await engine.approve(
    (await engine.prepare(plan("HEAD"))).digest,
  );
  const other = new Orchestrator(options);
  await assert.rejects(other.resume({ runId: first.id }), /owner/i);
  await engine.close();
});

test("cancelling an owned check preserves its checkout and blocks dependents without publishing", async (t) => {
  const { engine, options, publications } = await harness(t);
  const p = plan("HEAD");
  p.checks = [{ name: "long", command: "sleep 30", timeoutMs: 60_000 }];
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
    dependencies: ["one"],
    prBaseJob: "one",
  });
  let checking!: () => void;
  const reached = new Promise<void>((resolve) => {
    checking = resolve;
  });
  Object.assign(options, {
    changed(run: import("./src/domain.ts").Run) {
      if (run.jobs.one.intent?.kind === "checking") checking();
    },
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await reached;
  await engine.cancel("one");
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(run.jobs.one.state, "cancelled");
  assert.equal(run.jobs.two.state, "blocked");
  assert.equal(run.jobs.one.cleanup, "retained");
  assert.equal(run.jobs.one.executors[0].session, "worker-1.jsonl");
  assert.equal(publications.size, 0);
  await engine.close();
});

test("dependent jobs use verified prerequisite commits and explicit stacked PR bases", async (t) => {
  const { engine } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    const file = input.cwd.endsWith("/two") ? "two.txt" : "one.txt";
    await writeFile(join(input.cwd, file), "done\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", file);
    return "done";
  });
  const p = plan("HEAD");
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
    dependencies: ["one"],
    prBaseJob: "one",
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(run.jobs.two.state, "complete");
  assert.equal(run.jobs.two.dependencies.one, run.jobs.one.verification!.sha);
  assert.equal(run.jobs.two.verification!.base, run.jobs.one.verification!.sha);
  await engine.close();
});

test("recovery cannot accept an interrupted composition that omits a verified prerequisite", async (t) => {
  const { engine, options } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    const name = input.cwd.endsWith("/three")
      ? "three"
      : input.cwd.endsWith("/two")
        ? "two"
        : "one";
    await writeFile(
      join(input.cwd, name === "three" ? "three.txt" : "initial.txt"),
      `${name} requirement\n`,
    );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", `implement ${name}`);
    return "done";
  });
  t.after(() => engine.close());
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.concurrency = 1;
  p.setup = [{ name: "setup", command: "true", timeoutMs: 1000 }];
  p.checks[0].command = "test -f initial.txt";
  p.jobs.push(
    {
      ...structuredClone(p.jobs[0]),
      id: "two",
      branch: "orchestrator/test/two",
    },
    {
      ...structuredClone(p.jobs[0]),
      id: "three",
      branch: "orchestrator/test/three",
      dependencies: ["one", "two"],
    },
  );
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const stopped = engine.inspect()!;
  assert.equal(stopped.jobs.three.intent?.kind, "compose-prerequisites");
  const cwd = stopped.jobs.three.workspace!.path;
  // The user aborts the unresolved second merge; the first merge is retained.
  git(cwd, "merge", "--abort");
  const incomplete = git(cwd, "rev-parse", "HEAD");
  assert.throws(() =>
    git(
      cwd,
      "merge-base",
      "--is-ancestor",
      stopped.jobs.two.source!,
      incomplete,
    ),
  );
  await engine.close();
  const recovered = new Orchestrator(options);
  t.after(() => recovered.close());
  await recovered.resume({
    runId: stopped.id,
    jobId: "three",
    acceptRevision: incomplete,
  });
  const job = recovered.inspect()!.jobs.three;
  assert.equal(job.state, "blocked");
  assert.match(
    job.blocker!,
    /prerequisite two.*(?:missing|ancestor)|missing.*prerequisite two/i,
  );
  assert.equal(job.verification, undefined);
  assert.equal(job.source, undefined);
  assert.equal(job.attempts, 0);

  // Resolve the missing parent manually; recovery must still run setup and implementation.
  assert.throws(() => git(cwd, "merge", "--no-ff", stopped.jobs.two.source!));
  await writeFile(join(cwd, "initial.txt"), "one and two requirements\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "resolve both prerequisite requirements");
  const composed = git(cwd, "rev-parse", "HEAD");
  await recovered.resume({ jobId: "three", acceptRevision: composed });
  const accepted = recovered.inspect()!.jobs.three;
  assert.equal(accepted.stage, "setup");
  assert.equal(accepted.base, composed);
  assert.equal(accepted.source, undefined);
  await recovered.start();
  await recovered.settled();
  const completed = recovered.inspect()!.jobs.three;
  assert.equal(
    completed.state,
    "complete",
    completed.blocker ?? "Recovery should finish composition",
  );
  assert.equal(completed.setupEvidence.length, 1);
  assert.equal(completed.attempts, 1);
  assert.equal(
    git(cwd, "show", `${completed.source}:three.txt`),
    "three requirement",
  );
  for (const parent of [stopped.jobs.one.source!, stopped.jobs.two.source!])
    git(cwd, "merge-base", "--is-ancestor", parent, completed.source!);
});

test("adopting an interrupted multi-parent workspace cannot skip prerequisite composition", async (t) => {
  const { engine, options } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    const name = input.cwd.split("/").at(-1)!;
    await writeFile(join(input.cwd, `${name}.txt`), `${name}\n`);
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", `implement ${name}`);
    return "done";
  });
  t.after(() => engine.close());
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.checks[0].command = "test -f initial.txt";
  p.jobs.push(
    {
      ...structuredClone(p.jobs[0]),
      id: "two",
      branch: "orchestrator/test/two",
    },
    {
      ...structuredClone(p.jobs[0]),
      id: "three",
      branch: "orchestrator/test/three",
      dependencies: ["one", "two"],
    },
  );
  const create = options.workspaces.create;
  options.workspaces.create = async (input) => {
    const workspace = await create(input);
    if (input.branch.endsWith("/three"))
      throw new Error("Transport lost after native checkout creation");
    return workspace;
  };
  options.workspaces.recover = async (input) => ({
    path: input.path,
    branch: input.branch,
    workspaceId: "recovered",
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.jobs.three.intent?.kind, "workspace");
  await engine.resume({ jobId: "three", recoverWorkspace: true });
  await engine.start();
  await engine.settled();
  const job = engine.inspect()!.jobs.three;
  assert.equal(job.state, "blocked");
  assert.match(job.blocker!, /prerequisite.*missing|missing.*prerequisite/i);
  assert.equal(job.attempts, 0);
  assert.equal(job.verification, undefined);
});

test("integration combines verified sources in a separate single-writer checkout and checks every result", async (t) => {
  const { engine, repo } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    await writeFile(
      join(input.cwd, input.cwd.endsWith("/two") ? "two.txt" : "one.txt"),
      "done\n",
    );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "implement");
    return "done";
  });
  await writeFile(join(repo, ".gitignore"), ".setup-state\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ignore revision-specific setup resource");
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.setup = [
    {
      name: "prepare candidate resources",
      command: "git rev-parse HEAD > .setup-state",
      timeoutMs: 1000,
    },
  ];
  p.checks[0].command =
    'test -f initial.txt && case "$PWD" in */integration) read prepared < .setup-state; test "$prepared" = "$(git rev-parse HEAD)";; esac';
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(run.integration?.state, "complete");
  assert.notEqual(run.integration!.workspace!.path, repo);
  assert.equal(run.jobs.one.integration?.source, run.jobs.one.source);
  assert.equal(run.jobs.two.integration?.source, run.jobs.two.source);
  assert.equal(run.integration!.checks.length, 2);
  assert.equal(run.integration!.checks[1].sha, run.integration!.sha);
  assert.deepEqual(
    run.integration!.setupEvidence.map((evidence) => evidence.sha),
    run.integration!.checks.map((evidence) => evidence.sha),
  );
  assert.equal(git(repo, "rev-parse", "HEAD"), run.plan.base);
  await engine.close();
});

test("integration prepares its own checkout before checking the merged revision", async (t) => {
  const { engine, repo } = await harness(t);
  t.after(() => engine.close());
  await writeFile(join(repo, ".gitignore"), ".setup-state\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ignore setup resource");
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.setup = [
    {
      name: "prepare local resources",
      command: "mkdir -p .setup-state && touch .setup-state/ready",
      timeoutMs: 1000,
    },
  ];
  p.checks[0].command = "test -f one.txt && test -f .setup-state/ready";
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(
    run.integration!.state,
    "complete",
    run.integration!.blocker ??
      "Integration setup should prepare local resources",
  );
  assert.equal(run.jobs.one.repairs, 0);
  assert.equal(run.integration!.setupEvidence[0].code, 0);
  assert.equal(run.integration!.setupEvidence[0].sha, run.integration!.sha);
  assert.equal(run.integration!.checks[0].sha, run.integration!.sha);
});

test("interrupted integration setup requires retry approval and preserves completed steps", async (t) => {
  const { engine, options, repo, dir } = await harness(t);
  t.after(() => engine.close());
  await writeFile(join(repo, ".gitignore"), ".setup-state\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ignore setup resource");
  const ready = join(dir, "resource-ready");
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.setup = [
    {
      name: "one-time setup",
      command: "test ! -e .setup-state && touch .setup-state",
      timeoutMs: 1000,
    },
    {
      name: "resource",
      command: `case "$PWD" in */integration) test -e '${ready}' || sleep 30;; *) true;; esac`,
      timeoutMs: 60_000,
    },
  ];
  let atSetup!: () => void;
  const reached = new Promise<void>((resolve) => {
    atSetup = resolve;
  });
  Object.assign(options, {
    changed(run: import("./src/domain.ts").Run) {
      if (
        run.integration?.intent?.kind === "setup" &&
        run.integration.checkProcess?.name === "resource"
      )
        atSetup();
    },
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await reached;
  await engine.cancel();
  const stopped = engine.inspect()!;
  assert.equal(stopped.integration!.setupIndex, 1);
  const candidate = git(
    stopped.integration!.workspace!.path,
    "rev-parse",
    "HEAD",
  );
  await engine.close();
  const recovered = new Orchestrator(options);
  t.after(() => recovered.close());
  await recovered.resume({
    runId: stopped.id,
    acceptIntegrationRevision: candidate,
  });
  assert.equal(recovered.inspect()!.integration!.state, "blocked");
  assert.match(
    recovered.inspect()!.integration!.blocker!,
    /setup.*retrySetup/i,
  );
  await writeFile(ready, "ready\n");
  await recovered.resume({
    acceptIntegrationRevision: candidate,
    retrySetup: true,
  });
  await recovered.start();
  await recovered.settled();
  const integration = recovered.inspect()!.integration!;
  assert.equal(
    integration.state,
    "complete",
    integration.blocker ?? "Setup should resume",
  );
  assert.equal(integration.setupIndex, 2);
  assert.equal(integration.setupEvidence.length, 3);
  assert.equal(integration.setupEvidence[0].code, 0);
  assert.equal(integration.setupEvidence[1].cancelled, true);
  assert.equal(integration.setupEvidence[2].code, 0);
  assert.equal(integration.checks.length, 1);
  assert.equal(recovered.inspect()!.jobs.one.repairs, 0);
});

test("resuming setup on a repaired integration candidate does not repeat the repair", async (t) => {
  const { engine, options, repo, dir } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    await writeFile(
      join(input.cwd, input.role === "conflict" ? "ci-fix.txt" : "one.txt"),
      "done\n",
    );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "scoped change");
    return "done";
  });
  t.after(() => engine.close());
  await writeFile(join(repo, ".gitignore"), ".setup-state/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ignore candidate setup resources");
  const ready = join(dir, "resource-ready");
  const p = plan("HEAD");
  p.delivery = "integration";
  p.integration = { branch: "orchestrator/test/integration", publish: true };
  p.requiredCI = ["CI"];
  p.repairLimit = 1;
  p.setup = [
    {
      name: "one-time candidate setup",
      command:
        'mkdir -p .setup-state && sha=$(git rev-parse HEAD) && test ! -e ".setup-state/$sha" && touch ".setup-state/$sha"',
      timeoutMs: 1000,
    },
    {
      name: "resource",
      command: `if test -f ci-fix.txt && ! test -e '${ready}'; then sleep 30; fi`,
      timeoutMs: 60_000,
    },
  ];
  let observations = 0;
  options.publisher.ci = async (_destination, sha) => ({
    sha,
    state: ++observations === 1 ? "failed" : "passed",
    checks: [],
  });
  let atSetup!: () => void;
  const reached = new Promise<void>((resolve) => {
    atSetup = resolve;
  });
  Object.assign(options, {
    changed(run: import("./src/domain.ts").Run) {
      if (
        run.jobs.one.repairs === 1 &&
        run.integration?.intent?.kind === "setup" &&
        run.integration.checkProcess?.name === "resource"
      )
        atSetup();
    },
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await reached;
  await engine.cancel();
  const stopped = engine.inspect()!;
  assert.equal(stopped.integration!.setupIndex, 1);
  const candidate = git(
    stopped.integration!.workspace!.path,
    "rev-parse",
    "HEAD",
  );
  await engine.close();
  const recovered = new Orchestrator(options);
  t.after(() => recovered.close());
  await writeFile(ready, "ready\n");
  await recovered.resume({
    runId: stopped.id,
    acceptIntegrationRevision: candidate,
    retrySetup: true,
  });
  await recovered.start();
  await recovered.settled();
  const run = recovered.inspect()!;
  assert.equal(
    run.integration!.state,
    "complete",
    run.integration!.blocker ?? "Repaired setup should resume",
  );
  assert.equal(run.integration!.sha, candidate);
  assert.equal(run.jobs.one.repairs, 1);
  assert.equal(run.integration!.setupEvidence.length, 5);
  assert.equal(run.integration!.setupEvidence.at(-1)!.code, 0);
});

test("semantic integration failures use the same bounded repair budget without rewriting PR sources", async (t) => {
  const { engine } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    if (input.role === "conflict")
      await writeFile(join(input.cwd, "compatible.txt"), "fixed\n");
    else
      await writeFile(
        join(input.cwd, input.cwd.endsWith("/two") ? "two.txt" : "one.txt"),
        "done\n",
      );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "scoped change");
    return "done";
  });
  const p = plan("HEAD");
  p.delivery = "both";
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.checks[0].command =
    "if test -f one.txt && test -f two.txt; then test -f compatible.txt; fi";
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(
    run.integration!.state,
    "complete",
    run.integration!.blocker ?? "Integration should complete",
  );
  assert.equal(
    Object.values(run.jobs).reduce((n, j) => n + j.repairs, 0),
    1,
  );
  for (const job of Object.values(run.jobs))
    assert.equal(job.source, job.publication!.sha);
  await engine.close();
});

test("ambiguous publication is reconciled without duplicate PR creation after restart", async (t) => {
  const { engine, options, publications } = await harness(t);
  const publish = options.publisher.publish;
  let disconnect = true;
  options.publisher.publish = async (input, signal) => {
    const result = await publish(input, signal);
    if (disconnect) {
      disconnect = false;
      throw new Error("Transport lost after PR creation");
    }
    return result;
  };
  await engine.approve((await engine.prepare(plan("HEAD"))).digest);
  await engine.start();
  await engine.settled();
  const before = engine.inspect()!;
  assert.equal(before.jobs.one.state, "blocked");
  assert.equal(before.jobs.one.intent?.kind, "publication");
  await engine.close();
  const recovered = new Orchestrator(options);
  await recovered.resume({ runId: before.id });
  await recovered.start();
  await recovered.settled();
  assert.equal(recovered.inspect()!.jobs.one.state, "complete");
  assert.equal(recovered.inspect()!.jobs.one.publication!.number, 1);
  assert.equal(publications.size, 1);
  await recovered.close();
});

test("source edits during CI invalidate verification instead of completing a published job", async (t) => {
  const { engine, options } = await harness(t);
  options.publisher.ci = async (_destination, sha) => {
    await writeFile(
      join(engine.inspect()!.jobs.one.workspace!.path, "one.txt"),
      "unapproved\n",
    );
    return { sha, state: "passed", checks: [] };
  };
  await engine.approve((await engine.prepare(plan("HEAD"))).digest);
  await engine.start();
  await engine.settled();
  const job = engine.inspect()!.jobs.one;
  assert.equal(job.state, "blocked");
  assert.equal(job.verification, undefined);
  assert.ok(job.publication);
  assert.ok(job.invalidations.length);
  await engine.close();
});

test("integration recovery rechecks an explicitly reconciled retained merge after interruption", async (t) => {
  const { engine, options } = await harness(t);
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.checks[0].command =
    'case "$PWD" in */integration) sleep 30;; *) test -f one.txt;; esac';
  let atCheck!: () => void;
  const reached = new Promise<void>((r) => {
    atCheck = r;
  });
  Object.assign(options, {
    changed(run: import("./src/domain.ts").Run) {
      if (run.integration?.intent?.kind === "checking") atCheck();
    },
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await reached;
  await engine.cancel();
  const stopped = engine.inspect()!;
  assert.equal(stopped.integration!.state, "cancelled");
  const candidate = git(
    stopped.integration!.workspace!.path,
    "rev-parse",
    "HEAD",
  );
  await engine.close();
  const recovered = new Orchestrator(options);
  await recovered.resume({ runId: stopped.id });
  assert.equal(recovered.inspect()!.integration!.state, "blocked");
  await recovered.resume({ acceptIntegrationRevision: candidate });
  assert.equal(recovered.inspect()!.integration!.state, "queued");
  assert.equal(recovered.inspect()!.integration!.candidate, candidate);
  assert.equal(recovered.inspect()!.integration!.sha, stopped.plan.base);
  await recovered.close();
});

test("native GitHub delivery uses the approved PR branch base and reconciles changed verification evidence", async (t) => {
  const { engine, options, repo, dir } = await harness(t);
  const remote = join(dir, "remote.git");
  await mkdir(remote);
  git(remote, "init", "--bare");
  const p = plan("HEAD");
  git(repo, "remote", "add", "origin", p.destination!.url);
  const prs: Array<Record<string, unknown>> = [];
  options.publisher = new GithubPublisher(async (file, args, cwd) => {
    if (file === "git") {
      if (args.includes("push") || args.includes("ls-remote"))
        args = args.map((arg) => (arg === "origin" ? remote : arg));
      return git(cwd ?? repo, ...args);
    }
    if (args[0] === "repo")
      return JSON.stringify({
        nameWithOwner: "test/repo",
        url: "https://github.com/test/repo",
        viewerPermission: "WRITE",
        defaultBranchRef: { name: "main" },
      });
    const arg = (name: string) => args[args.indexOf(name) + 1];
    if (args[0] === "pr" && args[1] === "list")
      return JSON.stringify(
        prs.map((pr) => ({
          ...pr,
          headRefOid: git(remote, "rev-parse", String(pr.headRefName)),
        })),
      );
    if (args[0] === "pr" && args[1] === "create") {
      assert.equal(arg("--base"), "main");
      prs.push({
        url: "https://github.com/test/repo/pull/1",
        number: 1,
        body: arg("--body"),
        state: "OPEN",
        isDraft: true,
        isCrossRepository: false,
        baseRefName: arg("--base"),
        headRefName: arg("--head"),
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "test" },
      });
      return "created";
    }
    if (args[0] === "pr" && args[1] === "edit") {
      prs[0].body = arg("--body");
      return "updated";
    }
    throw new Error(`Unexpected host operation: ${args.join(" ")}`);
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  let job = engine.inspect()!.jobs.one;
  assert.equal(
    job.state,
    "complete",
    job.blocker ?? "Native publication should complete",
  );
  await writeFile(
    join(job.workspace!.path, "one.txt"),
    "approved manual repair\n",
  );
  git(job.workspace!.path, "add", ".");
  git(job.workspace!.path, "commit", "-m", "repair");
  const sha = git(job.workspace!.path, "rev-parse", "HEAD");
  await engine.resume({ jobId: "one", acceptRevision: sha });
  await engine.start();
  await engine.settled();
  job = engine.inspect()!.jobs.one;
  assert.equal(
    job.state,
    "complete",
    job.blocker ?? "Updated publication should complete",
  );
  assert.equal(job.publication!.sha, sha);
  assert.equal(prs.length, 1);
  await engine.close();
});

test("published jobs remain awaiting exact-revision CI until required checks pass", async (t) => {
  const { engine, options } = await harness(t);
  Object.assign(options, { ciPollMs: 1 });
  let observations = 0;
  options.publisher.ci = async (_destination, sha) => ({
    sha,
    state: ++observations === 1 ? "pending" : "passed",
    checks: [{ name: "CI", state: observations === 1 ? "pending" : "success" }],
  });
  const p = plan("HEAD");
  p.requiredCI = ["CI"];
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.jobs.one.state, "complete");
  assert.equal(
    engine.inspect()!.jobs.one.ci!.sha,
    engine.inspect()!.jobs.one.source,
  );
  assert.equal(observations, 2);
  await engine.close();
});

test("a changed prerequisite invalidates and recomposes downstream verification", async (t) => {
  const { engine } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    const file = input.cwd.endsWith("/two") ? "two.txt" : "one.txt";
    await writeFile(join(input.cwd, file), "done\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", file);
    return "done";
  });
  const p = plan("HEAD");
  p.jobs.push({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
    dependencies: ["one"],
    prBaseJob: "one",
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const cwd = engine.inspect()!.jobs.one.workspace!.path;
  await writeFile(join(cwd, "extra.txt"), "accepted prerequisite repair\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "prerequisite repair");
  const sha = git(cwd, "rev-parse", "HEAD");
  await engine.resume({ jobId: "one", acceptRevision: sha });
  assert.equal(engine.inspect()!.jobs.two.verification, undefined);
  await engine.start();
  await engine.settled();
  await engine.resume({ jobId: "two" });
  await engine.start();
  await engine.settled();
  const two = engine.inspect()!.jobs.two;
  assert.equal(
    two.state,
    "complete",
    two.blocker ?? "Dependent should reverify",
  );
  assert.equal(two.dependencies.one, sha);
  assert.equal(two.verification!.dependencies.one, sha);
  await engine.close();
});

test("published integration with unobservable CI remains resumable rather than falsely complete", async (t) => {
  const { engine, options } = await harness(t);
  const p = plan("HEAD");
  p.delivery = "integration";
  p.integration = { branch: "orchestrator/test/integration", publish: true };
  p.requiredCI = ["CI"];
  let observe = 0;
  options.publisher.ci = async (_destination, sha) => ({
    sha,
    state: ++observe === 1 ? "unobservable" : "passed",
    checks: [],
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.integration!.state, "blocked");
  assert.ok(engine.inspect()!.integration!.publication);
  await engine.resume();
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.integration!.state, "complete");
  await engine.close();
});

test("integration CI failures feed a bounded independently reviewed integration-only repair", async (t) => {
  const { engine, options } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    await writeFile(
      join(input.cwd, input.role === "conflict" ? "ci-fix.txt" : "one.txt"),
      "done\n",
    );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "fix");
    return "done";
  });
  const p = plan("HEAD");
  p.delivery = "integration";
  p.integration = { branch: "orchestrator/test/integration", publish: true };
  p.requiredCI = ["CI"];
  let observe = 0;
  options.publisher.ci = async (_destination, sha) => ({
    sha,
    state: ++observe === 1 ? "failed" : "passed",
    checks: [{ name: "CI", state: observe === 1 ? "failure" : "success" }],
  });
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.integration!.state, "complete");
  assert.equal(engine.inspect()!.jobs.one.repairs, 1);
  assert.notEqual(
    engine.inspect()!.jobs.one.source,
    engine.inspect()!.integration!.sha,
  );
  await engine.close();
});

test("approval planning refuses an existing user branch rather than adopting it", async (t) => {
  const { engine, repo } = await harness(t);
  git(repo, "branch", "orchestrator/test/one");
  await assert.rejects(engine.prepare(plan("HEAD")), /branch.*exist/i);
  assert.equal(engine.inspect(), undefined);
});

test("crash recovery reconciles an owned check before any new executor can start", async (t) => {
  const { engine, options, dir } = await harness(t);
  const p = plan("HEAD");
  p.checks[0].command = "sleep 2";
  p.checks[0].timeoutMs = 5000;
  const script = join(dir, "crashing-owner.mjs");
  await writeFile(
    script,
    `
    import { Orchestrator } from ${JSON.stringify(new URL("./src/orchestrator.ts", import.meta.url).href)};
    import { execFileSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    let sent=false;
    const engine=new Orchestrator({repo:${JSON.stringify(options.repo)}, dataDir:${JSON.stringify(options.dataDir)},
      models:{async validate(){}}, publisher:{async preflight(){}},
      workspaces:{async preflight(){}, async create(i){git(i.repo,'worktree','add','-b',i.branch,i.path,i.base);return {path:i.path,branch:i.branch,workspaceId:'test'};}},
      workers:{async run(i){i.onStart('child','child.jsonl');writeFileSync(join(i.cwd,'one.txt'),'done');git(i.cwd,'add','.');git(i.cwd,'commit','-m','done');return {id:'child',model:i.model,status:'done',text:'done'};}},
      changed(run){if(!sent&&run.jobs.one.intent?.kind==='checking'){sent=true;setTimeout(()=>process.send(engine.inspect()),100);}}
    });
    await engine.approve((await engine.prepare(${JSON.stringify(p)})).digest); await engine.start();
  `,
  );
  const child = fork(script, [], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const run = await new Promise<import("./src/domain.ts").Run>(
    (resolve, reject) => {
      child.once("message", (value) =>
        resolve(value as import("./src/domain.ts").Run),
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Child exited early: ${code}`)),
      );
    },
  );
  assert.ok(
    run.jobs.one.checkProcess,
    "Owned command identity must be durable before execution",
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  await engine.resume({ runId: run.id });
  const recovered = engine.inspect()!.jobs.one;
  assert.equal(recovered.checkProcess, undefined);
  assert.equal(
    recovered.state,
    "queued",
    recovered.blocker ?? "Reconciled check should allow explicit resume",
  );
  assert.ok(recovered.checks.some((c) => c.cancelled && c.code === null));
  await engine.close();
});

test("accepting a descendant of completed local integration invalidates completion and checks that exact candidate", async (t) => {
  const { engine } = await harness(t);
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const cwd = engine.inspect()!.integration!.workspace!.path;
  await writeFile(join(cwd, "manual.txt"), "approved scoped adjustment\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "adjustment");
  const sha = git(cwd, "rev-parse", "HEAD");
  await engine.resume({ acceptIntegrationRevision: sha });
  assert.equal(engine.inspect()!.integration!.state, "queued");
  await engine.start();
  await engine.settled();
  const integration = engine.inspect()!.integration!;
  assert.equal(integration.state, "complete");
  assert.equal(integration.sha, sha);
  assert.equal(integration.checks.at(-1)!.sha, sha);
  assert.ok(
    engine.inspect()!.jobs.one.executors.filter((w) => w.role === "review")
      .length >= 2,
  );
  await engine.close();
});

test("integration finishes the failing prerequisite's CI repair before selecting an earlier-listed dependent", async (t) => {
  const { engine, options } = await harness(t, async (input) => {
    if (input.role === "review") return '{"verdict":"pass","findings":[]}';
    await writeFile(
      join(
        input.cwd,
        input.role === "conflict"
          ? "ci-fix.txt"
          : input.cwd.endsWith("/two")
            ? "two.txt"
            : "one.txt",
      ),
      "done\n",
    );
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "scoped change");
    return "done";
  });
  const p = plan("HEAD");
  p.delivery = "integration";
  p.integration = { branch: "orchestrator/test/integration", publish: true };
  p.requiredCI = ["CI"];
  p.jobs.unshift({
    ...structuredClone(p.jobs[0]),
    id: "two",
    branch: "orchestrator/test/two",
    dependencies: ["one"],
  });
  let dependentDone!: () => void;
  const done = new Promise<void>((r) => {
    dependentDone = r;
  });
  Object.assign(options, {
    changed(run: import("./src/domain.ts").Run) {
      if (run.jobs.two.state === "complete") dependentDone();
    },
  });
  let observations = 0;
  options.publisher.ci = async (_destination, sha) => {
    await done;
    return {
      sha,
      state: ++observations === 1 ? "failed" : "passed",
      checks: [],
    };
  };
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(run.integration!.state, "complete");
  assert.equal(run.jobs.one.repairs, 1);
  assert.equal(run.jobs.two.repairs, 0);
  await engine.close();
});

test("malformed integration review is a missing-evidence blocker, not another repair cycle", async (t) => {
  const { engine } = await harness(t, async (input) => {
    if (input.role === "review")
      return input.cwd.endsWith("/integration")
        ? '{"verdict":"repair","findings":"not structured findings"}'
        : '{"verdict":"pass","findings":[]}';
    const file = input.role === "conflict" ? "fixed.txt" : "one.txt";
    await writeFile(join(input.cwd, file), `${Date.now()}\n`);
    git(input.cwd, "add", ".");
    git(input.cwd, "commit", "-m", "fix");
    return "done";
  });
  const p = plan("HEAD");
  p.delivery = "integration";
  delete p.destination;
  p.integration = { branch: "orchestrator/test/integration", publish: false };
  p.checks[0].command =
    'case "$PWD" in */integration) test -f fixed.txt;; *) test -f one.txt;; esac';
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const run = engine.inspect()!;
  assert.equal(run.integration!.state, "blocked");
  assert.equal(run.jobs.one.repairs, 1);
  assert.match(run.integration!.blocker!, /malformed|evidence/i);
  await engine.close();
});

test("setup that commits tracked source changes blocks before advancing or starting a worker", async (t) => {
  const { engine, publications } = await harness(t);
  t.after(() => engine.close());
  const p = plan("HEAD");
  p.setup = [
    {
      name: "source-changing setup",
      command:
        "printf 'changed by setup\\n' > initial.txt && git add initial.txt && git commit -m 'setup changed source'",
      timeoutMs: 1000,
    },
    { name: "must not run", command: "exit 1", timeoutMs: 1000 },
  ];
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  const job = engine.inspect()!.jobs.one;
  assert.equal(job.state, "blocked");
  assert.match(job.blocker!, /setup.*(?:source|revision)/i);
  assert.equal(job.setupIndex, 0);
  assert.equal(job.setupEvidence.length, 1);
  assert.equal(job.attempts, 0);
  assert.equal(publications.size, 0);
  assert.notEqual(git(job.workspace!.path, "rev-parse", "HEAD"), job.base);
  assert.equal(git(job.workspace!.path, "status", "--porcelain"), "");
});

test("resuming a failed setup preserves completed setup steps rather than replaying them", async (t) => {
  const { engine, repo, dir } = await harness(t);
  await writeFile(join(repo, ".gitignore"), ".setup-state\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ignore setup resource");
  const ready = join(dir, "resource-ready");
  const p = plan("HEAD");
  p.setup = [
    {
      name: "one-time setup",
      command: "test ! -e .setup-state && touch .setup-state",
      timeoutMs: 1000,
    },
    { name: "resource", command: `test -e '${ready}'`, timeoutMs: 1000 },
  ];
  await engine.approve((await engine.prepare(p)).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.jobs.one.state, "blocked");
  await writeFile(ready, "ready");
  await engine.resume();
  await engine.start();
  await engine.settled();
  const job = engine.inspect()!.jobs.one;
  assert.equal(job.state, "complete", job.blocker ?? "Setup should resume");
  assert.deepEqual(
    job.setupEvidence.map((e) => e.code),
    [0, 1, 0],
  );
  await engine.close();
});

test("ambiguous workspace creation can explicitly adopt the retained checkout without creating it again", async (t) => {
  const { engine, options } = await harness(t);
  const create = options.workspaces.create;
  let creations = 0;
  options.workspaces.create = async (input) => {
    creations++;
    await create(input);
    throw new Error("Connection lost after workspace creation");
  };
  options.workspaces.recover = async (input) => ({
    path: input.path,
    branch: input.branch,
    workspaceId: "recovered",
  });
  await engine.approve((await engine.prepare(plan("HEAD"))).digest);
  await engine.start();
  await engine.settled();
  assert.equal(engine.inspect()!.jobs.one.state, "blocked");
  await engine.resume({ recoverWorkspace: true });
  await engine.start();
  await engine.settled();
  assert.equal(
    engine.inspect()!.jobs.one.state,
    "complete",
    engine.inspect()!.jobs.one.blocker ?? "Retained workspace should recover",
  );
  assert.equal(creations, 1);
  await engine.close();
});

test("a missing tracker convention blocks planning with setup guidance", async (t) => {
  const { repo, dir } = await repository(t);
  const orchestrator = new Orchestrator({ repo, dataDir: join(dir, "data") });
  await assert.rejects(
    orchestrator.prepare({}),
    /\/setup.*issue-tracker|issue-tracker.*\/setup/s,
  );
});
