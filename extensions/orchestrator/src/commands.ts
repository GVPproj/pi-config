import { execFile, fork } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Command, CheckEvidence } from "./domain.ts";
import { gitEnvironment } from "./git-environment.ts";

export interface CheckProcess {
  pid: number;
  token: string;
  name: string;
  command: string;
  sha: string;
  artifact: string;
}
const exec = promisify(execFile);
async function group(pid: number) {
  const { stdout } = await exec("ps", ["-eo", "pid=,pgid=,stat=,args="], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(
      (m): m is RegExpExecArray =>
        !!m && Number(m[2]) === pid && !m[3].startsWith("Z"),
    );
}
/** Never signal a recycled PID/group or an unidentifiable orphan. */
export async function reconcileCheck(check: CheckProcess) {
  let members = await group(check.pid);
  if (!members.length) return;
  const owned = () =>
    members.some(
      (m) =>
        Number(m[1]) === check.pid && m[4].split(/\s+/).includes(check.token),
    );
  if (!owned())
    throw new Error(
      `Pending check process group ${check.pid} has ambiguous ownership; inspect before resuming`,
    );
  process.kill(-check.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    await delay(20);
    members = await group(check.pid);
    if (!members.length) return;
    if (i === 49) {
      if (!owned())
        throw new Error(
          "Check supervisor identity changed; refusing to signal an unrelated process",
        );
      process.kill(-check.pid, "SIGKILL");
    }
  }
  throw new Error(
    "Owned check has not stopped; reconciliation remains blocked",
  );
}

export function command(
  cwd: string,
  spec: Command,
  sha: string,
  artifact: string,
  signal: AbortSignal,
  onStart: (process: CheckProcess) => void,
): Promise<CheckEvidence> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const fd = openSync(artifact, "a", 0o600);
    const token = randomUUID();
    const child = fork(
      new URL("./check-supervisor.mjs", import.meta.url),
      [token],
      {
        cwd,
        detached: true,
        execArgv: [],
        stdio: ["ignore", fd, fd, "ipc"],
        env: gitEnvironment(),
      },
    );
    closeSync(fd);
    let timedOut = false,
      cancelled = false,
      code: number | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (s: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, s);
        } catch {}
      }
    };
    const stop = () => {
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
    };
    child.on("message", (message) => {
      const result = message as { kind?: string; code?: number };
      if (result.kind === "result") {
        code = result.code ?? null;
        clearTimeout(timer);
      }
    });
    child.on("error", (error) => {
      cleanup();
      stop();
      reject(error);
    });
    child.on("close", () => {
      cleanup();
      resolve({
        name: spec.name,
        command: spec.command,
        sha,
        artifact,
        code,
        cancelled,
        timedOut,
      });
    });
    child.on("spawn", () => {
      try {
        if (!child.pid)
          throw new Error("Check supervisor has no process identity");
        onStart({
          pid: child.pid,
          token,
          name: spec.name,
          command: spec.command,
          sha,
          artifact,
        });
        if (signal.aborted) {
          abort();
          return;
        }
        child.send({ kind: "run", command: spec.command }, (error) => {
          if (error) {
            stop();
            reject(error);
          }
        });
      } catch (error) {
        stop();
        reject(error);
      }
    });
    if (signal.aborted) abort();
  });
}
