import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discordRequest } from "./history-tool.js";

const Parameters = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 2048, description: "Image file inside the current workspace (relative or absolute path), or a public HTTPS image URL. PNG, JPEG, GIF, or WebP; maximum 10 MiB." }),
  caption: Type.Optional(Type.String({ maxLength: 1900, description: "Optional message accompanying the image. Mentions are disabled." })),
  description: Type.Optional(Type.String({ maxLength: 1024, description: "Optional accessible alt text for the image." })),
});

export function createDiscordSendImageTool(): ToolDefinition<typeof Parameters> {
  return {
    name: "discord_send_image",
    label: "Send a Discord image attachment",
    description: "Upload one PNG, JPEG, GIF, or WebP image from a workspace file or public HTTPS URL as an actual attachment in the active Discord conversation. Optional caption and alt text. Maximum 10 MiB per image, four images / 20 MiB per request. Cannot target another channel. Local files outside the workspace and private-network URLs are refused. Does not generate images.",
    promptGuidelines: [
      "Use discord_send_image when the user asks to receive a photo, image, chart, or screenshot as a Discord attachment. Only send images relevant to the user's request; never send private or sensitive files without explicit permission.",
      "discord_send_image uploads immediately to the active conversation, visible to its participants. On success, do not resend the image or repeat its caption in the final reply. If delivery is uncertain, check the conversation before retrying.",
    ],
    parameters: Parameters,
    executionMode: "sequential",
    exposure: "model-only",
    async execute(id, params, signal) {
      const result = await discordRequest({ ...params, toolCallId: id }, signal, "send_image", 60_000);
      return {
        content: [{ type: "text", text: `Image attachment sent to the active Discord conversation. Do not resend.\n${JSON.stringify(result)}` }],
        details: { discordImageSent: true, delivery: result },
      };
    },
  };
}
