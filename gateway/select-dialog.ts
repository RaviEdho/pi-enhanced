import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Container, matchesKey, SelectList, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
  keyHint,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";

export interface DiscordSelectOption {
  label: string;
  description: string;
  currentValue?: string;
}

export interface DiscordSelectDialogOptions {
  title: string;
  description?: string;
  options: (string | DiscordSelectOption)[];
  selectedOption?: string;
}

/** Native settings/select lists, with the same content-sized chrome as /settings. */
export class DiscordSelectDialog implements Component {
  readonly capturesViewportInput = true;
  private readonly container = new Container();
  private readonly list: SettingsList | SelectList;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    options: DiscordSelectDialogOptions,
    private readonly onDone: (choice: string | undefined) => void,
    private readonly keybindings?: KeybindingsManager
  ) {
    this.container.addChild(new DynamicBorder());
    this.container.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
    this.container.addChild(new Spacer(1));

    if (options.options.some((option) => typeof option !== "string")) {
      // Let SettingsList own search, alignment, scrolling, description wrapping,
      // and hints rather than recreating those native settings behaviors.
      const items = options.options.map((option) => {
        const label = typeof option === "string" ? option : option.label;
        const currentValue = typeof option === "string" ? "configure" : option.currentValue ?? "configure";
        return {
          id: label,
          label,
          description: typeof option === "string" ? undefined : option.description,
          currentValue,
          values: [currentValue],
        };
      });
      this.list = new SettingsList(items, 10, getSettingsListTheme(),
        (id) => onDone(id), () => onDone(undefined), { enableSearch: true });
      if (options.selectedOption) this.list.selectItem(options.selectedOption);
      this.container.addChild(this.list);
    } else {
      if (options.description) {
        this.container.addChild(new Text(theme.fg("muted", options.description), 0, 0));
        this.container.addChild(new Spacer(1));
      }
      const items = options.options.map((option) => {
        const label = typeof option === "string" ? option : option.label;
        return { value: label, label };
      });
      this.list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
      const selectedIndex = options.selectedOption
        ? items.findIndex((item) => item.value === options.selectedOption)
        : items.findIndex((item) => item.label.endsWith(" (current)"));
      if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
      this.list.onSelect = (item) => onDone(item.value);
      this.list.onCancel = () => onDone(undefined);
      this.container.addChild(this.list);
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(theme.fg("dim", [
        keyHint("tui.select.confirm", "select"),
        keyHint("tui.select.cancel", "back"),
      ].join(" · ")), 0, 0));
    }
    this.container.addChild(new DynamicBorder());
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (data === "\x03" || this.keybindings?.matches(data, "app.interrupt")) {
      this.onDone(undefined);
      return;
    }
    // SettingsList handles search text; reserve Tab for list navigation.
    this.list.handleInput(matchesKey(data, "tab") ? "\x1b[B" : data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.container.handleMouse(event);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
