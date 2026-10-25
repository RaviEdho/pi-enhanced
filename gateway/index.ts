import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleDiscordCommand } from "./command.js";
import { createDiscordGatewayRestartTool } from "./restart-tool.js";

export function registerDiscordGateway(pi: ExtensionAPI): void {
  if (process.env.PI_ENHANCED_DISCORD_GATEWAY_CHILD === "1") {
    pi.registerTool(createDiscordGatewayRestartTool());
  }
  pi.registerCommand("discord", {
    description: "Configure and manage the background Discord agent gateway",
    handler: async (args, ctx) => {
      await handleDiscordCommand(args, ctx);
    },
  });
}

export { handleDiscordCommand } from "./command.js";
export {
  getDiscordGatewayPaths,
  readDiscordGatewayConfig,
  type DiscordGatewayConfig,
  type DiscordGatewayStatus,
} from "./storage.js";
