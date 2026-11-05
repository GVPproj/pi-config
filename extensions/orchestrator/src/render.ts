import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

export function renderWidget(lines: string[], theme: Theme) {
  return {
    render(width: number) {
      return lines.map((line, index) =>
        truncateToWidth(
          index === 0
            ? theme.fg("accent", theme.bold(line))
            : index === lines.length - 1
              ? theme.fg("dim", line)
              : line,
          width,
        ),
      );
    },
    invalidate() {},
  };
}

/** Plain text is also the fallback for RPC, exports, and model context. */
export interface DisplayDetails {
  summary: string;
  expanded: string;
}

// Older Pi releases do not yet inject configured keybinding helpers.
export function expansionHint(context: unknown, label: string): string {
  const hint = (context as { keyHint?: (key: string, label: string) => string })
    .keyHint;
  return hint ? hint("app.tools.expand", label) : `Expand ${label}`;
}

export function renderCard(
  text: string,
  theme: Theme,
  padding = 0,
  hint?: string,
) {
  // Never let issue titles, worker feedback or artifact paths emit terminal controls.
  const safe = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const lines = safe.split("\n").map((line, index) => {
    if (index === 0) return theme.fg("accent", theme.bold(line));
    if (/^[^\s].*:$/.test(line)) return theme.bold(line);
    if (/blocked|failed|timed out/i.test(line))
      return theme.fg("warning", line);
    if (/^\s*(?:✓|Passed:|Verified:)/.test(line))
      return theme.fg("success", line);
    if (/^\s*(?:Run:|Source:|Workspace:|Artifacts:|Branch:)/.test(line))
      return theme.fg("dim", line);
    return line;
  });
  if (hint) lines.push(theme.fg("dim", hint));
  return new Text(lines.join("\n"), padding, 0);
}
