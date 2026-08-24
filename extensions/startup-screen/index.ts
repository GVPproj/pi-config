import {
  keyText,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MIN_CARD_WIDTH = 32;
const TWO_COLUMN_WIDTH = 76;
const MAX_CARD_WIDTH = 104;
const RECENT_SESSION_COUNT = 2;

type Alignment = "left" | "center";

type HeaderState = {
  activeTools: number;
  modelName: string;
  provider: string;
  recentSessions: SessionInfo[];
};

function safeInlineText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relativeTime(date: Date, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (elapsedSeconds < 60) return "now";

  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fit(
  text: string,
  width: number,
  alignment: Alignment = "left",
): string {
  if (width <= 0) return "";
  const fitted = truncateToWidth(text, width, "");
  const remaining = Math.max(0, width - visibleWidth(fitted));
  if (alignment === "center") {
    const left = Math.floor(remaining / 2);
    return `${" ".repeat(left)}${fitted}${" ".repeat(remaining - left)}`;
  }
  return `${fitted}${" ".repeat(remaining)}`;
}

function sessionLabel(session: SessionInfo): string {
  return safeInlineText(
    session.name || session.firstMessage || "Untitled session",
  );
}

function loadRecentSessions(ctx: ExtensionContext): Promise<SessionInfo[]> {
  const currentFile = ctx.sessionManager.getSessionFile();
  return SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()).then(
    (sessions) =>
      sessions
        .filter(
          (session) => session.path !== currentFile && session.messageCount > 0,
        )
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, RECENT_SESSION_COUNT),
    () => [],
  );
}

function getPeaceSign(theme: Theme): string[] {
  const art = [
    "     _    (^)",
    "    (_\\   |_|",
    "     \\_\\  |_|",
    "     _\\_\\,/_|",
    "    (`\\(_|`\\|",
    "   (`\\,)  \\ \\",
    "    \\,)   | |",
    "      \\__(__|",
  ];
  const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
  const canvasWidth = artWidth + 4;

  // The header centers each line independently. Pad the artwork so its
  // variable-width lines retain their intended shared alignment. A slightly
  // wider canvas nudges the hand left without moving the model label.
  return art.map((line) => theme.fg("accent", line.padEnd(canvasWidth)));
}

function getLeftLines(theme: Theme, state: HeaderState): string[] {
  return [
    ...getPeaceSign(theme),
    "",
    theme.fg("accent", theme.bold(state.modelName)),
    theme.fg("muted", state.provider),
  ];
}

function getRightLines(
  theme: Theme,
  state: HeaderState,
  width: number,
): string[] {
  const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
  const lines = [
    theme.fg("warning", theme.bold("Tips")),
    `${theme.fg("accent", "/")}  for commands`,
    `${theme.fg("accent", "!")}  to run bash`,
    `${theme.fg("accent", keyText("app.thinking.cycle"))}  cycle thinking`,
    rule,
    theme.fg("warning", theme.bold("Loaded")),
    `${theme.fg("success", "✓")} ${state.activeTools} active tools`,
    rule,
    theme.fg("warning", theme.bold("Recent sessions")),
  ];

  if (state.recentSessions.length === 0) {
    lines.push(theme.fg("dim", "• none yet"));
    return lines;
  }

  for (const session of state.recentSessions) {
    const suffix = ` (${relativeTime(session.modified)})`;
    const labelWidth = Math.max(1, width - visibleWidth(suffix) - 2);
    const label = truncateToWidth(sessionLabel(session), labelWidth, "…");
    lines.push(
      `${theme.fg("dim", "•")} ${theme.fg("accent", label)}${theme.fg("dim", suffix)}`,
    );
  }
  return lines;
}

function topBorder(theme: Theme, width: number): string {
  const title = theme.fg("accent", theme.bold("pi agent"));
  const trailingRule = Math.max(0, width - 13);
  return `${theme.fg("border", "╭─ ")}${title} ${theme.fg("border", `${"─".repeat(trailingRule)}╮`)}`;
}

function bottomBorder(theme: Theme, width: number): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function renderTwoColumns(
  theme: Theme,
  state: HeaderState,
  width: number,
): string[] {
  const innerWidth = width - 2;
  const leftWidth = Math.min(48, Math.floor((innerWidth - 1) * 0.5));
  const rightWidth = innerWidth - leftWidth - 1;
  const left = getLeftLines(theme, state);
  const right = getRightLines(theme, state, rightWidth - 2);
  const rowCount = Math.max(left.length, right.length);
  const leftOffset = Math.floor((rowCount - left.length) / 2);
  const rightOffset = Math.floor((rowCount - right.length) / 2);
  const border = (text: string) => theme.fg("border", text);
  const lines = [topBorder(theme, width)];

  for (let index = 0; index < rowCount; index++) {
    lines.push(
      border("│") +
        fit(left[index - leftOffset] ?? "", leftWidth, "center") +
        border("│") +
        fit(` ${right[index - rightOffset] ?? ""}`, rightWidth) +
        border("│"),
    );
  }

  lines.push(
    border("╰") +
      border("─".repeat(leftWidth)) +
      border("┴") +
      border("─".repeat(rightWidth)) +
      border("╯"),
  );
  return lines;
}

function renderStacked(
  theme: Theme,
  state: HeaderState,
  width: number,
): string[] {
  const innerWidth = width - 2;
  const border = (text: string) => theme.fg("border", text);
  const lines = [topBorder(theme, width)];

  for (const line of getLeftLines(theme, state)) {
    lines.push(
      `${border("│")}${fit(line, innerWidth, "center")}${border("│")}`,
    );
  }

  lines.push(`${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`);
  for (const line of getRightLines(theme, state, innerWidth - 2)) {
    lines.push(`${border("│")}${fit(` ${line}`, innerWidth)}${border("│")}`);
  }
  lines.push(bottomBorder(theme, width));
  return lines;
}

function renderHeader(
  theme: Theme,
  state: HeaderState,
  availableWidth: number,
): string[] {
  if (availableWidth < MIN_CARD_WIDTH) {
    return [
      truncateToWidth(
        theme.fg("accent", theme.bold("(^) pi agent")),
        availableWidth,
        "",
      ),
    ];
  }

  const width = Math.min(availableWidth, MAX_CARD_WIDTH);
  return width >= TWO_COLUMN_WIDTH
    ? renderTwoColumns(theme, state, width)
    : renderStacked(theme, state, width);
}

export default function startupScreenExtension(pi: ExtensionAPI) {
  let state: HeaderState = {
    activeTools: 0,
    modelName: "No model selected",
    provider: "",
    recentSessions: [],
  };

  const updateModel = (ctx: ExtensionContext) => {
    state = {
      ...state,
      activeTools: pi.getActiveTools().length,
      modelName: safeInlineText(
        ctx.model?.name || ctx.model?.id || "No model selected",
      ),
      provider: safeInlineText(ctx.model?.provider || ""),
    };
  };

  const installHeader = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width) => renderHeader(theme, state, width),
      invalidate() {},
    }));
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    updateModel(ctx);
    installHeader(ctx);
    state = { ...state, recentSessions: await loadRecentSessions(ctx) };
    installHeader(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateModel(ctx);
    installHeader(ctx);
  });
}
