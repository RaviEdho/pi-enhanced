import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";

const SECTION_HEADINGS = new Set(["ACCESS", "UNATTENDED TOOLS", "WORKSPACE", "SECURITY"]);

export interface DiscordConfirmationDialogOptions {
  title: string;
  content: string[];
  highlightedLines?: string[];
  confirmLabel: string;
  rejectLabel: string;
}

export class DiscordConfirmationDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: any;
  private readonly title: string;
  private readonly content: string[];
  private readonly highlightedLines: Set<string>;
  private readonly actions: [string, string];
  private readonly onDone: (approved: boolean) => void;
  private readonly keybindings: any;
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: any,
    options: DiscordConfirmationDialogOptions,
    onDone: (approved: boolean) => void,
    keybindings?: any
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = options.title;
    this.content = options.content;
    this.highlightedLines = new Set(options.highlightedLines || []);
    this.actions = [options.confirmLabel, options.rejectLabel];
    this.onDone = onDone;
    this.keybindings = keybindings;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      this.onDone(this.selectedIndex === 0);
      return true;
    }

    if (
      matchesKey(data, "escape") ||
      data === "\x03" ||
      data.toLowerCase() === "q" ||
      (this.keybindings && typeof this.keybindings.matches === "function" && (
        this.keybindings.matches(data, "app.interrupt") ||
        this.keybindings.matches(data, "app.clear") ||
        this.keybindings.matches(data, "tui.select.cancel") ||
        this.keybindings.matches(data, "cancel")
      ))
    ) {
      this.onDone(false);
      return true;
    }

    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const accent = (value: string) => this.theme?.fg ? this.theme.fg("accent", value) : value;
    const border = (value: string) => this.theme?.fg ? this.theme.fg("border", value) : value;
    const warning = (value: string) => this.theme?.fg ? this.theme.fg("warning", value) : value;
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const muted = (value: string) => this.theme?.fg ? this.theme.fg("muted", value) : value;
    const bold = (value: string) => this.theme?.bold ? this.theme.bold(value) : value;

    const header = truncateToWidth(`${border("── ")}${bold(accent(this.title))} `, width);
    const lines = [`${header}${border("─".repeat(Math.max(0, width - visibleWidth(header))))}`];
    const contentWidth = Math.max(1, width - 4);

    for (const contentLine of this.content) {
      if (!contentLine) {
        lines.push("");
        continue;
      }
      if (SECTION_HEADINGS.has(contentLine)) {
        lines.push(`  ${bold(accent(contentLine))}`);
        continue;
      }

      const color = this.highlightedLines.has(contentLine) ? warning : text;
      const wrapped = wrapTextWithAnsi(contentLine, contentWidth);
      for (const wrappedLine of wrapped) {
        lines.push(`  ${color(wrappedLine)}`);
      }
    }

    lines.push("");
    for (let index = 0; index < this.actions.length; index++) {
      if (index === this.selectedIndex) {
        lines.push(`  ${accent("→")} ${bold(accent(this.actions[index]))}`);
      } else {
        lines.push(`    ${text(this.actions[index])}`);
      }
    }

    lines.push("");
    const hints = [
      rawKeyHint("↑↓", "navigate"),
      keyHint("tui.select.confirm", "confirm"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");
    lines.push(...wrapTextWithAnsi(hints, contentWidth).map((line) => `  ${muted(line)}`));
    lines.push(border("─".repeat(Math.max(0, width))));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
