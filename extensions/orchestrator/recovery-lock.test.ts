import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Plan } from "./src/domain.ts";
import { Orchestrator } from "./src/orchestrator.ts";

const model = { model: "test/model", thinking: "off" as const };
const plan: Plan = {
  base: "HEAD",
  delivery: "integration",
  integration: { branch: "orchestrator/recovery/integration", publish: false },
  jobs: [
    {
      id: "one",
      branch: "orchestrator/recovery/one",
      issues: [
        {
          id: "ISSUE-1",
          source: "local:test",
          title: "Recovery ownership",
          material: "Only one repository writer may recover",
          acceptance: ["Concurrent recovery retains one owner"],
          retrievedAt: "2026-01-01T00:00:00Z",
        },
      ],
      dependencies: [],
    },
  ],
  setup: [],
  checks: [{ name: "unused", command: "true", timeoutMs: 1000 }],
  requiredCI: [],
  concurrency: 1,
  repairLimit: 0,
  permissions: [],
  baselineExceptions: [],
  cleanup: "retain",
  models: { implementation: model, review: model, conflict: model },
};

function engine(repo: string, dataDir: string) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Recovery must not start workspace execution");
  };
  return new Orchestrator({
    repo,
    dataDir,
    models: { async validate() {} },
    workspaces: {
      async preflight() {},
      create: unexpected,
      reconcile: unexpected,
      open: unexpected,
      status: unexpected,
    },
  });
}

type Message =
  | { kind: "liveness" }
  | { kind: "owned"; runId: string }
  | { kind: "rejected"; error: string };

