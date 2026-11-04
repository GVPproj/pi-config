import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  OwnedSpawnTask,
  SubagentOwner,
  SubagentSnapshot,
} from "./domain.ts";
import type { CancelResult } from "./manager.ts";

export type OwnedSubagentTask = Omit<OwnedSpawnTask, "parent">;

/** Session-scoped facade over the SAME manager used by subagent_* and /subagents. */
export interface SubagentClient {
  spawnOwned(
    task: OwnedSubagentTask,
    owner: SubagentOwner,
  ): Promise<SubagentSnapshot>;
  sendOwned(owner: SubagentOwner, id: string, text: string): Promise<void>;
  cancelOwned(
    owner: SubagentOwner,
    ids: readonly string[],
  ): Promise<readonly CancelResult[]>;
  get(id: string): SubagentSnapshot | undefined;
  list(): readonly SubagentSnapshot[];
  availableSlots(): number;
  subscribe(listener: () => void): () => void;
  /** Inspection and emergency abort; does not authorize restarting owned work. */
  openWorker(ctx: ExtensionCommandContext, id: string): Promise<void>;
}

// An event handshake avoids module singleton identity assumptions under Pi's
// extension loader, and scopes discovery to this session's event bus.
export const SUBAGENT_CLIENT_REQUEST = "subagents:get-manager:v1";
export interface SubagentClientRequest {
  respond(client: Promise<SubagentClient>): void;
}

/** Call after session_start. Rejects immediately if subagents is not loaded/active. */
export function getSubagentManager(
  pi: Pick<ExtensionAPI, "events">,
): Promise<SubagentClient> {
  let response: Promise<SubagentClient> | undefined;
  pi.events.emit(SUBAGENT_CLIENT_REQUEST, {
    respond(client) {
      response = client;
    },
  } satisfies SubagentClientRequest);
  return (
    response ??
    Promise.reject(
      new Error("Subagent manager is unavailable in this session."),
    )
  );
}
