import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Input, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { DialogFrame } from "../ux/dialog.js";

export class DiscordInputDialog implements Component, Focusable {
  private readonly frame: DialogFrame;
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
    this.frame = new DialogFrame(tui, theme);
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

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): boolean {
    if (this.frame.handleInput(data)) return true;

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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.frame.handleMouse(event);
  }

  render(width: number): string[] {
    const text = (value: string) => this.theme?.fg ? this.theme.fg("text", value) : value;
    const contentWidth = Math.max(1, width - 4);
    const lines = wrapTextWithAnsi(this.instruction, contentWidth).map((line) => `  ${text(line)}`);
    const actions = this.input.render(contentWidth).map((line) => `  ${line}`);
    return this.frame.render(width, {
      title: this.title,
      content: lines,
      hints: [keyHint("tui.select.confirm", "submit"), keyHint("tui.select.cancel", "cancel")],
      actions,
      actionFocusLine: 0,
    });
  }
}
