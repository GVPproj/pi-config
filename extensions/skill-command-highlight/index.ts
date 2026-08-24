import {
  CustomEditor,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";

class SkillCommandEditor extends CustomEditor {
  private highlightTheme?: Theme;

  setHighlightTheme(theme: Theme): void {
    this.highlightTheme = theme;
  }

  render(width: number): string[] {
    return super
      .render(width)
      .map((line) =>
        line.replace(
          /(\/skill:)([a-z0-9-]*)/gi,
          (_match, prefix, name) =>
            (this.highlightTheme?.fg("syntaxKeyword", prefix) ?? prefix) +
            (this.highlightTheme?.fg("syntaxFunction", name) ?? name),
        ),
      );
  }
}

export default function skillCommandHighlight(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new SkillCommandEditor(tui, theme, keybindings);
      editor.setHighlightTheme(ctx.ui.theme);
      return editor;
    });
  });
}
