import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatThinkingOverride, getThinkingLevelOptions } from "../ux/thinking-levels.js";
import type { DiscordSettingRow } from "./settings-page.js";

const PI_DEFAULT = "Pi default";

export function defaultThinkingSetting(
  ctx: ExtensionCommandContext,
  configuredModel: { provider: string; id: string } | undefined,
  thinkingLevel: ModelThinkingLevel | undefined,
  applyHint: string,
  save: (value: ModelThinkingLevel | undefined) => void,
): DiscordSettingRow {
  const { model, levels } = configuredModel
    ? getThinkingLevelOptions(ctx.modelRegistry.getAll(), `${configuredModel.provider}/${configuredModel.id}`)
    : getThinkingLevelOptions([]);
  return {
    kind: "inline", id: "thinking", label: "Default thinking",
    description: `Choose a thinking level for new conversations or follow Pi's default. Pi adjusts the level to what the model supports. ${applyHint}`,
    currentValue: thinkingLevel === undefined ? PI_DEFAULT : formatThinkingOverride(thinkingLevel, model),
    values: [PI_DEFAULT, ...levels],
    change(value) {
      const level = levels.find((candidate) => candidate === value);
      if ((value === PI_DEFAULT || level) && level !== thinkingLevel) save(level);
    },
  };
}
