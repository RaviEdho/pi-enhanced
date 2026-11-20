import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let commandModule: Promise<typeof import("./command.js")> | undefined;

export function registerWhatsAppGateway(pi: ExtensionAPI): void {
  if (process.env.PI_ENHANCED_WHATSAPP_GATEWAY_CHILD === "1" || process.env.PI_ENHANCED_DISCORD_GATEWAY_CHILD === "1") return;
  pi.registerCommand("whatsapp", {
    description: "Pair and manage the background WhatsApp DM gateway",
    handler: async (args, ctx) => {
      const { handleWhatsAppCommand } = await (commandModule ??= import("./command.js").catch((error) => {
        commandModule = undefined;
        throw error;
      }));
      await handleWhatsAppCommand(args, ctx);
    },
  });
}
