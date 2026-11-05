import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckEvidence, Job, Plan, Run } from "./src/domain.ts";
import {
  formatPlan,
  formatProgress,
  formatRun,
  milestoneKey,
  widgetLines,
} from "./src/presentation.ts";

function fixture(): Run {
  const model = { model: "provider/model", thinking: "high" as const };
  const plan: Plan = {
    base: "a".repeat(40),
    delivery: "both",
    destination: {
      remote: "origin",
      url: "https://example.test/repo.git",
      repository: "owner/repo",
      prBase: "main",
    },
    integration: { branch: "orchestrator/integration", publish: true },
    jobs: [
      {
        id: "one",
        branch: "orchestrator/one",
        dependencies: [],
        issues: [
          {
            id: "ISSUE-1",
            source: "https://example.test/1",
            title: "Fix the bug",
            material: "Original requirements",
            acceptance: ["Works offline"],
            retrievedAt: "2026-01-01",
          },
        ],
      },
    ],
    setup: [
      { name: "install", command: "npm ci --ignore-scripts", timeoutMs: 12000 },
    ],
    checks: [
      { name: "test", command: "npm test && echo 'checked'", timeoutMs: 3456 },
    ],
    requiredCI: ["linux"],
    concurrency: 2,
    repairLimit: 2,
    permissions: ["commit locally", "publish owned branches"],
    baselineExceptions: ["known old lint warning"],
    cleanup: "retain",
    models: {
      implementation: model,
      review: { model: "provider/reviewer", thinking: "max" },
      conflict: model,
    },
  };
  const job: Job = {
    id: "one",
    state: "queued",
    stage: "workspace",
    repairs: 0,
    attempts: 0,
    setupIndex: 0,
    setupEvidence: [],
    dependencies: {},
    executors: [],
    checks: [],
    invalidations: [],
    artifacts: [],
    cleanup: "retained",
  };
  return {
    version: 1,
    id: "run-1",
    repo: "/repo",
    identity: "identity",
    approval: "digest",
    approvedAt: "today",
    plan,
    paused: true,
    cancelled: false,
    jobs: { one: job },
    artifacts: [],
    history: [],
    integration: {
      sha: plan.base,
      startingSha: plan.base,
      state: "queued",
      setupIndex: 0,
      setupEvidence: [],
      checks: [],
      artifacts: [],
    },
  };
}
function evidence(overrides: Partial<CheckEvidence> = {}): CheckEvidence {
  return {
    name: "test",
    command: "npm test && echo 'checked'",
    sha: "b".repeat(40),
    code: 0,
    cancelled: false,
    timedOut: false,
    artifact: "/logs/test.log",
    ...overrides,
  };
}

test("empty run and compact overview are readable and do not claim pending integration is done", () => {
  assert.equal(formatRun(undefined), "No orchestrator run.");
  const run = fixture();
  run.jobs.one.state = "complete";
  run.jobs.one.stage = "verified";
  const output = formatRun(run);
  assert.match(output, /1\/1 complete/);
  assert.match(output, /Delivery: both; pending; integration queued/);
  assert.match(output, /Integration: queued/);
  run.integration!.state = "blocked";
  run.integration!.blocker = "conflict needs a decision";
  assert.match(formatRun(run), /blocker: conflict needs a decision/);
  assert.doesNotMatch(formatRun(run), /Delivery: both; complete/);
  run.integration!.state = "complete";
  assert.match(formatRun(run), /Delivery: both; complete/);
});

test("check outcomes distinguish missing, failed, cancelled, timed out and stale evidence", () => {
  const run = fixture();
  const job = run.jobs.one;
  job.stage = "checking";
  job.source = "b".repeat(40);
  assert.match(formatRun(run), /checks: 1 missing/);
  for (const [change, expected] of [
    [{ code: 0 }, "1 passed"],
    [{ code: 4 }, "1 failed (exit 4)"],
    [{ code: null }, "1 missing result"],
    [{ code: 0, cancelled: true }, "1 cancelled"],
    [{ code: 0, timedOut: true }, "1 timed out"],
    [{ sha: "old" }, "1 stale (passed)"],
  ] as const) {
    job.checks = [evidence(change)];
    assert.ok(formatRun(run).includes(`checks: ${expected}`));
  }
  job.checks = [evidence({ command: "different command" })];
  assert.match(formatRun(run), /checks: 1 missing/);
});

test("same-SHA evidence is stale during implementation, including CI and review", () => {
  const run = fixture();
  const job = run.jobs.one;
  job.stage = "implementation";
  job.state = "running";
  job.source = evidence().sha;
  job.checks = [evidence()];
  job.ci = { sha: job.source, state: "passed", checks: [] };
  job.verification = {
    sha: job.source,
    tree: "tree",
    base: run.plan.base,
    dependencies: {},
    checks: job.checks,
    review: {
      artifact: "/review.json",
      worker: {
        id: "worker",
        model: run.plan.models.review,
        status: "done",
        text: '{"verdict":"pass","findings":[]}',
      },
    },
    time: "yesterday",
  };
  job.feedback = "Repair the regression";
  for (const output of [formatRun(run), formatProgress(run)]) {
    assert.match(output, /checks: 1 stale \(passed\)/);
    assert.match(output, /review: stale/);
    assert.match(output, /CI: passed \(stale\)/);
    assert.match(output, /repair feedback: Repair the regression/);
  }
});

