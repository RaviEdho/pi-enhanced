import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register the command without importing the analyzer or viewer at startup. */
export function registerContextCommand(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Display active context window usage, category breakdown, and top consumers",
    handler: async (_args, ctx) => {
      const { handleContextCommand } = await import("./command.js");
      await handleContextCommand(ctx);
    },
  });
}
