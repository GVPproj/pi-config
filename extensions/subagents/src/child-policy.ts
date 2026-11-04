import { realpathSync } from "node:fs";

/** Filter before loading factories: dropping loaded hooks is already too late. */
export function isChildExcludedExtension(file: string) {
  const parentOnly =
    /(?:^|[/\\\\])(?:orchestrator|subagents|background-terminals)(?:[/\\\\]|\.[cm]?[jt]s$|$)/;
  if (parentOnly.test(file)) return true;
  try {
    return parentOnly.test(realpathSync(file));
  } catch {
    return true;
  }
}

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

export function isChildExcludedToolName(name: string, readOnly = false) {
  return (
    name.startsWith("subagent_") ||
    name.startsWith("bg_") ||
    name === "orchestrator" ||
    name.startsWith("orchestrator_") ||
    name === "orchestrate" ||
    name.startsWith("orchestrate_") ||
    (readOnly && (name === "edit" || name === "write"))
  );
}

/** Preserve the child's current tool selection while stripping every
 * orchestration/terminal tool, including dynamically registered names. */
export function applyChildToolPolicy(
  session: {
    getActiveToolNames(): string[];
    setActiveToolsByName(toolNames: string[]): void;
  },
  readOnly = false,
) {
  session.setActiveToolsByName(
    session
      .getActiveToolNames()
      .filter((name) => !isChildExcludedToolName(name, readOnly)),
  );
}
