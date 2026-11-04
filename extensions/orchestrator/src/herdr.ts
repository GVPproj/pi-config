import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { gitEnvironment } from "./git-environment.ts";

export type Workspace = {
  path: string;
  branch: string;
  workspaceId: string;
  paneId?: string;
  /** Opaque, durable local server identity; not just a session name or workspace ID. */
  session?: string;
};

export interface Workspaces {
  preflight(explicitRecovery?: boolean): Promise<void>;
  create(input: {
    repo: string;
    path: string;
    branch: string;
    base: string;
    label: string;
  }): Promise<Workspace>;
  reconcile(workspace: Workspace, repo: string): Promise<Workspace>;
  /** Explicit recovery only: adopt an existing checkout into the current server. */
  recover?(input: {
    repo: string;
    path: string;
    branch: string;
  }): Promise<Workspace>;
  open(workspace: Workspace): Promise<void>;
  status(workspace: Workspace, text: string): Promise<void>;
}

type Identity = {
  // Socket-selected status responses report a null session name.
  name: string | null;
  socket: string;
  dev: number;
  ino: number;
  birthtime: number;
};
type NativeWorkspace = {
  workspace_id: string;
  worktree?: { checkout_path: string; repo_key: string };
};
type NativeWorktree = { path: string; branch?: string };
type Opened = {
  workspace: NativeWorkspace;
  root_pane: { pane_id: string; workspace_id: string };
  worktree: NativeWorktree;
};

