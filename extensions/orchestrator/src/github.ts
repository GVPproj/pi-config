import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { gitEnvironment } from "./git-environment.ts";

export type Destination = {
  remote: string;
  url: string;
  repository: string;
  prBase: string;
};
export type Publication = { url: string; number: number; sha: string };
export type CiEvidence = {
  sha: string;
  state: "passed" | "pending" | "failed" | "unobservable";
  checks: Array<{ name: string; state: string; url?: string }>;
};
export interface Publisher {
  preflight(
    repo: string,
    destination: Destination,
    newBranches?: string[],
  ): Promise<void>;
  publish(
    input: {
      repo: string;
      cwd: string;
      destination: Destination;
      branch: string;
      sha: string;
      base: string;
      title: string;
      body: string;
      marker: string;
      previousSha?: string;
      allowCreate: boolean;
    },
    signal: AbortSignal,
  ): Promise<Publication>;
  ci(
    destination: Destination,
    sha: string,
    required: string[],
    signal: AbortSignal,
  ): Promise<CiEvidence>;
  pushIntegration(
    input: {
      cwd: string;
      destination: Destination;
      branch: string;
      sha: string;
      previousSha?: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

type PublishInput = Parameters<Publisher["publish"]>[0];
type PushInput = Parameters<Publisher["pushIntegration"]>[0];
type PullRequest = {
  url: string;
  number: number;
  body: string;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepository: { name: string } | null;
  headRepositoryOwner: { login: string } | null;
};
type CheckRun = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
};
type CommitStatus = {
  id: number;
  context: string;
  state: string;
  target_url?: string | null;
};

// One bounded child per operation, never a shell. Errors (including ambiguous
// writes) propagate: the caller must persist intent before invoking publication.
function run(
  command: "git" | "gh",
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        signal,
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        shell: false,
        env: {
          ...gitEnvironment(),
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "cat",
        },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`GitHub publication blocked: ${message}`);
}
function validSha(sha: string): void {
  assert(/^[0-9a-f]{40}$/.test(sha), "expected a full GitHub commit SHA");
}
function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function validateDestination(destination: Destination): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(destination.remote),
    "invalid remote name",
  );
  assert(
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(destination.repository),
    "expected an explicit owner/repository",
  );
  // Enterprise hosts require a separate approved host contract, not GH_HOST
  // inference. Do not accept credentials, ports, URL options, or local remotes.
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\s?#]+)$/.exec(
      destination.url,
    );
  assert(
    match,
    "only explicit github.com HTTPS/SSH destinations are supported",
  );
  assert(
    sameRepository(match[1].replace(/\.git$/, ""), destination.repository),
    "approved URL does not identify the approved repository",
  );
}
async function validBranch(cwd: string, branch: string, signal?: AbortSignal) {
  assert(branch && !branch.startsWith("-"), "invalid branch name");
  await run("git", ["check-ref-format", `refs/heads/${branch}`], cwd, signal);
}

export class GithubPublisher implements Publisher {
  private readonly execute: typeof run;
  constructor(execute: typeof run = run) {
    this.execute = execute;
  }

  async preflight(
    repo: string,
    destination: Destination,
    newBranches: string[] = [],
  ): Promise<void> {
    const defaultBranch = await this.inspect(repo, destination);
    for (const branch of newBranches) {
      await validBranch(repo, branch);
      assert(
        branch !== defaultBranch && branch !== destination.prBase,
        "owned branch must not be a delivery target",
      );
      const remote = await this.remoteSha(
        { cwd: repo, destination, branch, sha: "" },
        new AbortController().signal,
      );
      assert(!remote, `branch already exists remotely: ${branch}`);
    }
  }

