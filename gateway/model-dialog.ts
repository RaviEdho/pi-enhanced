import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "../ux/model-picker.js";

export async function selectDiscordModel(
  ctx: ExtensionCommandContext,
  choices: SelectItem[],
  currentValue: string,
  refresh?: Promise<void>
): Promise<string | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        new DiscordModelDialog(tui, theme, keybindings, choices, currentValue, done, refresh)
      );
    } catch {
      // RPC clients and hosts without custom rendering use Pi's native selector.
    }
  }

  if (refresh) ctx.ui.notify("Refreshing model catalogs in the background; reopen the picker to see updates.", "info");
  const selected = await ctx.ui.select(
    `Discord Default Model\nCurrent: ${currentValue || "Pi default"}\nUsed when gateway Pi sessions start.`,
    choices.map((choice) => choice.label)
  );
  return choices.find((choice) => choice.label === selected)?.value;
}

export class DiscordModelDialog extends ModelPickerComponent {
  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    choices: SelectItem[],
    currentValue: string,
    onDone: (value: string | undefined) => void,
    refresh?: Promise<void>
  ) {
    super(tui, theme, keybindings, {
      title: "Discord Default Model",
      description: `Current: ${currentValue || "Pi default"}. Used when gateway Pi sessions start.`,
      choices,
      currentValue,
      refresh,
    }, onDone);
  }
}
