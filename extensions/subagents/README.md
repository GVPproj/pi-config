# Owned worker bridge

Import from `extensions/subagents/index.ts` (or `src/client.ts`):

```ts
const workers = await getSubagentManager(pi); // after session_start
const owner: SubagentOwner = {
  id: runId,
  onSettled(snapshot) {
    /* persist/enqueue owner processing; keep synchronous */
  },
};
const worker = await workers.spawnOwned(
  {
    prompt,
    title,
    cwd,
    execution: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    },
    readOnly: false,
  },
  owner,
);
```

`SubagentClient`:

- `spawnOwned(task: OwnedSubagentTask, owner: SubagentOwner): Promise<SubagentSnapshot>`
- `sendOwned(owner, id, text): Promise<void>` — steer running work or continue settled work, using the same session and approved execution choice.
- `cancelOwned(owner, ids): Promise<readonly CancelResult[]>` — validates all IDs before cancelling any; waits for settlement.
- `get(id): SubagentSnapshot | undefined`, `list(): readonly SubagentSnapshot[]` — detached snapshots.
- `subscribe(listener: () => void): () => void` — any-change notification; returns unsubscribe.
- `openWorker(ctx: ExtensionCommandContext, id): Promise<void>` — TUI inspection/emergency abort, not permission to restart owned work.

The bridge resolves the **existing extension manager/runtime**, via the session's Pi event bus. It creates no independent manager. Ordinary and owned children share the four-running-child ceiling. Capacity errors reject; the orchestrator owns queueing and may retry after a change notification. Handles become invalid on shutdown/reload; acquire a new handle and reconcile retained artifacts explicitly.

Keep the owner object private and reuse its **object identity**, not merely its ID. Ordinary takeover cannot send to owned workers (including running ones); owner code uses `sendOwned`. Ordinary emergency cancellation remains available and still delivers the result exclusively to the owner. No ownership transfer is implicit.

`onSettled` receives one detached structured snapshot per run, including failures, cancellation, and shutdown. `outcome` distinguishes `Completed`, `Failed`, and `Interrupted`; interrupted workers retain the existing `status: "error"` UI convention. `execution` records the approved choice; `meta.modelLabel`, `meta.thinkingLevel`, and `meta.sessionFilePath` record actual execution/session provenance. Full transcripts remain in session files; in-memory output/transcripts have existing bounds. Owner callback exceptions never fall back to ordinary delivery. Persist results promptly: the existing 64-entry settled-history pruning still applies.

Model and thinking choices are required, copied at submission, and never inherited from later parent changes. Missing models/authentication and unsupported thinking levels reject rather than silently substituting. The bridge resolves cwd/trust/model-registry context from its parent session; callers supply no parent conversation.

`readOnly` removes/blocks `edit` and `write`. **Bash and custom tools are not sandboxed.** All children exclude parent orchestration extension entry points before factory loading (including canonical symlink paths), and block `subagent_*`, `bg_*`, `orchestrator[_*]`, and `orchestrate[_*]` tools, including late activation. Name new orchestration entry points/tools accordingly.
