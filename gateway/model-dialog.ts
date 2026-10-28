import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, SelectItem, TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
  private readonly input: Input;
  private list!: SelectList;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly choices: SelectItem[],
    private readonly currentValue: string,
    private readonly onDone: (value: string | undefined) => void
  ) {
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

  private updateList(): void {
    const query = this.input.getValue();
    const filtered = query
      ? fuzzyFilter(this.choices, query, (choice) => `${choice.value} ${choice.label} ${choice.description || ""}`)
      : this.choices;
    this.list = new SelectList(filtered, 8, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("muted", "  No matching models"),
    });
    if (!query) {
      const index = filtered.findIndex((choice) => choice.value === this.currentValue);
      if (index >= 0) this.list.setSelectedIndex(index);
    }
    this.list.onSelect = (choice) => this.onDone(choice.value);
    this.list.onCancel = () => this.onDone(undefined);
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      this.updateList();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const header = truncateToWidth(
      `${this.theme.fg("border", "── ")}${this.theme.bold(this.theme.fg("accent", "Discord Default Model"))} `,
      width
    );
    const lines = [
      `${header}${this.theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(header))))}`,
      ...wrapTextWithAnsi(`Current: ${this.currentValue || "Pi default"}`, contentWidth)
        .map((line) => `  ${this.theme.fg("muted", line)}`),
      "",
      ...this.input.render(contentWidth).map((line) => `  ${line}`),
      "",
      ...this.list.render(contentWidth).map((line) => `  ${line}`),
      "",
    ];
    const hints = [
      rawKeyHint("type", "search"),
      rawKeyHint("↑↓", "navigate"),
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");
    lines.push(...wrapTextWithAnsi(hints, contentWidth).map((line) => `  ${this.theme.fg("muted", line)}`));
    lines.push(this.theme.fg("border", "─".repeat(Math.max(0, width))));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
