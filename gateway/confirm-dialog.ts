import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, SelectList, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getSelectListTheme, keyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { DialogFrame } from "../ux/dialog.js";

const SECTION_HEADINGS = new Set(["ACCESS", "UNATTENDED TOOLS", "WORKSPACE", "SECURITY"]);

export interface DiscordConfirmationDialogOptions {
  title: string;
  content: string[];
  highlightedLines?: string[];
  confirmLabel: string;
  rejectLabel: string;
}

/** Native choice controls with a bounded body for security/setup disclosures. */
export class DiscordConfirmationDialog implements Component {
  private readonly frame: DialogFrame;
  private readonly list: SelectList;
  private readonly highlightedLines: Set<string>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: DiscordConfirmationDialogOptions,
    private readonly onDone: (approved: boolean) => void,
    private readonly keybindings?: KeybindingsManager
  ) {
    this.frame = new DialogFrame(tui, theme);
    this.highlightedLines = new Set(options.highlightedLines ?? []);
    this.list = new SelectList([
      { value: "confirm", label: options.confirmLabel },
      { value: "reject", label: options.rejectLabel },
    ], 2, getSelectListTheme());
    this.list.onSelect = (item) => onDone(item.value === "confirm");
    this.list.onCancel = () => onDone(false);
  }

  invalidate(): void { this.list.invalidate(); }

  handleInput(data: string): void {
    if (this.frame.handleInput(data)) return;
    if (data === "\x03" || data.toLowerCase() === "q" || this.keybindings?.matches(data, "app.interrupt")) this.onDone(false);
    else this.list.handleInput(matchesKey(data, "tab") ? "\x1b[B" : data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const row = this.frame.actionRowAt(event.y);
    if (row !== undefined) return this.list.handleMouse({ ...event, x: event.x - 2, y: row, height: 2 });
    return this.frame.handleMouse(event);
  }

  render(width: number): string[] {
    const content = this.options.content.flatMap((line) => {
      if (!line) return [""];
      const token = SECTION_HEADINGS.has(line) ? "accent" : this.highlightedLines.has(line) ? "warning" : "text";
      return wrapTextWithAnsi(line, Math.max(1, width - 4)).map((part) => `  ${this.theme.fg(token, part)}`);
    });
    return this.frame.render(width, {
      title: this.options.title,
      content,
      actions: this.list.render(Math.max(1, width - 2)).map((line) => `  ${line}`),
      actionFocusLine: this.list.getSelectedItem()?.value === "reject" ? 1 : 0,
      hints: [keyHint("tui.select.confirm", "confirm"), keyHint("tui.select.cancel", "cancel")],
    });
  }
}
