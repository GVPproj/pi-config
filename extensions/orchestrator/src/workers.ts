import type { SubagentClient } from "../../subagents/src/client.ts";
import type {
  SubagentOwner,
  SubagentSnapshot,
  ThinkingLevel,
} from "../../subagents/src/domain.ts";
import type { Workers } from "./domain.ts";

/** Uses only the existing manager; completion has exactly one owner. */
export function sharedWorkers(client: SubagentClient): Workers {
  const retained = new Map<
    string,
    {
      owner: SubagentOwner;
      id?: string;
      deliver: (snapshot: SubagentSnapshot) => void;
    }
  >();
  return {
    async run(input, signal) {
      signal.throwIfAborted();
      let settle!: (value: SubagentSnapshot) => void;
      const result = new Promise<SubagentSnapshot>((resolve) => {
        settle = resolve;
      });
      const key = `${input.owner}:${input.role}`;
      let connection = input.role === "review" ? undefined : retained.get(key);
      if (!connection) {
        const entry = {
          owner: {
            id: input.owner,
            onSettled: (snapshot: SubagentSnapshot) => entry.deliver(snapshot),
          },
          deliver: settle,
          id: undefined as string | undefined,
        };
        connection = entry;
        if (input.role !== "review") retained.set(key, entry);
      }
      connection.deliver = settle;
      const owner = connection.owner;
      const previous = connection.id ? client.get(connection.id) : undefined;
      if (previous?.status === "running")
        throw new Error(
          "Owned worker is still running; a second writer is forbidden",
        );
      let snapshot: SubagentSnapshot | undefined;
      while (!snapshot) {
        signal.throwIfAborted();
        let changed!: () => void;
        const change = new Promise<void>((resolve) => {
          changed = resolve;
        });
        const unsubscribe = client.subscribe(changed);
        signal.addEventListener("abort", changed, { once: true });
        try {
          if (client.availableSlots() === 0) {
            await change;
            continue;
          }
          const slash = input.model.model.indexOf("/");
          if (slash < 1)
            throw new Error("Approved models must use provider/model-id");
          try {
            if (previous) {
              await client.sendOwned(owner, previous.id, input.prompt);
              snapshot = client.get(previous.id);
              if (!snapshot)
                throw new Error(
                  "Retained worker disappeared during continuation",
                );
            } else
              snapshot = await client.spawnOwned(
                {
                  prompt: input.prompt,
                  title: `${input.role}: ${input.owner}`,
                  cwd: input.cwd,
                  execution: {
                    model: {
                      provider: input.model.model.slice(0, slash),
                      id: input.model.model.slice(slash + 1),
                    },
                    thinkingLevel: input.model.thinking as ThinkingLevel,
                  },
                  readOnly: input.role === "review",
                },
                owner,
              );
          } catch (error) {
            if (client.availableSlots() === 0) {
              await change;
              continue;
            }
            throw error;
          }
        } finally {
          unsubscribe();
          signal.removeEventListener("abort", changed);
        }
      }
      connection.id = snapshot.id;
      try {
        input.onStart(snapshot.id, snapshot.meta.sessionFilePath);
      } catch (error) {
        await client.cancelOwned(owner, [snapshot.id]);
        throw error;
      }
      let cancellation: Promise<unknown> | undefined;
      const abort = () => {
        cancellation ??= client.cancelOwned(owner, [snapshot!.id]);
        void cancellation.catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const finished = await result;
        if (cancellation) await cancellation;
        // Return cancelled evidence too; the orchestrator persists it before
        // honoring its abort signal. Partial output never becomes success.
        return {
          id: finished.id,
          session: finished.meta.sessionFilePath,
          model: {
            model: finished.meta.modelLabel ?? "unknown",
            thinking: finished.meta.thinkingLevel ?? "off",
          },
          status:
            finished.status === "done" && finished.outcome === "Completed"
              ? "done"
              : "error",
          text:
            finished.status === "done"
              ? finished.finalText
              : (finished.errorText ?? "Worker failed"),
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
