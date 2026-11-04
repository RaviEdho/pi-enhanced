import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep the interactive settings UI off the startup import path. */
export function registerSettingsEnhancedCommand(pi: ExtensionAPI): void {
  pi.registerCommand("settings-enhanced", {
    description: "Configure pi-enhanced features (compressor, scout, quota footer, telemetry, failover)",
    handler: async (args, ctx) => {
      const { handleSettingsEnhancedCommand } = await import("./command.js");
      await handleSettingsEnhancedCommand(args || "", ctx);
    },
  });
}
