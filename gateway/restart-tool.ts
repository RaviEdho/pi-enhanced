import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

const RestartParametersSchema = Type.Object({
  reason: Type.Optional(
    Type.String({
      maxLength: 500,
      description: "Optional short explanation for the gateway restart.",
    })
  ),
});

export function createDiscordGatewayRestartTool(): ToolDefinition<typeof RestartParametersSchema> {
  return {
    name: "discord_gateway_restart",
    label: "Restart Discord gateway",
    description:
      "Request a graceful restart of the Discord gateway after code changes. The gateway waits until this Discord reply is sent and accepted messages finish, then restarts from the updated code. Conversation history is preserved on disk and resumes on the next message. Only use after edits and verification are complete; this does not restart a local foreground Pi session.",
    parameters: RestartParametersSchema,
    async execute(_toolCallId, params) {
      if (process.env.PI_ENHANCED_DISCORD_GATEWAY_CHILD !== "1") {
        return toolResult(
          "This tool is only available inside a Discord gateway session.",
          true
        );
      }

      const requestPath = process.env.PI_ENHANCED_DISCORD_RESTART_REQUEST_PATH;
      if (!requestPath) {
        return toolResult("The Discord gateway restart channel is not configured.", true);
      }

      const request = {
        type: "restart",
        requestId: randomUUID(),
        requestedAt: new Date().toISOString(),
        ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
      };

      const temporaryPath = `${requestPath}.${process.pid}.${request.requestId}.tmp`;
      try {
        if (existsSync(requestPath)) return alreadyPendingResult();
        writeFileSync(temporaryPath, `${JSON.stringify(request)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (existsSync(requestPath)) return alreadyPendingResult();
        renameSync(temporaryPath, requestPath);
      } catch (error) {
        if (isAlreadyRequested(error)) return alreadyPendingResult();
        return toolResult(
          `Could not request a Discord gateway restart: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      } finally {
        try { unlinkSync(temporaryPath); } catch { /* already renamed or absent */ }
      }

      return toolResult(
        "Graceful gateway restart requested. Finish this Discord reply now; it will be delivered before the gateway drains accepted work and restarts. This thread's session history is preserved, so continue in this thread after the bot reconnects.",
        false
      );
    },
  };
}

function alreadyPendingResult() {
  return toolResult(
    "A Discord gateway restart is already pending. Finish this reply; the gateway will restart after accepted work drains.",
    false
  );
}

function toolResult(text: string, isError: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
    isError,
  };
}

function isAlreadyRequested(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
