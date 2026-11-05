import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

type Callback = (...args: any[]) => any;
function harness() {
  const messages = new Map<string, Callback>();
  const events = new Map<string, Callback>();
  let tool: any;
  let command: any;
  extension({
    registerMessageRenderer: (name: string, renderer: Callback) =>
      messages.set(name, renderer),
    on: (name: string, handler: Callback) => events.set(name, handler),
    registerTool: (definition: any) => {
      tool = definition;
    },
    registerCommand: (_name: string, definition: any) => {
      command = definition;
    },
  } as unknown as ExtensionAPI);
  return { messages, events, tool, command };
}
const theme = {
  fg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const options = {
  expanded: false,
  outputPad: 0,
  keyHint: () => "custom-key for details",
};
const text = (component: any) => component.render(100).join("\n");

test("tool and progress renderers show readable summaries with opt-in evidence", () => {
  const { tool, messages } = harness();
  const display = {
    summary: "Orchestrator · Reviewing",
    expanded: "Evidence\nWorkspace: /retained/job",
  };
  const result = {
    content: [{ type: "text", text: "model context" }],
    details: { display },
  };
  const collapsed = text(tool.renderResult(result, options, theme, options));
  assert.match(collapsed, /Reviewing/);
  assert.match(collapsed, /custom-key/);
  assert.doesNotMatch(collapsed, /retained/);
  assert.match(
    text(
      tool.renderResult(result, { ...options, expanded: true }, theme, options),
    ),
    /retained/,
  );
  const render = messages.get("orchestrator-progress")!;
  assert.match(
    text(
      render({ content: display.summary, details: display }, options, theme),
    ),
    /Reviewing/,
  );
  assert.match(
    text(
      render(
        { content: display.summary, details: display },
        { ...options, expanded: true },
        theme,
      ),
    ),
    /retained/,
  );
});

test("errors and historical messages without display metadata remain visible", () => {
  const { tool, messages } = harness();
  assert.match(
    text(
      tool.renderResult(
        { content: [{ type: "text", text: "Approval rejected" }] },
        options,
        theme,
        options,
      ),
    ),
    /Approval rejected/,
  );
  assert.match(
    text(
      messages.get("orchestrator-progress")!(
        { content: "Historical update" },
        options,
        theme,
      ),
    ),
    /Historical update/,
  );
});

test("shutdown clears both live surfaces and command completion includes status", async () => {
  const { events, command } = harness();
  const cleared: string[] = [];
  events.get("session_start")!(
    {},
    {
      ui: {
        setStatus: (key: string, value: unknown) => {
          if (value === undefined) cleared.push(`status:${key}`);
        },
        setWidget: (key: string, value: unknown) => {
          if (value === undefined) cleared.push(`widget:${key}`);
        },
      },
    },
  );
  await events.get("session_shutdown")!();
  assert.deepEqual(cleared, ["status:orchestrator", "widget:orchestrator"]);
  assert.deepEqual(command.getArgumentCompletions("sta"), [
    { value: "status", label: "status" },
  ]);
});
