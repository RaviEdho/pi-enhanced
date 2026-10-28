import type { Component, TUI } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

export class DiscordInputDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: any;
  private readonly title: string;
  private readonly instruction: string;
  private readonly input: Input;
  private readonly onDone: (value: string | undefined) => void;
  private readonly keybindings: any;

  constructor(
    tui: TUI,
    theme: any,
    title: string,
    instruction: string,
    initialValue: string,
    placeholder: string,
    onDone: (value: string | undefined) => void,
    keybindings?: any
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.instruction = instruction;
    this.onDone = onDone;
    this.keybindings = keybindings;
    this.input = new Input({
      prompt: this.theme?.fg ? this.theme.fg("accent", "❯ ") : "❯ ",
      placeholder,
      placeholderStyle: (value) => this.theme?.fg ? this.theme.fg("muted", value) : value,
    });
    this.input.setValue(initialValue);
    this.input.focused = true;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      this.onDone(this.input.getValue());
      return true;
    }

    if (
      matchesKey(data, "escape") ||
      data === "\x03" ||
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

    this.input.handleInput(data);
    this.tui.requestRender();
    return true;
  }

  render(width: number): string[] {
    const accent = (value: string) => this.theme?.fg ? this.theme.fg("accent", value) : value;
    const border = (value: string) => this.theme?.fg ? this.theme.fg("border", value) : value;
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const muted = (value: string) => this.theme?.fg ? this.theme.fg("muted", value) : value;
    const bold = (value: string) => this.theme?.bold ? this.theme.bold(value) : value;

    const header = truncateToWidth(`${border("── ")}${bold(accent(this.title))} `, width);
    const lines = [`${header}${border("─".repeat(Math.max(0, width - visibleWidth(header))))}`];
    const contentWidth = Math.max(1, width - 4);

    for (const line of wrapTextWithAnsi(this.instruction, contentWidth)) {
      lines.push(`  ${text(line)}`);
    }
    lines.push("");
    lines.push(...this.input.render(contentWidth).map((line) => `  ${line}`));
    lines.push("");
    const hints = `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`;
    lines.push(...wrapTextWithAnsi(hints, contentWidth).map((line) => `  ${muted(line)}`));
    lines.push(border("─".repeat(Math.max(0, width))));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
