import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { handleSettingsEnhancedCommand } from "./command.js";
export { EnhancedSettingsComponent } from "./component.js";
export { formatEnhancedSettings, formatSettingValue } from "./format.js";
export { EnhancedSettingsStore } from "./store.js";
export {
  DEFAULT_ENHANCED_SETTINGS,
  SETTING_DEFINITIONS,
  type ContextUsageFormat,
  type EnhancedSettingKey,
  type EnhancedSettings,
  type SettingDefinition,
  type SubagentExecutionMode,
} from "./types.js";

/**
 * Registers the /settings-enhanced command with Pi.
 */
export function registerSettingsEnhancedCommand(pi: ExtensionAPI): void {
  pi.registerCommand("settings-enhanced", {
    description: "Configure pi-enhanced features (compressor, scout, quota footer, telemetry, failover)",
    handler: async (args, ctx) => {
      const { handleSettingsEnhancedCommand } = await import("./command.js");
      await handleSettingsEnhancedCommand(args || "", ctx);
    },
  });
}
