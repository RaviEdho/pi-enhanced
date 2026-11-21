import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log, safeErrorName } from "./logging.mjs";
import { writePrivateJson } from "./persistence.mjs";

const SNOWFLAKE = /^\d{17,20}$/;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

export function isLegacyScheduledAgentResult(message, botId) {
  if (!botId || message?.author?.id !== botId) return false;
  const id = /^\*\*Scheduled agent\*\* · `([^`]+)`(?:\n|$)/.exec(message.content)?.[1];
  return id !== undefined && UUID.test(id);
}

/** Store destination-scoped links, never the job prompt or its session file. */
export function createScheduledReplyRegistry(sessionRoot) {
  const key = (channelId, id) => `scheduled-reply:${channelId}:${id}`;
  const path = (channelId, messageId) => join(sessionRoot, "scheduled-replies", channelId, `${messageId}.json`);
  return {
    start(channelId) { return key(channelId, randomUUID()); },
    lookup(channelId, messageId) {
      if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) return undefined;
      try {
        const { id } = JSON.parse(readFileSync(path(channelId, messageId), "utf8"));
        if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid scheduled reply metadata");
        return key(channelId, id);
      } catch (error) {
        if (error?.code !== "ENOENT") log(`Could not read scheduled reply affinity: ${safeErrorName(error)}`);
      }
    },
    remember(channelId, sessionKey, message) {
      const id = sessionKey.slice(key(channelId, "").length);
      if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(message?.id) || message.channelId !== channelId ||
          !UUID.test(id) || sessionKey !== key(channelId, id)) return;
      try {
        if (!writePrivateJson(path(channelId, message.id), { id })) throw new Error("Could not write scheduled reply metadata");
      } catch (error) {
        log(`Could not save scheduled reply affinity: ${safeErrorName(error)}`);
      }
    },
  };
}
