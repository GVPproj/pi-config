/**
 * /rewind — Claude-Code-style rewind for pi.
 *
 * Captures a working-tree checkpoint before each user prompt, then `/rewind`
 * rolls BOTH the conversation and the code back to a chosen checkpoint:
 *   - conversation: `ctx.navigateTree(leafId)` moves the session leaf back
 *   - code (git repos only): `git reset --hard HEAD` + `git stash apply <snap>`
 *
 * Global extension: lives at ~/.pi/agent/extensions/rewind.ts (auto-discovered,
 * hot-reloadable via /reload). Run /rewind to pick a checkpoint.
 *
 * Design notes:
 * - Snapshot uses `git stash create -u`, which is non-disturbing — it returns a
 *   commit SHA without touching the working tree, index, or stash list. Empty
 *   result means the tree was clean at HEAD.
 * - Before any destructive restore, a safety `git stash create -u` snapshot of
 *   the *current* pending changes is taken and its SHA reported, so a rewind is
 *   always recoverable.
 * - Untracked files created AFTER a checkpoint are intentionally left in place
 *   on rewind (we never `git clean`); only tracked changes are restored exactly.
 * - Checkpoints are in-memory and per-session (cleared on session_start), so
 *   they cover the current session's recent history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Checkpoint {
  leafId: string;
  prompt: string;
  timestamp: number;
  stashSha: string | null; // null = working tree was clean at HEAD
}

const PREVIEW_LEN = 80;

function firstLine(text: string): string {
  const flat = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN - 1) + "…" : flat;
}

function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>(); // entryId -> checkpoint
  const gitRepoCache = new Map<string, boolean>(); // cwd -> is git repo

  async function isGitRepo(cwd: string): Promise<boolean> {
    const cached = gitRepoCache.get(cwd);
    if (cached !== undefined) return cached;
    const { code } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    gitRepoCache.set(cwd, code === 0);
    return code === 0;
  }

  // Snapshot the working tree right before the agent acts on a user prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return;

    let stashSha: string | null = null;
    try {
      if (await isGitRepo(ctx.cwd)) {
        const { stdout, code } = await pi.exec("git", ["stash", "create", "-u"], { cwd: ctx.cwd });
        if (code === 0) stashSha = stdout.trim() || null;
      }
    } catch {
      // Non-fatal: conversation rewind still works without code checkpoints.
    }

    checkpoints.set(leafId, {
      leafId,
      prompt: (event.prompt ?? "").trim(),
      timestamp: Date.now(),
      stashSha,
    });
  });

  pi.registerCommand("rewind", {
    description: "Rewind conversation + code to a previous prompt checkpoint",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("rewind requires interactive mode", "error");
        return;
      }

      await ctx.waitForIdle();

      // Only offer checkpoints still on the active branch (compaction/forks may
      // have moved entries off-branch; navigateTree can't reach those anyway).
      const branch = ctx.sessionManager.getBranch();
      const points: Checkpoint[] = [];
      for (const entry of branch) {
        const cp = checkpoints.get(entry.id);
        if (cp) points.push(cp);
      }
      if (points.length === 0) {
        ctx.ui.notify("No rewind points yet — send a prompt first.", "warning");
        return;
      }
      points.reverse(); // newest first

      const inGit = await isGitRepo(ctx.cwd).catch(() => false);
      const now = Date.now();

      // Build unique display strings and a display->checkpoint map. Collisions
      // (e.g. the same prompt sent twice) get a short entry-id suffix.
      const displayToCp = new Map<string, Checkpoint>();
      const items: string[] = [];
      for (const cp of points) {
        const mark = inGit ? (cp.stashSha ? "●" : "○") : "·";
        const kind = inGit ? (cp.stashSha ? "code+chat" : "chat") : "chat only";
        let label = `${mark} ${timeAgo(cp.timestamp, now).padEnd(9)}[${kind.padEnd(9)}] ${
          firstLine(cp.prompt) || "(empty prompt)"
        }`;
        if (displayToCp.has(label)) label = `${label} · ${cp.leafId.slice(-6)}`;
        displayToCp.set(label, cp);
        items.push(label);
      }

      const choice = await ctx.ui.select("Rewind to…", items);
      if (!choice) return; // cancelled

      const target = displayToCp.get(choice);
      if (!target) {
        ctx.ui.notify("Rewind point not found.", "error");
        return;
      }

      // Decide scope. In a git repo, let the user choose code+chat vs chat-only;
      // outside git, only conversation rewind is available.
      let restoreCode = false;
      if (inGit) {
        const scope = await ctx.ui.select("Rewind scope", [
          "Rewind code + conversation",
          "Rewind conversation only",
          "Cancel",
        ]);
        if (!scope || scope === "Cancel") return;
        restoreCode = scope === "Rewind code + conversation";
      } else {
        ctx.ui.notify("Not a git repo — rewinding conversation only.", "info");
      }

      if (restoreCode) {
        try {
          const safety = await pi.exec("git", ["stash", "create", "-u"], { cwd: ctx.cwd });
          const safetySha = safety.code === 0 ? safety.stdout.trim() : "";

          await pi.exec("git", ["reset", "--hard", "HEAD"], { cwd: ctx.cwd });

          if (target.stashSha) {
            const apply = await pi.exec("git", ["stash", "apply", target.stashSha], { cwd: ctx.cwd });
            if (apply.code !== 0) {
              ctx.ui.notify(`Code restore reported conflicts: ${apply.stderr.trim()}`, "warning");
            }
          }

          const recover = safetySha
            ? ` Recover with: git stash apply ${safetySha}`
            : " (tree was clean)";
          ctx.ui.notify(`Code rewound.${recover}`, "info");
        } catch (err) {
          ctx.ui.notify(`Code restore failed: ${(err as Error).message}`, "error");
        }
      }

      // Conversation rewind: move the leaf to this prompt. The abandoned branch
      // stays reachable via /tree. summarize:false keeps it lossless.
      const result = await ctx.navigateTree(target.leafId, { summarize: false });
      if (result.cancelled) {
        ctx.ui.notify("Rewind cancelled.", "info");
        return;
      }

      // Drop the original prompt back in the editor so it can be edited/resubmitted.
      ctx.ui.setEditorText(target.prompt);
      ctx.ui.notify("Rewound. Edit & resubmit, or type something new.", "info");
    },
  });
}