  private async inspect(
    cwd: string,
    destination: Destination,
    signal?: AbortSignal,
  ): Promise<string> {
    const run = this.execute;
    validateDestination(destination);
    await validBranch(cwd, destination.prBase, signal);
    const configured = await run(
      "git",
      ["config", "--get-all", `remote.${destination.remote}.url`],
      cwd,
      signal,
    );
    const fetch = await run(
      "git",
      ["remote", "get-url", "--all", destination.remote],
      cwd,
      signal,
    );
    const push = await run(
      "git",
      ["remote", "get-url", "--push", "--all", destination.remote],
      cwd,
      signal,
    );
    assert(
      [configured, fetch, push].every((url) => url === destination.url),
      "configured, fetch, and push URLs must each be a single approved URL",
    );
    // repo view takes the explicit repository as a positional argument (it has
    // no --repo flag); every PR command below supplies --repo explicitly.
    const info = JSON.parse(
      await run(
        "gh",
        [
          "repo",
          "view",
          `github.com/${destination.repository}`,
          "--json",
          "nameWithOwner,url,viewerPermission,defaultBranchRef",
        ],
        cwd,
        signal,
      ),
    ) as {
      nameWithOwner: string;
      url: string;
      viewerPermission: string;
      defaultBranchRef: { name: string } | null;
    };
    assert(
      typeof info.nameWithOwner === "string" &&
        sameRepository(info.nameWithOwner, destination.repository) &&
        typeof info.url === "string" &&
        sameRepository(
          info.url,
          `https://github.com/${destination.repository}`,
        ),
      "GitHub returned a different repository identity",
    );
    assert(
      ["WRITE", "MAINTAIN", "ADMIN"].includes(info.viewerPermission),
      "GitHub write permission is unavailable",
    );
    assert(info.defaultBranchRef?.name, "default branch is unobservable");
    return info.defaultBranchRef.name;
  }

  private async preparePush(input: PushInput, signal: AbortSignal) {
    const run = this.execute;
    const defaultBranch = await this.inspect(
      input.cwd,
      input.destination,
      signal,
    );
    await validBranch(input.cwd, input.branch, signal);
    assert(
      input.branch !== defaultBranch &&
        input.branch !== input.destination.prBase,
      "an owned branch cannot be the default branch or PR base",
    );
    validSha(input.sha);
    if (input.previousSha !== undefined) {
      validSha(input.previousSha);
      await run(
        "git",
        ["merge-base", "--is-ancestor", input.previousSha, input.sha],
        input.cwd,
        signal,
      );
    }
    const local = await run(
      "git",
      ["rev-parse", "--verify", `refs/heads/${input.branch}^{commit}`],
      input.cwd,
      signal,
    );
    assert(
      local === input.sha,
      "local intended branch does not match the verified SHA",
    );
  }

  private async remoteSha(input: PushInput, signal: AbortSignal) {
    const run = this.execute;
    const ref = `refs/heads/${input.branch}`;
    const output = await run(
      "git",
      ["ls-remote", "--refs", input.destination.remote, ref],
      input.cwd,
      signal,
    );
    if (!output) return undefined;
    const lines = output.split("\n");
    const fields = lines[0].split(/\s+/);
    assert(lines.length === 1 && fields[1] === ref, "ambiguous remote branch");
    validSha(fields[0]);
    return fields[0];
  }

  private async push(input: PushInput, signal: AbortSignal): Promise<void> {
    const run = this.execute;
    const remote = await this.remoteSha(input, signal);
    // The caller reserves a unique run namespace and persists branch intent.
    // preparePush checked the local branch, including first-push recovery with
    // no PR yet. Never infer ownership of a different remote revision.
    if (remote === input.sha) return;
    if (remote === undefined) {
      assert(
        input.previousSha === undefined,
        "previously published branch disappeared",
      );
    } else {
      assert(
        input.previousSha !== undefined && remote === input.previousSha,
        "remote branch is unrelated or changed since the recorded publication",
      );
      // A lease alone permits rewrites. This ancestry check is mandatory;
      // missing local history also blocks, rather than weakening the check.
      await run(
        "git",
        ["merge-base", "--is-ancestor", remote, input.sha],
        input.cwd,
        signal,
      );
    }
    const ref = `refs/heads/${input.branch}`;
    await run(
      "git",
      [
        "-c",
        `remote.${input.destination.remote}.mirror=false`,
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
        // Empty expected SHA is create-only CAS. For updates this is a CAS
        // on an independently verified fast-forward, NEVER a force rewrite.
        `--force-with-lease=${ref}:${remote ?? ""}`,
        input.destination.remote,
        `${input.sha}:${ref}`,
      ],
      input.cwd,
      signal,
    );
    assert(
      (await this.remoteSha(input, signal)) === input.sha,
      "push SHA is unconfirmed",
    );
  }

