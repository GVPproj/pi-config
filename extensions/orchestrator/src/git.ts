import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { gitEnvironment } from "./git-environment.ts";
const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnvironment(),
  });
  return stdout.trim();
}
export async function identity(repo: string) {
  return realpath(
    await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
}
export async function revision(cwd: string) {
  return git(cwd, "rev-parse", "HEAD");
}
export async function clean(cwd: string) {
  if (await git(cwd, "status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "Dirty checkout; reconcile manually before continuing (no files were discarded).",
    );
  if (await git(cwd, "ls-files", "-u"))
    throw new Error("Unresolved conflicts; reconciliation required.");
}
export async function checkout(
  repoIdentity: string,
  workspace: { path: string; branch: string },
  expected?: string,
) {
  if ((await identity(workspace.path)) !== repoIdentity)
    throw new Error("Worktree repository identity changed");
  const actual = await realpath(
    await git(workspace.path, "rev-parse", "--show-toplevel"),
  );
  if (actual !== (await realpath(workspace.path)))
    throw new Error("Worktree path identity changed");
  if (
    (await git(workspace.path, "branch", "--show-current")) !== workspace.branch
  )
    throw new Error("Worktree branch changed");
  if (expected && (await revision(workspace.path)) !== expected)
    throw new Error("Source revision diverged; reconcile before continuing");
}
export async function ancestor(cwd: string, base: string, sha: string) {
  try {
    await git(cwd, "merge-base", "--is-ancestor", base, sha);
    return true;
  } catch {
    return false;
  }
}