test("integration repair never treats accepted-source checks as current", () => {
  const run = fixture();
  run.integration!.sha = evidence().sha;
  run.integration!.checks = [evidence()];
  run.integration!.intent = {
    kind: "repair",
    time: "now",
    sha: evidence().sha,
  };
  run.integration!.feedback = "Integration CI failed";
  assert.match(
    formatRun(run),
    /Integration: queued \/ repair\n  checks: 1 stale \(passed\)/,
  );
  assert.match(formatRun(run), /repair feedback: Integration CI failed/);
  run.integration!.intent = undefined;
  run.integration!.feedback = undefined;
  run.integration!.candidate = "new-candidate";
  assert.match(formatRun(run), /checks: 1 stale \(passed\)/);
});

test("expanded inspection exposes full retained paths, SHAs, commands, workers and artifacts", () => {
  const run = fixture();
  const job = run.jobs.one;
  job.source = evidence().sha;
  job.base = run.plan.base;
  job.workspace = {
    path: "/retained/worktree",
    branch: "orchestrator/one",
    workspaceId: "space-1",
    session: "session-1",
  };
  job.checks = [evidence({ timedOut: true })];
  job.artifacts = ["/artifacts/implementation.json"];
  job.executors.push({
    id: "worker-1",
    session: "/sessions/worker.jsonl",
    role: "implementation",
    model: run.plan.models.implementation,
  });
  run.artifacts = ["/artifacts/tracker.md"];
  const output = formatRun(run, true);
  for (const value of [
    job.source,
    job.base,
    job.workspace.path,
    job.workspace.session!,
    job.checks[0].command,
    job.checks[0].artifact,
    job.artifacts[0],
    "/sessions/worker.jsonl",
    run.artifacts[0],
  ])
    assert.ok(output.includes(value), value);
  assert.doesNotMatch(formatRun(run), /\/retained\/worktree/);
});

test("individual inspection excludes unrelated evidence and history", () => {
  const run = fixture();
  run.jobs.two = {
    ...structuredClone(run.jobs.one),
    id: "two",
    artifacts: ["/requested/evidence"],
  };
  run.jobs.one.artifacts = ["UNRELATED".repeat(10000)];
  run.history = ["OLD-HISTORY".repeat(10000)];
  const output = formatRun(run, true, "two");
  assert.match(output, /\/requested\/evidence/);
  assert.doesNotMatch(output, /UNRELATED|OLD-HISTORY|Integration:/);
  assert.ok(output.length < 24000);
  assert.match(formatRun(run, true, "absent"), /Unknown orchestrator job/);
});

test("approval summary includes the complete safety-relevant plan without truncation", () => {
  const run = fixture();
  const plan = run.plan;
  plan.jobs.push({
    ...structuredClone(plan.jobs[0]),
    id: "two",
    branch: "orchestrator/two",
    dependencies: ["one"],
    prBaseJob: "one",
  });
  plan.jobs[0].issues[0].material =
    "requirements ".repeat(1000) + "END-MATERIAL";
  const output = formatPlan(plan, "exact-digest");
  assert.doesNotMatch(output, /END-MATERIAL/);
  assert.match(output, /Full issue source material remains in the plan file/);
  assert.match(output, /\/orchestrator approve exact-digest/);
  for (const value of [
    "exact-digest",
    plan.base,
    "both",
    "origin",
    plan.destination!.url,
    "owner/repo",
    "main",
    "orchestrator/integration",
    "publish: true",
    "Concurrency: 2",
    "repair limit per job: 2",
    "retain",
    "provider/model",
    "provider/reviewer",
    "high",
    "max",
    ...plan.permissions,
    ...plan.baselineExceptions,
    "npm ci --ignore-scripts",
    "12000 ms",
    plan.checks[0].command,
    "3456 ms",
    "linux",
    "orchestrator/two",
    "PR base: job one",
    "Dependencies:",
    "ISSUE-1",
    "https://example.test/1",
    "Fix the bug",
    "Works offline",
    "2026-01-01",
    "missing evidence is not passing",
    "no automatic merge",
  ])
    assert.ok(output.includes(value), value);
});

