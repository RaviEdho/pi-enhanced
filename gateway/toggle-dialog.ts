import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { DialogFrame } from "../ux/dialog.js";

export interface DiscordAccessPaths {
  allowDirectMessages: boolean;
  allowServerMessages: boolean;
}

export class DiscordToggleDialog implements Component {
  private readonly frame: DialogFrame;
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
    this.frame = new DialogFrame(tui, theme);
    this.tui = tui;
    this.theme = theme;
    this.allowDirectMessages = initialValues.allowDirectMessages;
    this.allowServerMessages = initialValues.allowServerMessages;
    this.onDone = onDone;
    this.keybindings = keybindings;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (this.frame.handleInput(data)) return true;

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
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const bold = (value: string) => this.theme?.bold ? this.theme.bold(value) : value;
    const stateColor = (enabled: boolean, value: string) => this.theme?.fg
      ? this.theme.fg(enabled ? "success" : "warning", value)
      : value;

    const actions: string[] = [];

    const options = [
      { label: "Direct messages", enabled: this.allowDirectMessages },
      { label: "Server messages", enabled: this.allowServerMessages },
      { label: "Save changes", enabled: undefined },
    ];
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const prefix = index === this.selectedIndex ? `${accent("→")} ` : "  ";
      const label = index === this.selectedIndex ? bold(accent(option.label)) : text(option.label);
      const state = option.enabled === undefined ? "" : `  ${stateColor(option.enabled, option.enabled ? "On" : "Off")}`;
      actions.push(`  ${prefix}${label}${state}`);
    }

    const hints = [
      rawKeyHint("↑↓", "navigate"),
      rawKeyHint("Space", "toggle"),
      keyHint("tui.select.confirm", "toggle/save"),
      keyHint("tui.select.cancel", "cancel"),
    ];
    return this.frame.render(width, {
      title: "Discord Message Access",
      content: [],
      actions,
      hints,
      actionFocusLine: this.selectedIndex,
    });
  }
}
