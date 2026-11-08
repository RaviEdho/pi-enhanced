import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Jiti must finish one shared import before overlapping commands use its exports.
let commandModulePromise: Promise<typeof import("./command.js")> | undefined;

/** Keep the interactive settings UI off the startup import path. */
export function registerSettingsEnhancedCommand(pi: ExtensionAPI): void {
  pi.registerCommand("settings-enhanced", {
    description: "Configure pi-enhanced features (compressor, scout, quota footer, telemetry, failover)",
    handler: async (args, ctx) => {
      const { handleSettingsEnhancedCommand } = await (commandModulePromise ??= import("./command.js").catch((error) => {
        commandModulePromise = undefined;
        throw error;
      }));
      await handleSettingsEnhancedCommand(args || "", ctx);
    },
  });
}
