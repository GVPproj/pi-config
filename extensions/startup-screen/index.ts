import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// Startup artwork adapted from davis7dotsh/my-pi-setup (MIT).
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

// Use semantic theme shades rather than the original fixed blue palette.
const SHADES = ["border", "accent", "mdHeading", "accent", "border"] as const;

function gradientText(text: string, theme: Theme, phase: number): string {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);
  return characters
    .map((character, index) => {
      const position = (index / span + phase) % 1;
      const shade = SHADES[Math.floor(position * SHADES.length)]!;
      return character === " " ? character : theme.fg(shade, character);
    })
    .join("");
}

function center(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width, "");
}

function formatDirectory(cwd: string): string {
  const home = homedir();
  const display =
    cwd === home
      ? "~"
      : cwd.startsWith(`${home}/`)
        ? `~/${relative(home, cwd)}`
        : cwd;
  return stripTerminalSequences(display).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    "",
  );
}

export default function startupScreenExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const directory = formatDirectory(ctx.cwd);

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return [
          "",
          ...TITLE_LINES.map((line, row) =>
            center(gradientText(line, theme, row * 0.045), width),
          ),
          center(theme.bold(gradientText(directory, theme, 0.18)), width),
          "",
        ];
      },
      invalidate() {},
    }));
  });
}
