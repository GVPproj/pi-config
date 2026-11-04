import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "./src/orchestrator.ts";
import type { Plan, Workers } from "./src/domain.ts";
import { HerdrWorkspaces, type Workspaces } from "./src/herdr.ts";
import { GithubPublisher } from "./src/github.ts";

// Fixture commands never inherit the hostile environment under test.
const fixtureEnv = { ...process.env };
for (const key of Object.keys(fixtureEnv))
  if (key.startsWith("GIT_")) delete fixtureEnv[key];
fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
fixtureEnv.GIT_CONFIG_GLOBAL = "/dev/null";
fixtureEnv.GIT_NO_REPLACE_OBJECTS = "1";
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: fixtureEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function repository(root: string, name: string) {
  const repo = join(root, name);
  await mkdir(join(repo, "docs/agents"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Identity test");
  git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "payload.txt"), `${name}\n`);
  await writeFile(
    join(repo, "docs/agents/issue-tracker.md"),
    "Local issues.\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", name);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-m", "second");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}
function inherit(env: NodeJS.ProcessEnv) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  return () => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}
function plan(base = "HEAD"): Plan {
  const model = { model: "test/model", thinking: "off" as const };
  return {
    base,
    delivery: "integration",
    integration: {
      branch: "orchestrator/identity/integration",
      publish: false,
    },
    jobs: [
      {
        id: "one",
        branch: "orchestrator/identity/one",
        dependencies: [],
        issues: [
          {
            id: "ONE",
            source: "local:test",
            title: "Add one",
            material: "Add one.txt",
            acceptance: ["one.txt exists"],
            retrievedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ],
    setup: [],
    checks: [
      { name: "payload", command: "test -f payload.txt", timeoutMs: 1000 },
    ],
    requiredCI: [],
    concurrency: 1,
    repairLimit: 0,
    permissions: ["create commits"],
    baselineExceptions: [],
    cleanup: "retain",
    models: { implementation: model, review: model, conflict: model },
  };
}
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected workspace operation");
};
const noWorkspaces: Workspaces = {
  async preflight() {},
  create: unexpected,
  reconcile: unexpected,
  open: unexpected,
  status: unexpected,
};

async function executable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test("prepare and approval retain the selected repository and true base despite inherited Git routing and replace refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-git-identity-"));
  let restore = () => {};
  const engine = new Orchestrator({
    repo: join(root, "selected"),
    dataDir: join(root, "data"),
    models: { async validate() {} },
    workspaces: noWorkspaces,
  });
  try {
    const selected = await repository(root, "selected");
    const unrelated = await repository(root, "unrelated");
    git(selected.repo, "replace", selected.head, selected.base);
    const index = await readFile(join(unrelated.repo, ".git/index"));
    restore = inherit({
      GIT_DIR: join(unrelated.repo, ".git"),
      GIT_WORK_TREE: unrelated.repo,
      GIT_INDEX_FILE: join(unrelated.repo, ".git/index"),
    });
    const proposal = await engine.prepare(plan("HEAD^"));
    assert.equal(proposal.plan.base, selected.base);
    const run = await engine.approve(proposal.digest);
    assert.equal(run.repo, selected.repo);
    assert.equal(run.identity, join(selected.repo, ".git"));
    assert.equal(git(unrelated.repo, "rev-parse", "HEAD"), unrelated.head);
    assert.equal(
      await readFile(join(unrelated.repo, "payload.txt"), "utf8"),
      "unrelated\n",
    );
    assert.deepEqual(await readFile(join(unrelated.repo, ".git/index")), index);
  } finally {
    await engine.close();
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare validates the selected GitHub destination without inherited routing/config overrides and preserves SSH authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-github-identity-"));
  let restore = () => {};
  const engine = new Orchestrator({
    repo: join(root, "selected"),
    dataDir: join(root, "data"),
    models: { async validate() {} },
    workspaces: noWorkspaces,
    publisher: new GithubPublisher(),
  });
  try {
    const selected = await repository(root, "selected");
    const unrelated = await repository(root, "unrelated");
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    const url = "git@github.com:test/repo.git";
    git(selected.repo, "remote", "add", "origin", url);
    git(
      unrelated.repo,
      "remote",
      "add",
      "origin",
      "https://github.com/other/repo.git",
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    // Only the external GitHub/SSH transports are controlled; local Git is real.
    await executable(
      join(bin, "gh"),
      `#!/bin/sh
[ "$1 $2" = "repo view" ] || exit 91
printf '%s' '{"nameWithOwner":"test/repo","url":"https://github.com/test/repo","viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}'
`,
    );
    await executable(
      join(bin, "ssh-local"),
      `#!/bin/sh
[ "$SSH_AUTH_SOCK" = "$EXPECTED_SOCKET" ] || exit 92
[ "$SSH_AGENT_PID" = "12345" ] || exit 93
[ "$GIT_SSH_VARIANT" = "ssh" ] || exit 94
exec git-upload-pack "$LOCAL_REMOTE"
`,
    );
    restore = inherit({
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: join(unrelated.repo, ".git"),
      GIT_WORK_TREE: unrelated.repo,
      GIT_INDEX_FILE: join(unrelated.repo, ".git/index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0: "https://github.com/other/repo.git",
      GIT_CONFIG_PARAMETERS:
        "'remote.origin.url=https://github.com/other/repo.git'",
      GIT_SSH_COMMAND: join(bin, "ssh-local"),
      GIT_SSH_VARIANT: "ssh",
      SSH_AUTH_SOCK: join(root, "agent.sock"),
      EXPECTED_SOCKET: join(root, "agent.sock"),
      SSH_AGENT_PID: "12345",
      LOCAL_REMOTE: remote,
    });
    const p = plan();
    p.delivery = "draft-pr";
    delete p.integration;
    p.destination = {
      remote: "origin",
      url,
      repository: "test/repo",
      prBase: "main",
    };
    const proposal = await engine.prepare(p);
    assert.equal(proposal.plan.base, selected.head);
    // Sanitizing the environment must not weaken repository-config URL checks.
    git(
      selected.repo,
      "config",
      "remote.origin.pushurl",
      "https://github.com/other/repo.git",
    );
    await assert.rejects(engine.prepare(p), /single approved URL/);
    assert.equal(git(unrelated.repo, "status", "--porcelain"), "");
  } finally {
    await engine.close();
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "approved jobs use the true source and isolated herdr checkouts without touching an inherited repository/index or running hooks",
  {
    skip: process.env.ORCHESTRATOR_HERDR_TEST !== "1",
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-herdr-git-"));
    const session = `orchestrator-git-${process.pid}-${Date.now()}`;
    const env = { ...fixtureEnv };
    // The real server predates the caller and does not inherit its Git policy.
    delete env.GIT_NO_REPLACE_OBJECTS;
    for (const key of Object.keys(env))
      if (key.startsWith("HERDR_")) delete env[key];
    env.HERDR_ENV = "1";
    const exec = promisify(execFile);
    const herdr = async (...args: string[]) =>
      (
        await exec("herdr", ["--session", session, ...args], {
          env,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    let restore = () => {};
    let server: ReturnType<typeof spawn> | undefined;
    let engine: Orchestrator | undefined;
    try {
      const selected = await repository(root, "selected");
      const unrelated = await repository(root, "unrelated");
      // Replace the approved commit with different contents and ancestry.
      git(selected.repo, "checkout", "-b", "replacement");
      await writeFile(
        join(selected.repo, "payload.txt"),
        "replacement contents\n",
      );
      git(selected.repo, "add", ".");
      git(selected.repo, "commit", "-m", "replacement");
      const replacement = git(selected.repo, "rev-parse", "HEAD");
      git(selected.repo, "checkout", "main");
      git(selected.repo, "replace", selected.head, replacement);
      const sentinel = join(root, "hooks-ran");
      await writeFile(sentinel, "untouched\n");
      for (const hook of ["post-checkout", "post-merge"])
        await executable(
          join(selected.repo, ".git/hooks", hook),
          `#!/bin/sh\necho hook >> '${sentinel}'\n`,
        );
      await writeFile(join(unrelated.repo, "untracked.txt"), "keep this\n");
      const unrelatedIndex = await readFile(join(unrelated.repo, ".git/index"));
      const unrelatedStatus = git(unrelated.repo, "status", "--porcelain");
      server = spawn("herdr", ["--session", session, "server"], {
        env,
        cwd: selected.repo,
        stdio: "ignore",
      });
      let spawnError: Error | undefined;
      server.on("error", (error) => {
        spawnError = error;
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (spawnError) throw spawnError;
        assert.equal(server.exitCode, null, "isolated herdr server exited");
        try {
          await herdr("workspace", "list");
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      restore = inherit({
        HERDR_ENV: "1",
        GIT_DIR: join(unrelated.repo, ".git"),
        GIT_WORK_TREE: unrelated.repo,
        GIT_INDEX_FILE: join(unrelated.repo, ".git/index"),
        GIT_COMMON_DIR: join(unrelated.repo, ".git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: join(selected.repo, ".git/hooks"),
      });
      let source: string | undefined;
      let tree: string | undefined;
      const workers: Workers = {
        async run(input) {
          const id = `${input.role}-worker`;
          input.onStart(id, `${id}.jsonl`);
          assert.equal(
            await readFile(join(input.cwd, "payload.txt"), "utf8"),
            "selected\n",
          );
          if (input.role === "implementation") {
            await writeFile(join(input.cwd, "one.txt"), "implemented\n");
            git(input.cwd, "add", ".");
            git(input.cwd, "commit", "-m", "implement one");
            source = git(input.cwd, "rev-parse", "HEAD");
            tree = git(input.cwd, "rev-parse", "HEAD^{tree}");
          }
          return {
            id,
            session: `${id}.jsonl`,
            model: input.model,
            status: "done",
            text:
              input.role === "implementation"
                ? "Implemented"
                : JSON.stringify({ verdict: "pass", findings: [] }),
          };
        },
      };
      engine = new Orchestrator({
        repo: selected.repo,
        dataDir: join(root, "data"),
        models: { async validate() {} },
        workspaces: new HerdrWorkspaces(session),
        workers,
      });
      const proposal = await engine.prepare(plan());
      assert.equal(proposal.plan.base, selected.head);
      await engine.approve(proposal.digest);
      await engine.start();
      await engine.settled();
      const run = engine.inspect()!;
      const job = run.jobs.one;
      assert.equal(job.state, "complete", job.blocker ?? "");
      assert.ok(source);
      assert.equal(job.verification?.sha, source);
      assert.equal(job.verification?.tree, tree);
      assert.equal(job.verification?.base, selected.head);
      assert.equal(
        run.integration?.state,
        "complete",
        run.integration?.blocker ?? "",
      );
      assert.equal(
        await readFile(join(job.workspace!.path, "payload.txt"), "utf8"),
        "selected\n",
      );
      assert.equal(
        await readFile(
          join(run.integration!.workspace!.path, "one.txt"),
          "utf8",
        ),
        "implemented\n",
      );
      // Public reconciliation must continue to observe the same checkout/revision.
      const recovered = await engine.resume({ jobId: "one" });
      assert.equal(recovered.jobs.one.verification?.sha, source);
      assert.equal(recovered.jobs.one.blocker, undefined);
      assert.equal(git(selected.repo, "rev-parse", "HEAD"), selected.head);
      assert.equal(git(unrelated.repo, "rev-parse", "HEAD"), unrelated.head);
      assert.equal(
        git(unrelated.repo, "status", "--porcelain"),
        unrelatedStatus,
      );
      assert.deepEqual(
        await readFile(join(unrelated.repo, ".git/index")),
        unrelatedIndex,
      );
      assert.equal(
        await readFile(join(unrelated.repo, "payload.txt"), "utf8"),
        "unrelated\n",
      );
      assert.equal(
        await readFile(join(unrelated.repo, "untracked.txt"), "utf8"),
        "keep this\n",
      );
      assert.equal(await readFile(sentinel, "utf8"), "untouched\n");
    } finally {
      await engine?.close();
      restore();
      if (server?.pid) {
        await herdr("server", "stop").catch(() => undefined);
        if (server.exitCode === null && server.signalCode === null) {
          const exited = once(server, "exit");
          const timer = setTimeout(() => server?.kill("SIGKILL"), 3000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        }
        await herdr("session", "delete", session, "--json");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