  private async prs(
    input: PublishInput,
    signal: AbortSignal,
  ): Promise<PullRequest[]> {
    const run = this.execute;
    const prs = JSON.parse(
      await run(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          `github.com/${input.destination.repository}`,
          "--state",
          "all",
          "--head",
          input.branch,
          "--limit",
          "1000",
          "--json",
          "url,number,body,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
        ],
        input.cwd,
        signal,
      ),
    ) as PullRequest[];
    assert(
      Array.isArray(prs) && prs.length < 1000,
      "PR query is invalid or truncated",
    );
    assert(
      prs.length <= 1,
      "multiple PRs exist for the intended head; reconcile explicitly",
    );
    return prs;
  }

  private validatePr(pr: PullRequest, input: PublishInput, body: string): void {
    const repository = `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`;
    assert(
      typeof pr.body === "string" && pr.body.split(input.marker).length === 2,
      "existing PR does not have the unique expected ownership marker",
    );
    assert(
      pr.state === "OPEN" && pr.isDraft === true,
      "existing PR is closed, merged, or no longer draft",
    );
    assert(
      pr.isCrossRepository === false &&
        sameRepository(repository, input.destination.repository) &&
        pr.headRefName === input.branch &&
        pr.baseRefName === input.base,
      "existing PR head/base repository or branch differs from the approved target",
    );
    assert(
      Number.isSafeInteger(pr.number) &&
        pr.number > 0 &&
        typeof pr.url === "string" &&
        sameRepository(
          pr.url,
          `https://github.com/${input.destination.repository}/pull/${pr.number}`,
        ),
      "invalid PR identity",
    );
    validSha(pr.headRefOid);
    assert(
      pr.headRefOid === input.sha || pr.headRefOid === input.previousSha,
      "existing PR head is not a recorded revision",
    );
  }

  async publish(
    input: PublishInput,
    signal: AbortSignal,
  ): Promise<Publication> {
    const run = this.execute;
    signal.throwIfAborted();
    assert(
      input.marker.trim().length > 0,
      "a persisted unique PR marker is required",
    );
    assert(input.title.trim().length > 0, "PR title is empty");
    const occurrences = input.body.split(input.marker).length - 1;
    assert(occurrences <= 1, "PR body contains duplicate ownership markers");
    const body =
      occurrences === 1
        ? input.body
        : `${input.body.trimEnd()}\n\n${input.marker}`;
    assert(
      !/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+(?:(?:https:\/\/github\.com\/[^\s]+\/issues\/\d+)|(?:[\w.-]+\/[\w.-]+)?#\d+)/i.test(
        `${input.title}\n${body}`,
      ),
      "use non-closing issue references in PR text",
    );
    const commonDir = async (cwd: string) =>
      realpath(
        await run(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          cwd,
          signal,
        ),
      );
    assert(
      (await commonDir(input.repo)) === (await commonDir(input.cwd)),
      "publication worktree does not belong to the approved repository",
    );
    await this.preparePush(input, signal);
    // base is the explicitly approved PR target, including a stacked parent.
    await validBranch(input.cwd, input.base, signal);
    let prs = await this.prs(input, signal);
    if (prs[0]) this.validatePr(prs[0], input, body);
    else
      assert(
        input.allowCreate,
        "PR creation outcome is ambiguous; explicit reconciliation required",
      );
    await this.push(input, signal);
    // Re-query after the push, before any creation, to reconcile partial work.
    prs = await this.prs(input, signal);
    if (prs[0]) this.validatePr(prs[0], input, body);
    else {
      assert(
        input.allowCreate,
        "PR absent; creation is not authorized during reconciliation",
      );
      await run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          `github.com/${input.destination.repository}`,
          "--head",
          input.branch,
          "--base",
          input.base,
          "--draft",
          "--title",
          input.title,
          "--body",
          body,
        ],
        input.cwd,
        signal,
      );
      // Never retry creation on an error or trust its stdout as confirmation.
      prs = await this.prs(input, signal);
    }
    assert(
      prs[0],
      "PR creation is unconfirmed; reconcile without creating again",
    );
    this.validatePr(prs[0], input, body);
    // Preserve user additions and prior evidence; append only this revision's
    // evidence, without a second ownership marker. Reconciliation is idempotent.
    const update = `Verification update:\n${body.replace(input.marker, "verification-update")}`;
    if (prs[0].body !== body && !prs[0].body.includes(update)) {
      await run(
        "gh",
        [
          "pr",
          "edit",
          String(prs[0].number),
          "--repo",
          `github.com/${input.destination.repository}`,
          "--body",
          `${prs[0].body}\n\n${update}`,
        ],
        input.cwd,
        signal,
      );
    }
    assert(
      prs[0].headRefOid === input.sha,
      "PR has not confirmed the exact pushed SHA",
    );
    assert(
      (await this.remoteSha(input, signal)) === input.sha,
      "remote branch changed during publication",
    );
    return { url: prs[0].url, number: prs[0].number, sha: input.sha };
  }

  async pushIntegration(input: PushInput, signal: AbortSignal): Promise<void> {
    await this.preparePush(input, signal);
    await this.push(input, signal);
  }

  async ci(
    destination: Destination,
    sha: string,
    required: string[],
    signal: AbortSignal,
  ): Promise<CiEvidence> {
    const run = this.execute;
    signal.throwIfAborted();
    validateDestination(destination);
    validSha(sha);
    assert(
      required.every((name) => name.trim().length > 0),
      "empty required CI context",
    );
    if (required.length === 0) return { sha, state: "passed", checks: [] };
    try {
      const api = async (path: string): Promise<unknown[]> => {
        const pages: unknown = JSON.parse(
          await run(
            "gh",
            [
              "api",
              "--hostname",
              "github.com",
              "--paginate",
              "--slurp",
              "-H",
              "Accept: application/vnd.github+json",
              `repos/${destination.repository}/commits/${sha}/${path}`,
            ],
            undefined,
            signal,
          ),
        );
        assert(
          Array.isArray(pages) && pages.length > 0,
          "CI pages are unobservable",
        );
        return pages;
      };
      const checkPages = (await api(
        "check-runs?filter=all&per_page=100",
      )) as Array<{
        total_count: number;
        check_runs: CheckRun[];
      }>;
      const statusPages = (await api("status?per_page=100")) as Array<{
        sha: string;
        total_count: number;
        statuses: CommitStatus[];
      }>;
      // Reject partial results, inconsistent pagination snapshots, and data
      // for another revision. A timeout/buffer cap never becomes green CI.
      const collect = <T>(
        pages: Array<{ total_count: number }>,
        rows: (page: number) => T[],
      ): T[] => {
        const total = pages[0].total_count;
        assert(Number.isSafeInteger(total) && total >= 0, "invalid CI count");
        const values = pages.flatMap((page, index) => {
          assert(
            page.total_count === total && Array.isArray(rows(index)),
            "inconsistent CI pages",
          );
          return rows(index);
        });
        assert(
          values.length === total,
          "CI results are truncated or changed while paginating",
        );
        return values;
      };
      const runs = collect(checkPages, (index) => checkPages[index].check_runs);
      const statuses = collect(
        statusPages,
        (index) => statusPages[index].statuses,
      );
      assert(
        statusPages.every((page) => page.sha === sha),
        "status SHA mismatch",
      );
      const latest = <T extends { id: number }>(
        items: T[],
        name: (item: T) => string,
      ): T[] => {
        const contexts = new Map<string, T>();
        const ids = new Set<number>();
        for (const item of items) {
          const key = name(item);
          assert(
            typeof key === "string" &&
              key.length > 0 &&
              Number.isSafeInteger(item.id) &&
              item.id > 0,
            "invalid CI context",
          );
          assert(!ids.has(item.id), "duplicate CI result across pages");
          ids.add(item.id);
          if (!contexts.has(key) || contexts.get(key)!.id < item.id)
            contexts.set(key, item);
        }
        return [...contexts.values()];
      };
      assert(
        runs.every((run) => run.head_sha === sha),
        "check-run SHA mismatch",
      );
      assert(
        runs.every((run) =>
          [
            "queued",
            "in_progress",
            "waiting",
            "requested",
            "pending",
            "completed",
          ].includes(run.status),
        ),
        "unknown check-run lifecycle state",
      );
      const checks: CiEvidence["checks"] = [
        ...latest(runs, (run) => run.name).map((run) => ({
          name: run.name,
          state:
            run.status === "completed"
              ? (run.conclusion ?? "unobservable")
              : run.status,
          ...(run.html_url ? { url: run.html_url } : {}),
        })),
        ...latest(statuses, (status) => status.context).map((status) => ({
          name: status.context,
          state: status.state,
          ...(status.target_url ? { url: status.target_url } : {}),
        })),
      ];
      const selected = checks.filter((check) => required.includes(check.name));
      const missing = required.filter(
        (name) => !checks.some((check) => check.name === name),
      );
      checks.push(...missing.map((name) => ({ name, state: "missing" })));
      const pending = new Set([
        "queued",
        "in_progress",
        "pending",
        "waiting",
        "requested",
      ]);
      const failed = new Set([
        "failure",
        "error",
        "cancelled",
        "timed_out",
        "action_required",
        "startup_failure",
        "stale",
        "skipped",
        "neutral",
      ]);
      let state: CiEvidence["state"];
      if (selected.some((check) => failed.has(check.state))) state = "failed";
      else if (
        missing.length ||
        selected.some(
          (check) => check.state !== "success" && !pending.has(check.state),
        )
      )
        state = "unobservable";
      else if (selected.some((check) => pending.has(check.state)))
        state = "pending";
      else state = "passed";
      return { sha, state, checks };
    } catch {
      signal.throwIfAborted();
      return { sha, state: "unobservable", checks: [] };
    }
  }
}
