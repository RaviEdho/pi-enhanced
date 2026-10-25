import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";

export interface DiscordAccessPaths {
  allowDirectMessages: boolean;
  allowServerMessages: boolean;
}

export class DiscordToggleDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: any;
  private readonly onDone: (values: DiscordAccessPaths | undefined) => void;
  private readonly keybindings: any;
  private allowDirectMessages: boolean;
  private allowServerMessages: boolean;
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: any,
    initialValues: DiscordAccessPaths,
    onDone: (values: DiscordAccessPaths | undefined) => void,
    keybindings?: any
  ) {
    this.tui = tui;
    this.theme = theme;
    this.allowDirectMessages = initialValues.allowDirectMessages;
    this.allowServerMessages = initialValues.allowServerMessages;
    this.onDone = onDone;
    this.keybindings = keybindings;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
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
      this.selectedIndex = (this.selectedIndex + 2) % 3;
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "down") || data.toLowerCase() === "j" || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % 3;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "space") || data === " ") {
      this.toggleSelectedPath();
      return true;
    }
    if (matchesKey(data, "enter")) {
      if (this.selectedIndex < 2) this.toggleSelectedPath();
      else this.onDone({
        allowDirectMessages: this.allowDirectMessages,
        allowServerMessages: this.allowServerMessages,
      });
      return true;
    }

    return false;
  }

  private toggleSelectedPath(): void {
    if (this.selectedIndex === 0) this.allowDirectMessages = !this.allowDirectMessages;
    else if (this.selectedIndex === 1) this.allowServerMessages = !this.allowServerMessages;
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const accent = (value: string) => this.theme?.fg ? this.theme.fg("accent", value) : value;
    const border = (value: string) => this.theme?.fg ? this.theme.fg("border", value) : value;
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const muted = (value: string) => this.theme?.fg ? this.theme.fg("muted", value) : value;
    const bold = (value: string) => this.theme?.bold ? this.theme.bold(value) : value;
    const stateColor = (enabled: boolean, value: string) => this.theme?.fg
      ? this.theme.fg(enabled ? "success" : "warning", value)
      : value;

    const title = "Discord Access Paths";
    const header = `${border("── ")}${bold(accent(title))} `;
    const headerWidth = visibleWidth(`── ${title} `);
    const fillCount = Math.max(1, width - headerWidth - 2);
    const lines = [`${header}${border("─".repeat(fillCount))}${border("──")}`, ""];
    for (const line of wrapTextWithAnsi("Choose which Discord routes the gateway accepts. Enter or Space toggles a path.", Math.max(10, width - 4))) {
      lines.push(`  ${text(line)}`);
    }
    lines.push("");

    const options = [
      { label: "DM access", enabled: this.allowDirectMessages },
      { label: "Server access", enabled: this.allowServerMessages },
      { label: "Save access paths", enabled: undefined },
    ];
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const prefix = index === this.selectedIndex ? `${accent("→")} ` : "  ";
      const label = index === this.selectedIndex ? bold(accent(option.label)) : text(option.label);
      const state = option.enabled === undefined ? "" : `  ${stateColor(option.enabled, option.enabled ? "On" : "Off")}`;
      lines.push(`  ${prefix}${label}${state}`);
    }

    lines.push("");
    const hints = [
      rawKeyHint("↑↓", "navigate"),
      rawKeyHint("Space", "toggle"),
      keyHint("tui.select.confirm", "toggle/save"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");
    lines.push(`  ${muted(hints)}`);
    lines.push("");
    lines.push(border("─".repeat(Math.max(1, width))));
    return lines;
  }
}