// Run this same file as a subprocess so all ownership is obtained through the
// public engine. The initial owner exits without close(), leaving genuine state.
if (process.env.ORCHESTRATOR_RECOVERY_CHILD === "1") {
  const [mode, repo, dataDir, runId, stalePid, gate] = process.argv.slice(2);
  const orchestrator = engine(repo, dataDir);
  if (mode === "recover") {
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (pid !== Number(stalePid) || signal !== 0) return kill(pid, signal);
      let failure: unknown;
      try {
        kill(pid, signal);
      } catch (error) {
        failure = error;
      }
      // Hold the observed OS result, not an invented ESRCH. Release via the
      // filesystem because the liveness call blocks this process's event loop.
      process.send!({ kind: "liveness" } satisfies Message);
      const deadline = Date.now() + 10_000;
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(gate)) {
        if (Date.now() >= deadline)
          throw new Error("Liveness barrier timed out");
        Atomics.wait(sleep, 0, 0, 10);
      }
      if (failure) throw failure;
      return true;
    };
  }
  process.on("message", async (message) => {
    if (message === "close") {
      await orchestrator.close();
      process.exit(0);
    }
  });
  try {
    const run =
      mode === "crash"
        ? await orchestrator.approve((await orchestrator.prepare(plan)).digest)
        : await orchestrator.resume({ runId });
    process.send!({ kind: "owned", runId: run.id } satisfies Message, () => {
      if (mode === "crash") process.exit(0);
    });
  } catch (error) {
    process.send!({ kind: "rejected", error: String(error) } satisfies Message);
  }
} else {
  test(
    "concurrent recovery never replaces a new live repository owner",
    { timeout: 30_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-recovery-lock-"));
      const repo = join(dir, "repo");
      const dataDir = join(dir, "data");
      const children: ReturnType<typeof fork>[] = [];
      t.after(async () => {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
            child.kill("SIGKILL");
            await exited;
          }),
        );
        await rm(dir, { recursive: true, force: true });
      });
      await mkdir(join(repo, "docs/agents"), { recursive: true });
      await writeFile(
        join(repo, "docs/agents/issue-tracker.md"),
        "Local test issues.\n",
      );
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repo,
          stdio: "pipe",
        });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Test");
      git("add", ".");
      git("commit", "-m", "test repository");

      function child(mode: "crash" | "recover", runId = "", stalePid = 0) {
        const gate = join(dir, `release-${children.length}`);
        const process = fork(
          fileURLToPath(import.meta.url),
          [mode, repo, dataDir, runId, String(stalePid), gate],
          {
            execArgv: ["--experimental-strip-types"],
            env: {
              ...globalThis.process.env,
              ORCHESTRATOR_RECOVERY_CHILD: "1",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        children.push(process);
        const messages: Message[] = [];
        let stderr = "";
        process.stderr!.on("data", (chunk) => {
          stderr += chunk;
        });
        process.on("message", (message) => messages.push(message as Message));
        const exited = new Promise<number | null>((resolve) =>
          process.once("exit", resolve),
        );
        return {
          pid: process.pid!,
          exited,
          async next() {
            const deadline = Date.now() + 10_000;
            while (!messages.length) {
              assert.equal(process.exitCode, null, `Child exited: ${stderr}`);
              assert.equal(
                process.signalCode,
                null,
                `Child signalled: ${stderr}`,
              );
              assert.ok(
                Date.now() < deadline,
                `Child response timed out: ${stderr}`,
              );
              await delay(5);
            }
            return messages.shift()!;
          },
          release: () => writeFile(gate, "continue\n"),
          async crash() {
            process.kill("SIGKILL");
            await exited;
            assert.equal(process.signalCode, "SIGKILL");
          },
          async close() {
            process.send("close");
            assert.equal(await exited, 0);
          },
        };
      }

      const stale = child("crash");
      const approved = await stale.next();
      assert.equal(approved.kind, "owned");
      if (approved.kind !== "owned") throw new Error("Approval failed");
      assert.equal(await stale.exited, 0);

      const first = child("recover", approved.runId, stale.pid);
      assert.equal((await first.next()).kind, "liveness");
      const second = child("recover", approved.runId, stale.pid);
      // An exclusive implementation may reject the second contender before it
      // reaches liveness. The buggy implementation reads the same stale PID.
      const secondBoundary = await second.next();
      assert.ok(["liveness", "rejected"].includes(secondBoundary.kind));
      await first.release();
      const firstResult = await first.next();
      assert.equal(firstResult.kind, "owned");
      let secondResult = secondBoundary;
      if (secondBoundary.kind === "liveness") {
        await second.release();
        secondResult = await second.next();
      }
      assert.equal(
        [firstResult, secondResult].filter((result) => result.kind === "owned")
          .length,
        1,
        "Only one recoverer may own the repository while both processes remain alive",
      );
      assert.equal(secondResult.kind, "rejected");
      await second.close();

      // Ownership is repository-wide: a different approval is also excluded, and
      // closing a rejected contender must not release the successful owner's lock.
      const competing = engine(repo, dataDir);
      await assert.rejects(
        competing.approve((await competing.prepare(plan)).digest),
        /owner/i,
      );
      await competing.close();
      const recovering = engine(repo, dataDir);
      await assert.rejects(
        recovering.resume({ runId: approved.runId }),
        /owner/i,
      );
      await recovering.close();

      await first.close();
      const successor = engine(repo, dataDir);
      try {
        assert.equal(
          (await successor.resume({ runId: approved.runId })).id,
          approved.runId,
        );
      } finally {
        await successor.close();
      }

      await t.test(
        "recovery refuses unrelated ownership metadata",
        async (t) => {
          const stale = child("crash");
          const approved = await stale.next();
          assert.equal(approved.kind, "owned");
          if (approved.kind !== "owned") throw new Error("Approval failed");
          assert.equal(await stale.exited, 0);
          const read = fs.readFileSync;
          // Simulate a filesystem read returning an unrelated record with the dead
          // PID, not an orchestrator ownership token. No Store methods are mocked.
          const boundary = t.mock.method(
            fs,
            "readFileSync",
            (...args: Parameters<typeof read>) => {
              const result = read(...args);
              if (typeof result !== "string") return result;
              try {
                const value = JSON.parse(result);
                if (value?.pid === stale.pid) {
                  delete value.token;
                  return JSON.stringify(value);
                }
              } catch {}
              return result;
            },
          );
          syncBuiltinESMExports();
          const unrelated = engine(repo, dataDir);
          try {
            await assert.rejects(
              unrelated.resume({ runId: approved.runId }),
              /owner|reconcil/i,
            );
          } finally {
            boundary.mock.restore();
            syncBuiltinESMExports();
            await unrelated.close();
          }
          const recovery = engine(repo, dataDir);
          try {
            assert.equal(
              (await recovery.resume({ runId: approved.runId })).id,
              approved.runId,
            );
          } finally {
            await recovery.close();
          }
        },
      );

      await t.test(
        "a crash during recovery fails closed until explicit reconciliation",
        async () => {
          const stale = child("crash");
          const approved = await stale.next();
          assert.equal(approved.kind, "owned");
          if (approved.kind !== "owned") throw new Error("Approval failed");
          assert.equal(await stale.exited, 0);
          const interrupted = child("recover", approved.runId, stale.pid);
          assert.equal((await interrupted.next()).kind, "liveness");
          await interrupted.crash();

          const recovery = engine(repo, dataDir);
          try {
            await assert.rejects(
              recovery.resume({ runId: approved.runId }),
              /explicit.*reconcil/i,
            );
          } finally {
            await recovery.close();
          }
          const approval = engine(repo, dataDir);
          try {
            await assert.rejects(
              approval.approve((await approval.prepare(plan)).digest),
              /explicit.*reconcil/i,
            );
          } finally {
            await approval.close();
          }
        },
      );
    },
  );
}
