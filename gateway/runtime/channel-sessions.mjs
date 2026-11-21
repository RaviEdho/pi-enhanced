import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "./persistence.mjs";
import {
  DEFAULT_SESSION_ROLLOVER as DEFAULT_CHANNEL_SESSIONS, advanceSessionRollover,
  latestSessionBoundary as latestChannelBoundary, rolloverSchedule,
} from "./session-rollover.mjs";

export { DEFAULT_CHANNEL_SESSIONS, latestChannelBoundary };
export { isValidSessionRollover as isValidChannelSessions } from "./session-rollover.mjs";

const SNOWFLAKE = /^\d{17,20}$/;

export function getChannelSessionKey(guildId, channelId) {
  return `guild:${guildId}:channel:${channelId}`;
}

function readOptional(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/** Durable defaults and reply affinity. No chat text or credentials are stored here. */
export function createChannelSessionRegistry({ sessionRoot, sessions, settings, getSettings = () => settings, now = Date.now }) {
  const channels = new Map();

  function channel(guildId, channelId, settings = getSettings()) {
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) throw new Error("Invalid channel identity");
    const baseKey = getChannelSessionKey(guildId, channelId);
    if (channels.has(baseKey)) return channels.get(baseKey);
    const directory = join(sessionRoot, "channel-routes", createHash("sha256").update(baseKey).digest("hex"));
    const path = join(directory, "state.json");
    const policy = { ...DEFAULT_CHANNEL_SESSIONS, ...settings };
    const schedule = rolloverSchedule(policy);
    const state = readOptional(path) ?? {
      defaultKey: baseKey, checkedBoundary: latestChannelBoundary(now(), policy), schedule,
      lastActivityAt: 0, lastFinishedAt: 0, pending: 0,
    };
    const validKey = (key) => key === baseKey || (typeof key === "string" &&
      key.startsWith(`${baseKey}:session:`) && /^[a-f0-9-]{36}$/.test(key.slice(`${baseKey}:session:`.length)));
    if (!validKey(state.defaultKey) || ![state.checkedBoundary, state.lastActivityAt, state.lastFinishedAt, state.pending]
      .every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Invalid channel session metadata");
    // A crash may leave accepted work marked pending. Conservatively skip the
    // current overnight check rather than forgetting an interrupted conversation.
    if (state.pending > 0) { state.pending = 0; state.lastFinishedAt = now(); }
    const entry = { baseKey, directory, path, state, validKey };
    channels.set(baseKey, entry);
    return entry;
  }

  function current(guildId, channelId, acceptedAt = now(), settings = getSettings()) {
    const policy = { ...DEFAULT_CHANNEL_SESSIONS, ...settings };
    const entry = channel(guildId, channelId, settings);
    const state = entry.state;
    // Selection may wait behind a routing decision. A request accepted before
    // the boundary still belongs to that night, even if dequeued afterward.
    const boundary = latestChannelBoundary(acceptedAt, policy);
    advanceSessionRollover(state, policy, boundary, () => sessions.hasWorkFor(state.defaultKey), () => {
      const key = `${entry.baseKey}:session:${randomUUID()}`;
      sessions.prepareFresh(key, state.defaultKey);
      state.defaultKey = key;
    });
    writePrivateJson(entry.path, state);
    return state.defaultKey;
  }

  function begin(guildId, channelId, key, acceptedAt = now()) {
    const entry = channel(guildId, channelId);
    if (key !== entry.state.defaultKey) return () => {};
    entry.state.lastActivityAt = Math.max(entry.state.lastActivityAt, acceptedAt);
    entry.state.pending += 1;
    writePrivateJson(entry.path, entry.state);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      entry.state.pending -= 1;
      entry.state.lastFinishedAt = now();
      writePrivateJson(entry.path, entry.state);
    };
  }

  function replySession(guildId, channelId, messageId) {
    if (!SNOWFLAKE.test(messageId)) return undefined;
    const entry = channel(guildId, channelId);
    const saved = readOptional(join(entry.directory, "replies", `${messageId}.json`));
    if (!saved) return undefined;
    if (!entry.validKey(saved.sessionKey)) throw new Error("Invalid channel reply metadata");
    return saved.sessionKey;
  }

  function rememberReply(guildId, channelId, key, message) {
    const entry = channel(guildId, channelId);
    if (!SNOWFLAKE.test(message?.id) || message.channelId !== channelId || !entry.validKey(key)) return;
    // Separate tiny records permit O(1) lookup without loading or expiring an
    // ever-growing message index. Old replies remain routable after restarts.
    writePrivateJson(join(entry.directory, "replies", `${message.id}.json`), { sessionKey: key });
  }

  function standalone(guildId, channelId) {
    return `${channel(guildId, channelId).baseKey}:session:${randomUUID()}`;
  }

  return {
    current, begin, replySession, rememberReply, standalone,
    peekCurrent: (guildId, channelId) => channel(guildId, channelId).state.defaultKey,
  };
}

/** Track every successful send, including split replies, cards and table images. */
export function trackChannelReplies(channel, onMessageSent) {
  return new Proxy(channel, {
    get(target, property) {
      if (property === "send") return async (...args) => {
        const message = await target.send(...args);
        onMessageSent(message);
        return message;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
