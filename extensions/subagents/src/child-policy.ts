export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "bg_start",
  "bg_status",
  "bg_list",
  "bg_kill",
] as const;

export function isChildExcludedToolName(name: string) {
  return name.startsWith("subagent_") || name.startsWith("bg_");
}

/** Preserve the child's current tool selection while stripping every
 * orchestration/terminal tool, including dynamically registered names. */
export function applyChildToolPolicy(session: {
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}) {
  session.setActiveToolsByName(
    session
      .getActiveToolNames()
      .filter((name) => !isChildExcludedToolName(name)),
  );
}
