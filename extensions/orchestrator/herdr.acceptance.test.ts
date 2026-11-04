import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test(
  "native herdr retains three checkouts without stealing focus and safely recovers workspace identity",
  { skip: process.env.ORCHESTRATOR_HERDR_TEST !== "1", timeout: 120_000 },
  async (t) => {
    assert.equal(process.env.HERDR_ENV, "1", "acceptance requires HERDR_ENV=1");
    const root = await mkdtemp(join(tmpdir(), "orchestrator-herdr-"));
    const session = `orchestrator-test-${process.pid}-${Date.now()}`;
    const repo = join(root, "repo");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("HERDR_")) delete env[key];
    }
    env.HERDR_ENV = "1";
    const run = async (file: string, args: string[]) =>
      (
        await exec(file, args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 })
      ).stdout.trim();
    const herdr = (...args: string[]) =>
      run("herdr", ["--session", session, ...args]);
    const json = async (...args: string[]) =>
      JSON.parse(await herdr(...args)).result;
    const git = (...args: string[]) => run("git", ["-C", repo, ...args]);
    const savedEnv = { ...process.env };
    let server: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(repo);
      await git("init", "-b", "main");
      await git(
        "-c",
        "user.name=Acceptance",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      );
      const base = await git("rev-parse", "HEAD");
      server = spawn("herdr", ["--session", session, "server"], {
        env,
        cwd: repo,
        stdio: "ignore",
      });
      let spawnError: Error | undefined;
      server.on("error", (error) => {
        spawnError = error;
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (spawnError) throw spawnError;
        assert.equal(
          server.exitCode,
          null,
          "isolated server exited during startup",
        );
        try {
          await json("workspace", "list");
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const status = JSON.parse(await herdr("status", "--json"));
      t.diagnostic(`status JSON: ${JSON.stringify(status)}`);
      const initial = await json(
        "workspace",
        "create",
        "--cwd",
        repo,
        "--label",
        "test focus",
        "--focus",
      );
      const snapshot = async () => (await json("api", "snapshot")).snapshot;
      const focus = async () => {
        const s = await snapshot();
        return [s.focused_workspace_id, s.focused_tab_id, s.focused_pane_id];
      };
      const before = await focus();

      // Dynamic import keeps the opt-in test inert when herdr is not requested.
      const { HerdrWorkspaces } = await import("./src/herdr.ts");
      const adapter = new HerdrWorkspaces(session);
      await adapter.preflight();
      // Freeze inherited selection at construction; later context changes must not retarget it.
      process.env.HERDR_SOCKET_PATH = status.server.socket;
      const inherited = new HerdrWorkspaces();
      process.env.HERDR_SOCKET_PATH = join(root, "unrelated.sock");
      await inherited.preflight();
      const workspaces = [];
      for (let i = 1; i <= 3; i++) {
        const path = join(root, `job-${i}`);
        const branch = `issue-${i}`;
        const workspace = await (i === 1 ? inherited : adapter).create({
          repo,
          path,
          branch,
          base,
          label: `Issue ${i}`,
        });
        workspaces.push(workspace);
        assert.equal(workspace.path, await realpath(path));
        assert.equal(workspace.branch, branch);
        assert.ok(workspace.workspaceId);
        assert.ok(workspace.paneId);
        assert.ok(workspace.session, "durable server identity is required");
        const live = await json("workspace", "get", workspace.workspaceId);
        assert.equal(live.workspace.worktree.checkout_path, path);
        assert.equal(live.workspace.worktree.repo_root, repo);
        assert.equal(
          await run("git", ["-C", path, "branch", "--show-current"]),
          branch,
        );
        assert.equal(await run("git", ["-C", path, "rev-parse", "HEAD"]), base);
        assert.equal(
          await run("git", [
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
          join(repo, ".git"),
        );
        assert.deepEqual(await focus(), before);
      }
      assert.equal(new Set(workspaces.map((w) => w.workspaceId)).size, 3);
      assert.equal(new Set(workspaces.map((w) => w.paneId)).size, 3);
      assert.equal((await snapshot()).workspaces.length, 4);
      t.diagnostic(`created Workspace: ${JSON.stringify(workspaces[0])}`);
      t.diagnostic(
        `native worktree list: ${JSON.stringify(await json("worktree", "list", "--cwd", repo))}`,
      );

      const first = workspaces[0];
      await adapter.status(first, "checking");
      assert.equal(
        (await json("workspace", "get", first.workspaceId)).workspace.tokens
          .status,
        "checking",
      );
      assert.deepEqual(await focus(), before);
      await assert.rejects(
        adapter.reconcile(
          { ...first, workspaceId: workspaces[1].workspaceId },
          repo,
        ),
        /identity|mismatch/i,
      );
      await assert.rejects(
        adapter.reconcile({ ...first, branch: "wrong-branch" }, repo),
        /branch|identity|mismatch/i,
      );
      await assert.rejects(
        adapter.open({ ...first, workspaceId: initial.workspace.workspace_id }),
        /identity|mismatch/i,
      );
      await assert.rejects(
        adapter.status(
          { ...first, workspaceId: initial.workspace.workspace_id },
          "wrong",
        ),
        /identity|mismatch/i,
      );
      await assert.rejects(
        adapter.open({ ...first, session: undefined }),
        /session|identity/i,
      );
      assert.deepEqual(await focus(), before);

      // Close only an entry created above; its checkout and dirty contents must survive.
      await writeFile(join(first.path, "retained.txt"), "keep me\n");
      await herdr("workspace", "close", first.workspaceId);
      // Simulate reload under unrelated/unavailable inherited context. Saved identity wins.
      const reloaded = new HerdrWorkspaces();
      const recovered = await reloaded.reconcile(
        JSON.parse(JSON.stringify(first)),
        repo,
      );
      assert.notEqual(recovered.workspaceId, first.workspaceId);
      assert.equal(recovered.session, first.session);
      assert.equal(recovered.path, first.path);
      assert.deepEqual(await reloaded.reconcile(recovered, repo), recovered);
      assert.equal(
        await run("git", ["-C", first.path, "status", "--porcelain"]),
        "?? retained.txt",
      );
      assert.equal(
        (await json("worktree", "list", "--cwd", repo)).worktrees.length,
        4,
      );
      assert.deepEqual(await focus(), before);
      await reloaded.open(recovered);
      assert.equal((await focus())[0], recovered.workspaceId);
      await reloaded.status(recovered, "retained");
      assert.equal(
        (await json("workspace", "get", recovered.workspaceId)).workspace.tokens
          .status,
        "retained",
      );

      await assert.rejects(
        new HerdrWorkspaces(`${session}-absent`).preflight(),
        /herdr.*unavailable|unavailable.*herdr/i,
      );
      // A saved identity must not be redirected even when its socket no longer exists.
      await herdr("server", "stop");
      await assert.rejects(
        reloaded.status(recovered, "must not reach another session"),
        /unavailable|identity/i,
      );
      delete process.env.HERDR_ENV;
      await assert.rejects(
        new HerdrWorkspaces(session).preflight(),
        /outside herdr|HERDR_ENV/i,
      );
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      if (server?.pid) {
        // Every lifecycle command is explicitly scoped to this unique test session.
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
