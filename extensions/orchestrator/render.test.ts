import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderCard, renderWidget } from "./src/render.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as Theme;

test("live widget never grows taller at narrow widths", () => {
  const lines = [
    "Orchestrator · Running",
    "● issue-2485 · Repairing " + "wide 修正 ".repeat(100),
    "Status for details",
  ];
  const widget = renderWidget(lines, theme);
  for (const width of [12, 30, 80]) {
    assert.equal(widget.render(width).length, lines.length);
    assert.ok(
      widget.render(width).every((line) => visibleWidth(line) <= width),
    );
  }
});

test("cards wrap narrow terminals, unicode and long evidence paths", () => {
  const card = renderCard(
    "Orchestrator · 修正\nWorkspace: /a/very/long/" + "path/".repeat(30),
    theme,
    1,
    "ctrl+o for details",
  );
  for (const width of [12, 30, 80, 120]) {
    const lines = card.render(width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  card.invalidate();
  assert.ok(card.render(30).join("\n").includes("ctrl+o"));
});
