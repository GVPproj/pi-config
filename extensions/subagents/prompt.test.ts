import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

test("spawn guidance defaults to inheritance and restricts explicit models", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");
  assert.match(guidance, /Omit model.*inherits the parent model/i);
  assert.match(guidance, /only when the user explicitly requested/i);
  assert.match(
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
    /only when the user explicitly requested/i,
  );
});

test("spawn description documents Pi-only execution and the four-agent cap", () => {
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /in-process Pi/i);
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /Max 4 subagents/i);
});