const exec = promisify(execFile);
async function command(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await exec(file, args, {
    env: gitEnvironment(env),
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export class HerdrWorkspaces implements Workspaces {
  // Capture caller context once, not whichever pane/session is inherited after a reload.
  private readonly env = { ...process.env };
  private readonly selection: string | undefined;
  private identity?: Promise<Identity>;

  constructor(session?: string) {
    this.selection = session;
  }

  private requireHerdr(): void {
    if (this.env.HERDR_ENV !== "1")
      throw new Error(
        "Outside herdr: workspace operations require HERDR_ENV=1",
      );
  }

  private async socketIdentity(socket: string) {
    const info = await stat(socket);
    if (!info.isSocket()) throw new Error("herdr endpoint is not a socket");
    return { dev: info.dev, ino: info.ino, birthtime: info.birthtimeMs };
  }

  private selected(): Promise<Identity> {
    this.requireHerdr();
    return (this.identity ??= (async () => {
      try {
        const env = { ...this.env };
        if (this.selection !== undefined) delete env.HERDR_SOCKET_PATH;
        const prefix =
          this.selection === undefined ? [] : ["--session", this.selection];
        const response = JSON.parse(
          await command("herdr", [...prefix, "status", "--json"], env),
        );
        const server = response.server;
        if (
          !server?.running ||
          !server.endpoint_compatible ||
          !isAbsolute(server.socket ?? "") ||
          (server.session !== null && typeof server.session !== "string")
        ) {
          throw new Error("no compatible running server");
        }
        return {
          name: server.session,
          socket: server.socket,
          ...(await this.socketIdentity(server.socket)),
        };
      } catch (cause) {
        throw new Error(
          "herdr unavailable: a compatible running local herdr session is required",
          { cause },
        );
      }
    })());
  }

  private recorded(workspace: Workspace): Identity {
    this.requireHerdr();
    try {
      const id = JSON.parse(workspace.session ?? "");
      if (
        (id.name !== null && typeof id.name !== "string") ||
        typeof id.socket !== "string" ||
        !isAbsolute(id.socket) ||
        ![id.dev, id.ino, id.birthtime].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
      ) {
        throw new Error("invalid identity");
      }
      return id;
    } catch (cause) {
      throw new Error(
        "Missing or invalid recorded herdr session identity; refusing to use current session",
        { cause },
      );
    }
  }

  private async call(id: Identity, args: string[]): Promise<string> {
    this.requireHerdr();
    try {
      const current = await this.socketIdentity(id.socket);
      if (
        current.dev !== id.dev ||
        current.ino !== id.ino ||
        current.birthtime !== id.birthtime
      ) {
        throw new Error(
          "recorded server socket was replaced; explicit recovery is required",
        );
      }
    } catch (cause) {
      throw new Error(
        "herdr unavailable: recorded session/socket identity is no longer live",
        { cause },
      );
    }
    // The absolute socket is authoritative, even under another session's inherited context.
    return command("herdr", args, {
      ...this.env,
      HERDR_SOCKET_PATH: id.socket,
    });
  }

  private async json<T>(id: Identity, args: string[]): Promise<T> {
    const response = JSON.parse(await this.call(id, args));
    if (response.error || !response.result)
      throw new Error(`herdr failed: ${JSON.stringify(response)}`);
    return response.result as T;
  }

  private git(path: string, ...args: string[]): Promise<string> {
    return command("git", ["-C", path, ...args], this.env);
  }

  private async checkout(
    workspace: Pick<Workspace, "path" | "branch">,
    repo?: string,
  ): Promise<string> {
    const path = await realpath(workspace.path);
    const top = await realpath(
      await this.git(path, "rev-parse", "--show-toplevel"),
    );
    const branch = await this.git(path, "symbolic-ref", "--short", "HEAD");
    const common = await realpath(
      await this.git(
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    );
    if (path !== top || branch !== workspace.branch)
      throw new Error("herdr checkout path/branch identity mismatch");
    if (
      repo &&
      common !==
        (await realpath(
          await this.git(
            repo,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        ))
    ) {
      throw new Error("herdr repository identity mismatch");
    }
    return common;
  }

  private async verify(
    native: NativeWorkspace,
    workspace: Workspace,
    repo?: string,
  ): Promise<void> {
    const common = await this.checkout(workspace, repo);
    if (
      native.workspace_id !== workspace.workspaceId ||
      !native.worktree ||
      (await realpath(native.worktree.checkout_path)) !==
        (await realpath(workspace.path)) ||
      (await realpath(native.worktree.repo_key)) !== common
    ) {
      throw new Error(
        "herdr workspace identity mismatch; refusing to target an unrelated workspace",
      );
    }
  }

  private async live(workspace: Workspace): Promise<Identity> {
    const id = this.recorded(workspace);
    const result = await this.json<{ workspace: NativeWorkspace }>(id, [
      "workspace",
      "get",
      workspace.workspaceId,
    ]);
    await this.verify(result.workspace, workspace);
    return id;
  }

  private async opened(
    id: Identity,
    result: Opened,
    expected: Pick<Workspace, "path" | "branch">,
    repo: string,
  ): Promise<Workspace> {
    const workspace: Workspace = {
      path: await realpath(expected.path),
      branch: expected.branch,
      workspaceId: result.workspace?.workspace_id,
      paneId: result.root_pane?.pane_id,
      session: JSON.stringify(id),
    };
    if (
      !workspace.workspaceId ||
      !workspace.paneId ||
      result.root_pane.workspace_id !== workspace.workspaceId ||
      result.worktree?.branch !== expected.branch ||
      (await realpath(result.worktree.path)) !== workspace.path
    ) {
      throw new Error("herdr returned worktree/pane identity mismatch");
    }
    await this.verify(result.workspace, workspace, repo);
    return workspace;
  }

  async preflight(explicitRecovery = false): Promise<void> {
    if (explicitRecovery) this.identity = undefined;
    const id = await this.selected();
    await this.json(id, ["workspace", "list"]);
  }

  async create(input: {
    repo: string;
    path: string;
    branch: string;
    base: string;
    label: string;
  }): Promise<Workspace> {
    const id = await this.selected();
    const repo = await realpath(input.repo);
    const base = await this.git(
      repo,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${input.base}^{commit}`,
    );
    await this.git(repo, "check-ref-format", "--branch", input.branch);
    // Native create runs Git in the long-lived herdr server, not this CLI's
    // sanitized environment. Create locally so hooks/replacements/routing obey
    // the same policy as validation, then register the retained checkout.
    await this.git(
      repo,
      "worktree",
      "add",
      "-b",
      input.branch,
      "--",
      resolve(input.path),
      base,
    );
    const result = await this.json<Opened>(id, [
      "worktree",
      "open",
      "--cwd",
      repo,
      "--path",
      resolve(input.path),
      "--label",
      input.label,
      "--no-focus",
    ]);
    const workspace = await this.opened(id, result, input, repo);
    if ((await this.git(workspace.path, "rev-parse", "HEAD")) !== base)
      throw new Error("herdr checkout base revision mismatch");
    return workspace;
  }

  async reconcile(workspace: Workspace, repo: string): Promise<Workspace> {
    const id = this.recorded(workspace);
    await this.checkout(workspace, repo);
    const { workspaces } = await this.json<{ workspaces: NativeWorkspace[] }>(
      id,
      ["workspace", "list"],
    );
    const existing = workspaces.find(
      (item) => item.workspace_id === workspace.workspaceId,
    );
    if (existing) await this.verify(existing, workspace, repo);
    // Only reopen a registered checkout. Never recreate a missing path/branch or replay create.
    const { worktrees } = await this.json<{ worktrees: NativeWorktree[] }>(id, [
      "worktree",
      "list",
      "--cwd",
      resolve(repo),
    ]);
    const path = await realpath(workspace.path);
    const retained = worktrees.find(
      (item) => item.path === path && item.branch === workspace.branch,
    );
    if (!retained)
      throw new Error("herdr retained worktree path/branch identity mismatch");
    const result = await this.json<Opened>(id, [
      "worktree",
      "open",
      "--cwd",
      resolve(repo),
      "--path",
      path,
      "--no-focus",
    ]);
    const recovered = await this.opened(id, result, workspace, repo);
    if (existing && recovered.workspaceId !== workspace.workspaceId)
      throw new Error("herdr workspace identity changed during reconciliation");
    return recovered;
  }

  async recover(input: {
    repo: string;
    path: string;
    branch: string;
  }): Promise<Workspace> {
    const id = await this.selected();
    return this.reconcile(
      {
        path: input.path,
        branch: input.branch,
        workspaceId: "",
        session: JSON.stringify(id),
      },
      input.repo,
    );
  }

  async open(workspace: Workspace): Promise<void> {
    const id = await this.live(workspace);
    await this.call(id, ["workspace", "focus", workspace.workspaceId]);
  }

  async status(workspace: Workspace, text: string): Promise<void> {
    const id = await this.live(workspace);
    await this.call(id, [
      "workspace",
      "report-metadata",
      workspace.workspaceId,
      "--source",
      "orchestrator",
      "--token",
      `status=${text}`,
    ]);
  }
}
