import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { registerUsageFooter } from "./footer.js";
export type { CollectUsageOptions, CollectUsageResult, UsageViewerOptions } from "./command.js";
export { collectUsageReports, UsageViewerComponent } from "./command.js";

/**
 * Registers the /usage command with Pi using lazy loading.
 */
export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Display provider quota and rate limit status across all configured accounts",
    handler: async (_args, ctx) => {
      const { handleUsageCommand } = await import("./command.js");
      await handleUsageCommand(ctx);
    },
  });
}
