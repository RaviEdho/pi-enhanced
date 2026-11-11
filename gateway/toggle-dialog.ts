import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Container, matchesKey, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";

export interface DiscordAccessPaths {
  allowDirectMessages: boolean;
  allowServerMessages: boolean;
}

/** Native settings controls; changes remain local until Save is selected. */
export class DiscordToggleDialog implements Component {
  private readonly container = new Container();
  private readonly list: SettingsList;
  private readonly values: DiscordAccessPaths;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    initialValues: DiscordAccessPaths,
    private readonly onDone: (values: DiscordAccessPaths | undefined) => void,
    private readonly keybindings?: KeybindingsManager
  ) {
    this.values = { ...initialValues };
    this.list = new SettingsList([
      { id: "allowDirectMessages", label: "Direct messages", description: "Accept DMs from allowed users.", currentValue: this.values.allowDirectMessages ? "On" : "Off", values: ["On", "Off"] },
      { id: "allowServerMessages", label: "Server messages", description: "Accept allowed server mentions and gateway-thread replies.", currentValue: this.values.allowServerMessages ? "On" : "Off", values: ["On", "Off"] },
      { id: "save", label: "Save changes", description: "Save both message-access settings. Esc discards changes.", currentValue: "save", values: ["save"] },
    ], 3, getSettingsListTheme(), (id, value) => {
      if (id === "save") onDone({ ...this.values });
      else this.values[id as keyof DiscordAccessPaths] = value === "On";
    }, () => onDone(undefined));
    this.container.addChild(new DynamicBorder());
    this.container.addChild(new Text(theme.bold(theme.fg("accent", "Discord Message Access")), 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.list);
    this.container.addChild(new DynamicBorder());
  }

  invalidate(): void { this.container.invalidate(); }

  handleInput(data: string): void {
    if (data === "\x03" || data.toLowerCase() === "q" || this.keybindings?.matches(data, "app.interrupt")) this.onDone(undefined);
    else this.list.handleInput(matchesKey(data, "tab") ? "\x1b[B" : data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.container.handleMouse(event); }
  render(width: number): string[] { return this.container.render(width); }
}
