import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  rmdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Run } from "./domain.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Synchronous short writes keep state transitions atomic relative to async jobs.
export class Store {
  readonly root: string;
  private token?: string;
  constructor(dataDir: string, identity: string) {
    this.root = join(dataDir, "orchestrator", digest(identity));
  }
  acquire(recover = false) {
    if (this.token) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.withOwnershipLock(() => {
      const lock = join(this.root, "owner.json");
      if (recover)
        this.removeOwner((previous) => {
          if (previous.host !== hostname())
            throw new Error(
              "Run ownership is on another host; explicit reconciliation required",
            );
          try {
            process.kill(previous.pid, 0);
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === "ESRCH";
          }
          return false;
        });
      const token = randomUUID();
      try {
        writeFileSync(
          lock,
          JSON.stringify({ pid: process.pid, host: hostname(), token }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        throw new Error(
          "Repository has an active orchestrator owner; do not start a competing writer",
        );
      }
      this.token = token;
    });
  }
  // Serialize the entire read/liveness/unlink/create transition, including
  // ordinary approval and release. Never reclaim this guard automatically:
  // death inside the critical section requires explicit reconciliation.
  private withOwnershipLock(action: () => void) {
    const guard = join(this.root, "owner.guard");
    try {
      mkdirSync(guard, { mode: 0o700 });
    } catch {
      throw new Error(
        "Repository ownership transition is locked; retry, or explicitly reconcile an abandoned owner.guard after stopping all owners",
      );
    }
    try {
      action();
    } finally {
      rmdirSync(guard);
    }
  }
  release() {
    if (!this.token) return;
    this.withOwnershipLock(() => {
      this.removeOwner(
        (owner) =>
          owner.token === this.token &&
          owner.pid === process.pid &&
          owner.host === hostname(),
      );
      this.token = undefined;
    });
  }
  // Called only under the ownership guard. Keep the inode open until unlink so
  // a substituted path cannot be mistaken for the record whose PID we checked.
  private removeOwner(
    eligible: (owner: { pid: number; host: string; token: string }) => boolean,
  ) {
    const lock = join(this.root, "owner.json");
    let fd: number;
    try {
      fd = openSync(
        lock,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const entry = fstatSync(fd);
      if (!entry.isFile() || entry.nlink !== 1)
        throw new Error(
          "Repository owner is not a regular private file; explicit reconciliation required",
        );
      const owner = JSON.parse(readFileSync(fd, "utf8"));
      if (
        !owner ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        owner.pid > 0x7fffffff ||
        typeof owner.host !== "string" ||
        !owner.host ||
        typeof owner.token !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          owner.token,
        )
      )
        throw new Error(
          "Invalid repository owner record; explicit reconciliation required",
        );
      if (!eligible(owner)) return;
      const current = lstatSync(lock);
      if (
        current.dev !== entry.dev ||
        current.ino !== entry.ino ||
        current.size !== entry.size ||
        current.mtimeMs !== entry.mtimeMs ||
        current.ctimeMs !== entry.ctimeMs
      )
        throw new Error(
          "Repository owner changed during reconciliation; refusing to unlink",
        );
      unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  }
  path(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
    return join(this.root, id);
  }
  save(run: Run) {
    if (!this.token) throw new Error("Run is not owned");
    const dir = this.path(run.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `state-${randomUUID()}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(run, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, "state.json"));
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  load(id: string): Run {
    const run = JSON.parse(
      readFileSync(join(this.path(id), "state.json"), "utf8"),
    );
    if (run.version !== 1 || run.id !== id)
      throw new Error("Unsupported/corrupt run state");
    return run;
  }
  artifact(id: string, name: string, content: string) {
    const dir = join(this.path(id), "artifacts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name.replace(/[^a-zA-Z0-9_.-]/g, "_"));
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return path;
  }
}