test("compact large batches prioritize blockers, bound feedback, and disclose hidden blockers", () => {
  const run = fixture();
  const template = structuredClone(run.jobs.one);
  run.jobs = {};
  run.plan.jobs = Array.from({ length: 32 }, (_, i) => ({
    ...structuredClone(run.plan.jobs[0]),
    id: `job-${i}`,
  }));
  for (const spec of run.plan.jobs)
    run.jobs[spec.id] = {
      ...structuredClone(template),
      id: spec.id,
      state: "complete",
    };
  for (let i = 20; i < 32; i++) {
    const job = run.jobs[`job-${i}`];
    job.state = "blocked";
    job.blocker = `BLOCKER-${i} ` + "x".repeat(10000);
    job.feedback = "FEEDBACK " + "y".repeat(10000);
  }
  const compact = formatRun(run);
  assert.ok(compact.length < 8000);
  assert.match(compact, /blocker: BLOCKER-/);
  assert.match(compact, /repair feedback: FEEDBACK/);
  assert.match(compact, /26 more jobs \(6 blocked/);
  const widget = widgetLines(run);
  assert.equal(widget.length, 5);
  assert.ok(widget.join("\n").length < 1000);
  assert.match(widget[1], /BLOCKER-/);
  assert.match(widget[0], /12 blocked/);
  assert.equal(widgetLines(fixture()).length, 4);
});

test("external control characters cannot inject terminal lines, ANSI or bidi controls", () => {
  const run = fixture();
  const hostile = "hello\x1b[2J\r\n\t\x00\x9b\u202eINJECT";
  run.id = hostile;
  run.jobs.one.blocker = hostile;
  run.jobs.one.feedback = hostile;
  run.jobs.one.artifacts = [hostile];
  run.plan.checks[0].command = hostile;
  run.plan.permissions = [hostile];
  run.integration!.blocker = hostile;
  const forbidden = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e]/;
  for (const output of [
    formatPlan(run.plan, hostile),
    formatRun(run),
    formatRun(run, true),
    formatProgress(run),
    widgetLines(run).join("\n"),
  ]) {
    assert.doesNotMatch(output, forbidden);
    assert.ok(output.includes("\\u001b"));
  }
});

test("milestones ignore individual passing checks, artifact writes and CI polling details", () => {
  const run = fixture();
  run.jobs.one.stage = "checking";
  run.jobs.one.ci = {
    sha: "source",
    state: "pending",
    checks: [{ name: "a", state: "queued" }],
  };
  const before = milestoneKey(run);
  run.jobs.one.checks.push(evidence());
  run.jobs.one.artifacts.push("new-log");
  run.jobs.one.intent = { kind: "checking", time: "later", sha: "source" };
  run.jobs.one.ci.checks[0].state = "running";
  assert.equal(milestoneKey(run), before);
  run.integration!.intent = { kind: "checking", time: "first", sha: "source" };
  const integrationBefore = milestoneKey(run);
  run.integration!.checks.push(evidence());
  run.integration!.intent.time = "second";
  assert.equal(milestoneKey(run), integrationBefore);
});

test("milestones reflect controls, repairs, feedback, blockers, CI and integration changes", () => {
  const changes: Array<(run: Run) => void> = [
    (run) => {
      run.cancelled = true;
    },
    (run) => {
      run.paused = false;
    },
    (run) => {
      run.jobs.one.repairs++;
    },
    (run) => {
      run.jobs.one.feedback = "repair this";
    },
    (run) => {
      run.jobs.one.blocker = "needs input";
    },
    (run) => {
      run.jobs.one.state = "cancelled";
    },
    (run) => {
      run.jobs.one.stage = "implementation";
    },
    (run) => {
      run.jobs.one.ci = { sha: "sha", state: "failed", checks: [] };
    },
    (run) => {
      run.jobs.one.integration = { source: "source", sha: "merged" };
    },
    (run) => {
      run.integration!.feedback = "CI repair";
    },
    (run) => {
      run.integration!.blocker = "merge conflict";
    },
    (run) => {
      run.integration!.state = "complete";
    },
    (run) => {
      run.integration!.intent = { kind: "repair", time: "now" };
    },
  ];
  for (const change of changes) {
    const run = fixture();
    const before = milestoneKey(run);
    change(run);
    assert.notEqual(milestoneKey(run), before);
  }
});

test("progress emits only changed entities, initially all, and nothing for a clone", () => {
  const previous = fixture();
  previous.jobs.two = { ...structuredClone(previous.jobs.one), id: "two" };
  assert.match(formatProgress(previous), /one ·/);
  assert.match(formatProgress(previous), /two ·/);
  assert.match(formatProgress(previous), /Integration:/);
  assert.equal(formatProgress(structuredClone(previous), previous), "");
  const run = structuredClone(previous);
  run.jobs.two.feedback = "fix two";
  let output = formatProgress(run, previous);
  assert.match(output, /two ·[\s\S]*fix two/);
  assert.doesNotMatch(output, /one ·|Integration:|Run |Delivery:/);
  const next = structuredClone(run);
  next.integration!.blocker = "integration blocked";
  output = formatProgress(next, run);
  assert.match(output, /Integration:[\s\S]*integration blocked/);
  assert.doesNotMatch(output, /one ·|two ·/);
  const cancelled = structuredClone(next);
  cancelled.cancelled = true;
  output = formatProgress(cancelled, next);
  assert.match(output, /Orchestrator · cancelled/);
  assert.doesNotMatch(output, /one ·|two ·|Integration:/);
});
