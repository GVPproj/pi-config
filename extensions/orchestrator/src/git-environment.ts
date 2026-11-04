import { devNull } from "node:os";

// Keep SSH transport/authentication choices, but never inherit Git repository,
// index, object-store, replacement, or command-scope configuration overrides.
const transport = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"]);

export function gitEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") && !transport.has(key)) delete env[key];
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    // Environment configuration reaches Git children of gh/herdr as well as
    // direct Git commands, and overrides repository/global hooks settings.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
  };
}
