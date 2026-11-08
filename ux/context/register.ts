import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Jiti must finish one shared import before overlapping commands use its exports.
let commandModulePromise: Promise<typeof import("./command.js")> | undefined;

/** Register the command without importing the analyzer or viewer at startup. */
export function registerContextCommand(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Display active context window usage, category breakdown, and top consumers",
    handler: async (_args, ctx) => {
      const { handleContextCommand } = await (commandModulePromise ??= import("./command.js").catch((error) => {
        commandModulePromise = undefined;
        throw error;
      }));
      await handleContextCommand(ctx);
    },
  });
}
