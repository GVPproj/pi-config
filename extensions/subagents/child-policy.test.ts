import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChildToolPolicy,
  isChildExcludedToolName,
} from "./src/child-policy.ts";

test("every subagent_* and bg_* tool is excluded, including future names", () => {
  for (const name of [
    "subagent_spawn",
    "subagent_future_tool",
    "bg_start",
    "bg_future_tool",
  ]) {
    assert.equal(isChildExcludedToolName(name), true, name);
  }
  for (const name of [
    "read",
    "bash",
    "edit",
    "write",
    "custom_workspace_tool",
  ]) {
    assert.equal(isChildExcludedToolName(name), false, name);
  }
});

test("tool policy preserves full workspace tools without creating an allowlist", () => {
  let selected: string[] = [];
  applyChildToolPolicy({
    getActiveToolNames: () => [
      "read",
      "bash",
      "edit",
      "write",
      "custom_workspace_tool",
      "subagent_spawn",
      "subagent_new",
      "bg_start",
      "bg_new",
    ],
    setActiveToolsByName: (names) => {
      selected = names;
    },
  });
  assert.deepEqual(selected, [
    "read",
    "bash",
    "edit",
    "write",
    "custom_workspace_tool",
  ]);
});
