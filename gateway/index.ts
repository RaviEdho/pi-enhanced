import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleDiscordCommand } from "./command.js";

export function registerDiscordGateway(pi: ExtensionAPI): void {
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
