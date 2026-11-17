import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "./persistence.mjs";

export const DEFAULT_CHANNEL_SESSIONS = Object.freeze({
  enabled: true, timezone: "Asia/Jakarta", resetHour: 4, idleHours: 6,
});
const HOUR_MS = 60 * 60 * 1000;
const SNOWFLAKE = /^\d{17,20}$/;

export function getChannelSessionKey(guildId, channelId) {
  return `guild:${guildId}:channel:${channelId}`;
}

export function isValidChannelSessions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.resetHour !== undefined && (!Number.isInteger(value.resetHour) || value.resetHour < 0 || value.resetHour > 23)) return false;
  if (value.idleHours !== undefined && (!Number.isInteger(value.idleHours) || value.idleHours < 1 || value.idleHours > 168)) return false;
  if (value.timezone !== undefined) {
    if (typeof value.timezone !== "string" || !value.timezone.trim()) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); } catch { return false; }
  }
  return true;
}

/** Most recent local daily boundary, independent of the daemon's timezone. */
export function latestChannelBoundary(now, { timezone, resetHour }) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (time) => Object.fromEntries(formatter.formatToParts(time)
    .filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
  const local = parts(now);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (local.hour < resetHour) date.setUTCDate(date.getUTCDate() - 1);
  const wallTime = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), resetHour);
  let candidate = wallTime;
  let previous;
  for (let i = 0; i < 6; i += 1) {
    const p = parts(candidate);
    const correction = wallTime - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (correction === 0) return candidate;
    const next = candidate + correction;
    // A nonexistent DST hour rolls forward to the first corresponding valid hour.
    if (next === previous) return Math.max(candidate, next);
    previous = candidate;
    candidate = next;
  }
  throw new Error("Could not resolve the channel session rollover time");
}

function readOptional(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/** Durable defaults and reply affinity. No chat text or credentials are stored here. */
export function createChannelSessionRegistry({ sessionRoot, sessions, settings = {}, now = Date.now }) {
  const policy = { ...DEFAULT_CHANNEL_SESSIONS, ...settings };
  if (!isValidChannelSessions(policy)) throw new Error("Invalid channel session policy");
  const schedule = `${policy.timezone}:${policy.resetHour}`;
  const channels = new Map();

  function channel(guildId, channelId) {
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) throw new Error("Invalid channel identity");
    const baseKey = getChannelSessionKey(guildId, channelId);
    if (channels.has(baseKey)) return channels.get(baseKey);
    const directory = join(sessionRoot, "channel-routes", createHash("sha256").update(baseKey).digest("hex"));
    const path = join(directory, "state.json");
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

  function current(guildId, channelId, acceptedAt = now()) {
    const entry = channel(guildId, channelId);
    const state = entry.state;
    // Selection may wait behind a routing decision. A request accepted before
    // the boundary still belongs to that night, even if dequeued afterward.
    const boundary = latestChannelBoundary(acceptedAt, policy);
    if (state.schedule !== schedule || !policy.enabled) {
      state.schedule = schedule;
      state.checkedBoundary = boundary;
    } else if (boundary > state.checkedBoundary) {
      // Evaluate activity AT the boundary, not six hours before the next message.
      // Inclusive cutoff: a mention at 10 PM skips a 4 AM / six-hour rollover.
      const quiet = state.lastActivityAt < boundary - policy.idleHours * HOUR_MS;
      const busy = state.pending > 0 || state.lastFinishedAt >= boundary || sessions.hasWorkFor(state.defaultKey);
      if (quiet && !busy) {
        const key = `${entry.baseKey}:session:${randomUUID()}`;
        sessions.prepareFresh(key, state.defaultKey);
        state.defaultKey = key;
        state.lastActivityAt = 0;
        state.lastFinishedAt = 0;
      }
      // A busy night is skipped for the whole day, not retried later that day.
      state.checkedBoundary = boundary;
    }
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
