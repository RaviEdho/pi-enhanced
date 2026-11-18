import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";

interface DiscordSelectOption {
  label: string;
  description?: string;
  current?: boolean;
}

export interface DiscordSelectDialogOptions {
  title: string;
  description?: string;
  options: (string | DiscordSelectOption)[];
  selectedOption?: string;
}

export function currentChoiceLabel(label: string, current: boolean): string {
  return current ? `${label} (current)` : label;
}

export function discordSelectItems(options: DiscordSelectDialogOptions) {
  return options.options.map((option) => typeof option === "string"
    ? { value: option, label: option }
    : { value: option.label, label: currentChoiceLabel(option.label, !!option.current), description: option.description });
}

/** A plain choice or action picker; settings pages have their own native SettingsList. */
export class DiscordSelectDialog implements Component {
  readonly capturesViewportInput = true;
  private readonly container = new Container();
  private readonly list: SelectList;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    options: DiscordSelectDialogOptions,
    private readonly onDone: (choice: string | undefined) => void,
    private readonly keybindings?: KeybindingsManager,
  ) {
    this.container.addChild(new DynamicBorder());
    this.container.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
    if (options.description) {
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(theme.fg("muted", options.description), 0, 0));
    }
    this.container.addChild(new Spacer(1));
    const items = discordSelectItems(options);
    this.list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    const selectedIndex = options.selectedOption !== undefined
      ? items.findIndex((item) => item.value === options.selectedOption)
      : options.options.findIndex((option) => typeof option !== "string" && option.current);
    if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
    this.list.onSelect = (item) => onDone(item.value);
    this.list.onCancel = () => onDone(undefined);
    this.container.addChild(this.list);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(theme.fg("dim", [
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "back"),
    ].join(" · ")), 0, 0));
    this.container.addChild(new DynamicBorder());
  }

  invalidate(): void { this.container.invalidate(); }
  render(width: number): string[] { return this.container.render(width); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.container.handleMouse(event); }
  handleInput(data: string): void {
    if (data === "\x03" || this.keybindings?.matches(data, "app.interrupt")) this.onDone(undefined);
    else this.list.handleInput(data);
    this.tui.requestRender();
  }
}
