import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";

export interface DiscordSelectDialogOptions {
  title: string;
  description?: string;
  options: string[];
}

export class DiscordSelectDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: any;
  private readonly options: DiscordSelectDialogOptions;
  private readonly onDone: (choice: string | undefined) => void;
  private readonly keybindings: any;
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: any,
    options: DiscordSelectDialogOptions,
    onDone: (choice: string | undefined) => void,
    keybindings?: any
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.onDone = onDone;
    this.keybindings = keybindings;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      this.onDone(this.options.options[this.selectedIndex]);
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
      this.onDone(undefined);
      return true;
    }

    if (matchesKey(data, "up") || data.toLowerCase() === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + this.options.options.length) % this.options.options.length;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down") || data.toLowerCase() === "j" || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % this.options.options.length;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const accent = (value: string) => this.theme?.fg ? this.theme.fg("accent", value) : value;
    const border = (value: string) => this.theme?.fg ? this.theme.fg("border", value) : value;
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const muted = (value: string) => this.theme?.fg ? this.theme.fg("muted", value) : value;
    const bold = (value: string) => this.theme?.bold ? this.theme.bold(value) : value;

    const header = `${border("── ")}${bold(accent(this.options.title))} `;
    const headerWidth = visibleWidth(`── ${this.options.title} `);
    const fillCount = Math.max(1, width - headerWidth - 2);
    const lines = [`${header}${border("─".repeat(fillCount))}${border("──")}`, ""];
    if (this.options.description) {
      for (const line of wrapTextWithAnsi(this.options.description, Math.max(10, width - 4))) {
        lines.push(`  ${text(line)}`);
      }
      lines.push("");
    }

    for (let index = 0; index < this.options.options.length; index++) {
      const option = this.options.options[index];
      if (index === this.selectedIndex) {
        lines.push(`  ${accent("→")} ${bold(accent(option))}`);
      } else {
        lines.push(`    ${text(option)}`);
      }
    }

    lines.push("");
    const hints = [
      rawKeyHint("↑↓", "navigate"),
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");
    lines.push(`  ${muted(hints)}`);
    lines.push("");
    lines.push(border("─".repeat(Math.max(1, width))));
    return lines;
  }
}
