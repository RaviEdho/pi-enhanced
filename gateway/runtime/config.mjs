import { readFileSync, unwatchFile, watch, watchFile } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_CHANNEL_SESSIONS, isValidChannelSessions } from "./channel-sessions.mjs";
import { log } from "./logging.mjs";
import { validateWorkspaceDirectory } from "./workspace.mjs";

export function loadGatewayConfig(env = process.env) {
  const configPath = env.PI_ENHANCED_DISCORD_CONFIG_PATH;
  const pidPath = env.PI_ENHANCED_DISCORD_PID_PATH;
  const statusPath = env.PI_ENHANCED_DISCORD_STATUS_PATH;
  const sessionRoot = env.PI_ENHANCED_DISCORD_SESSION_ROOT;
  const threadsPath = env.PI_ENHANCED_DISCORD_THREADS_PATH;
  const restartRequestPath = env.PI_ENHANCED_DISCORD_RESTART_REQUEST_PATH;
  const logPath = env.PI_ENHANCED_DISCORD_LOG_PATH;
  const piExecutable = env.PI_ENHANCED_DISCORD_PI_EXECUTABLE || "pi";
  const piArgs = parseJsonArray(env.PI_ENHANCED_DISCORD_PI_ARGS);
  let previousGatewayState;
  try {
    previousGatewayState = JSON.parse(readFileSync(statusPath, "utf8"))?.state;
  } catch {
    // No previous status is expected on a first start.
  }
  const startReason = previousGatewayState === "restarting"
    ? "restart"
    : env.PI_ENHANCED_DISCORD_START_REASON || "start";

  if (!configPath || !pidPath || !statusPath || !sessionRoot || !threadsPath) {
    throw new Error("Discord gateway paths are not configured");
  }

  return {
    config: readGatewayConfig(configPath),
    paths: { configPath, pidPath, statusPath, sessionRoot, threadsPath, restartRequestPath, logPath },
    piExecutable,
    piArgs,
    startReason,
  };
}

export function readGatewayConfig(configPath) {
  const text = readFileSync(configPath, "utf8");
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("Invalid Discord gateway JSON"); }
  if (
    !config || typeof config !== "object" || Array.isArray(config) ||
    typeof config.token !== "string" || !config.token.trim() ||
    (config.allowedUserIds !== undefined && !isValidAllowlist(config.allowedUserIds)) ||
    (config.allowedChannelIds !== undefined && !isValidAllowlist(config.allowedChannelIds)) ||
    (config.allowDirectMessages !== undefined && typeof config.allowDirectMessages !== "boolean") ||
    (config.allowServerMessages !== undefined && typeof config.allowServerMessages !== "boolean") ||
    (config.homeChannelId !== undefined && (typeof config.homeChannelId !== "string" || !/^\d{17,20}$/.test(config.homeChannelId))) ||
    (config.toolCallVerbosity !== undefined && !["none", "tool-only", "full"].includes(config.toolCallVerbosity)) ||
    (config.toolCallVisibility !== undefined && !isValidToolCallVisibility(config.toolCallVisibility)) ||
    (config.tableRendering !== undefined && !isValidTableRendering(config.tableRendering)) ||
    (config.channelReplies !== undefined && !isValidChannelReplies(config.channelReplies)) ||
    (config.channelSessions !== undefined && !isValidChannelSessions(config.channelSessions)) ||
    (config.contextMessages !== undefined && (!Number.isInteger(config.contextMessages) || config.contextMessages < 0 || config.contextMessages > 25)) ||
    typeof config.cwd !== "string" || !config.cwd.trim() ||
    (config.model !== undefined && !isModelChoice(config.model)) ||
    (config.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinkingLevel))
  ) {
    throw new Error("Discord gateway configuration is invalid");
  }

  // Use only known keys. Include optional fields so removing one on disk clears it live.
  return {
    token: config.token,
    allowedUserIds: [...new Set(config.allowedUserIds ?? [])],
    allowedChannelIds: [...new Set(config.allowedChannelIds ?? [])],
    allowDirectMessages: config.allowDirectMessages !== false,
    allowServerMessages: config.allowServerMessages !== false,
    homeChannelId: config.homeChannelId,
    cwd: config.cwd,
    model: config.model && { provider: config.model.provider, id: config.model.id },
    thinkingLevel: config.thinkingLevel,
    toolCallVerbosity: config.toolCallVerbosity ?? "full",
    toolCallVisibility: { channels: false, threads: true, dms: true, ...config.toolCallVisibility },
    tableRendering: { enabled: false, showTitleFooter: false, attachMarkdown: false, ...config.tableRendering },
    channelReplies: { mode: "always-thread", escalate: true, followUp: true, contextMessages: 5, ...config.channelReplies },
    channelSessions: { ...DEFAULT_CHANNEL_SESSIONS, ...config.channelSessions },
    contextMessages: config.contextMessages ?? 5,
    configuredAt: typeof config.configuredAt === "string" ? config.configuredAt : undefined,
  };
}

