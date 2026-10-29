import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, SelectItem, TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, SelectList } from "@earendil-works/pi-tui";
import { DialogFrame } from "../ux/dialog.js";

export async function selectDiscordModel(
  ctx: ExtensionCommandContext,
  choices: SelectItem[],
  currentValue: string
): Promise<string | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        new DiscordModelDialog(tui, theme, keybindings, choices, currentValue, done)
      );
    } catch {
      // RPC clients and hosts without custom rendering use Pi's native selector.
    }
  }

  const selected = await ctx.ui.select(
    `Discord Default Model\nCurrent: ${currentValue || "Pi default"}\nUsed when gateway Pi sessions start.`,
    choices.map((choice) => choice.label)
  );
  return choices.find((choice) => choice.label === selected)?.value;
}

/** A bounded, searchable model list built from Pi's native input and selector. */
export class DiscordModelDialog implements Component, Focusable {
  private readonly frame: DialogFrame;
  private readonly input: Input;
  private list!: SelectList;
  private filtered: SelectItem[] = [];
  private listSize = 1;
  private searching = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly choices: SelectItem[],
    private readonly currentValue: string,
    private readonly onDone: (value: string | undefined) => void
  ) {
    this.frame = new DialogFrame(tui, theme);
    this.input = new Input({
      placeholder: "Search models…",
      placeholderStyle: (text) => this.theme.fg("muted", text),
    });
    this.updateList();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  private updateList(selectedValue?: string): void {
    const query = this.input.getValue();
    this.filtered = query
      ? fuzzyFilter(this.choices, query, (choice) => `${choice.value} ${choice.label} ${choice.description || ""}`)
      : this.choices;
    this.listSize = this.getListSize();
    // Keep full descriptions in the scrollable body, not in the pinned list.
    const items = this.filtered.map(({ value, label }) => ({ value, label }));
    this.list = new SelectList(items, this.listSize, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("muted", "  No matching models"),
    });
    const value = selectedValue ?? (!query ? this.currentValue : undefined);
    const index = this.filtered.findIndex((choice) => choice.value === value);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (choice) => this.onDone(choice.value);
    this.list.onCancel = () => this.onDone(undefined);
  }

  private getListSize(): number {
    // Reserve header/bottom, margins, two hint rows, a body row, and search.
    // bodyHeight excludes the pinned controls and must not size the list.
    return Math.max(1, Math.min(8, this.frame.maxHeight - 10));
  }

  handleInput(data: string): void {
    if (this.frame.handleInput(data)) return;
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.searching = false;
      this.list.handleInput(data);
    } else {
      this.searching = true;
      this.input.handleInput(data);
      this.updateList();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const listSize = this.getListSize();
    if (listSize !== this.listSize) this.updateList(this.list.getSelectedItem()?.value);

    // The frame owns scrolling chrome; omit SelectList's trailing scroll counter.
    const listLines = this.list.render(contentWidth).slice(0, Math.max(1, Math.min(this.filtered.length, this.listSize)));
    const inputLines = this.input.render(contentWidth);
    const actions = [...inputLines, ...listLines].map((line) => `  ${line}`);
    const selectedIndex = Math.max(0, this.filtered.findIndex((choice) => choice.value === this.list.getSelectedItem()?.value));
    const selected = this.filtered[selectedIndex];
    const current = this.choices.find((choice) => choice.value === this.currentValue);
    const lines = [
      `  ${this.theme.fg("text", `Current: ${current?.label || this.currentValue || "Pi default"}`)}`,
      ...(current?.description ? [`  ${this.theme.fg("muted", current.description)}`] : []),
      `  ${this.theme.fg("muted", "Used when gateway Pi sessions start.")}`,
    ];
    if (selected) {
      lines.push("", `  ${this.theme.fg("accent", `Selected: ${selected.label || selected.value}`)}`);
      if (selected.label && selected.label !== selected.value) lines.push(`  ${this.theme.fg("dim", selected.value)}`);
      if (selected.description) lines.push(`  ${this.theme.fg("muted", selected.description)}`);
    }
    const startIndex = Math.max(0, Math.min(
      selectedIndex - Math.floor(this.listSize / 2),
      this.filtered.length - this.listSize
    ));
    // On tiny terminals search and selection may not fit together. Reveal the
    // control being used rather than cropping the selected model out of view.
    const actionFocusLine = this.searching ? 0 : inputLines.length + selectedIndex - startIndex;
    const hints = [
      rawKeyHint("type", "search"),
      rawKeyHint("↑↓", `navigate (${this.filtered.length ? selectedIndex + 1 : 0}/${this.filtered.length})`),
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "cancel"),
    ];
    return this.frame.render(width, {
      title: "Discord Default Model",
      metadata: `Current: ${this.currentValue || "Pi default"}`,
      content: lines,
      hints,
      actions,
      actionFocusLine,
    });
  }
}
