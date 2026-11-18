import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "../ux/model-picker.js";
import { currentChoiceLabel } from "./select-dialog.js";

export async function selectDiscordModel(
  ctx: ExtensionCommandContext,
  choices: SelectItem[],
  currentValue: string,
  refresh?: Promise<void>,
  presentation = { title: "Discord Default Model", description: "Used when gateway Pi sessions start." },
): Promise<string | undefined> {
  const items = choices.map((choice) => ({ ...choice, label: currentChoiceLabel(choice.label, choice.value === currentValue) }));
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        new ModelPickerComponent(tui, theme, keybindings, { ...presentation, choices: items, currentValue, refresh }, done)
      );
    } catch {
      // RPC clients and hosts without custom rendering use Pi's native selector.
    }
  }

  if (refresh) ctx.ui.notify("Refreshing model catalogs in the background; reopen the picker to see updates.", "info");
  const selected = await ctx.ui.select(`${presentation.title}\n${presentation.description}`, items.map((item) => item.label));
  return items.find((item) => item.label === selected)?.value;
}