/** Keep shared references for runtime consumers; commit only after validating the whole file. */
export function watchGatewayConfig({ configPath, config, allowedUsers, allowedChannels, logger = log }) {
  const filename = basename(configPath);
  let watcher;
  let timer;
  let closed = false;
  let invalidReported = false;
  let tokenChangeReported = false;

  function reload() {
    let next;
    try {
      next = readGatewayConfig(configPath);
      if (next.cwd !== config.cwd) validateWorkspaceDirectory(next.cwd);
    } catch {
      // Never log raw parse/validation errors; they can include config contents.
      if (!invalidReported) logger("Discord gateway config reload skipped: config.json is invalid or unavailable; keeping the last valid settings.");
      invalidReported = true;
      return;
    }
    const recovered = invalidReported;
    invalidReported = false;
    const tokenChanged = next.token !== config.token;
    if (tokenChanged && !tokenChangeReported) logger("Discord bot token changed on disk; run /discord restart to reconnect with it.");
    tokenChangeReported = tokenChanged;
    next.token = config.token;
    if (isDeepStrictEqual(next, config)) {
      if (recovered) logger("Discord gateway config.json is valid again.");
      return;
    }
    Object.assign(config, next);
    allowedUsers.clear();
    allowedChannels.clear();
    for (const id of next.allowedUserIds) allowedUsers.add(id);
    for (const id of next.allowedChannelIds) allowedChannels.add(id);
    logger("Discord gateway settings reloaded.");
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      reload();
    }, 100);
    timer.unref();
  }

  // Settings saves rename a temporary file over config.json. Watch the parent
  // so atomic replacement does not detach the watcher from future saves.
  try {
    watcher = watch(dirname(configPath), { persistent: false }, (_event, name) => {
      if (!name || name === filename) schedule();
    });
    watcher.on("error", () => watcher.close());
  } catch {
    // The stat poll below also covers missing directories and dropped events.
  }
  watchFile(configPath, { persistent: false, interval: 2000 }, schedule);
  reload(); // Reconcile a save that happened between startup and watcher registration.
  return () => {
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    unwatchFile(configPath, schedule);
  };
}

export function isValidAllowlist(value) {
  return Array.isArray(value) && (
    (value.length === 1 && value[0] === "*") ||
    value.every((entry) => typeof entry === "string" && /^\d{17,20}$/.test(entry))
  );
}

export function isValidToolCallVisibility(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [value.channels, value.threads, value.dms].every((setting) => setting === undefined || typeof setting === "boolean");
}

export function isValidTableRendering(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [value.enabled, value.showTitleFooter, value.attachMarkdown].every((setting) => setting === undefined || typeof setting === "boolean");
}

/** Reply routing settings: thread mode, optional router model, and escalation. */
export function isValidChannelReplies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.mode !== undefined && !["always-thread", "channel", "auto"].includes(value.mode)) return false;
  if (value.escalate !== undefined && typeof value.escalate !== "boolean") return false;
  if (value.followUp !== undefined && typeof value.followUp !== "boolean") return false;
  if (value.contextMessages !== undefined &&
      (!Number.isInteger(value.contextMessages) || value.contextMessages < 0 || value.contextMessages > 25)) return false;
  if (value.routerModel !== undefined && value.routerModel !== "pi-default" && value.routerModel !== "gateway-default") {
    if (!isModelChoice(value.routerModel)) return false;
  }
  return true;
}

function isModelChoice(model) {
  return model && typeof model === "object" && !Array.isArray(model) &&
    typeof model.provider === "string" && Boolean(model.provider) &&
    typeof model.id === "string" && Boolean(model.id);
}

export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}
