import { readFileSync } from "node:fs";

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

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    typeof config.token !== "string" ||
    !config.token ||
    !isValidAllowlist(config.allowedUserIds) ||
    !isValidAllowlist(config.allowedChannelIds) ||
    (config.allowDirectMessages !== undefined && typeof config.allowDirectMessages !== "boolean") ||
    (config.allowServerMessages !== undefined && typeof config.allowServerMessages !== "boolean") ||
    (config.homeChannelId !== undefined && (typeof config.homeChannelId !== "string" || !/^\d{17,20}$/.test(config.homeChannelId))) ||
    (config.toolCallVerbosity !== undefined && !["none", "tool-only", "full"].includes(config.toolCallVerbosity)) ||
    (config.toolCallVisibility !== undefined && !isValidToolCallVisibility(config.toolCallVisibility)) ||
    (config.channelReplies !== undefined && !isValidChannelReplies(config.channelReplies)) ||
    (config.contextMessages !== undefined && (!Number.isInteger(config.contextMessages) || config.contextMessages < 0 || config.contextMessages > 25)) ||
    typeof config.cwd !== "string"
  ) {
    throw new Error("Discord gateway configuration is invalid");
  }

  return {
    config,
    paths: { configPath, pidPath, statusPath, sessionRoot, threadsPath, restartRequestPath, logPath },
    piExecutable,
    piArgs,
    startReason,
  };
}

export function isValidAllowlist(value) {
  return Array.isArray(value) && value.length > 0 && (
    (value.length === 1 && value[0] === "*") ||
    value.every((entry) => typeof entry === "string" && /^\d{17,20}$/.test(entry))
  );
}

export function isValidToolCallVisibility(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [value.channels, value.threads, value.dms].every((setting) => setting === undefined || typeof setting === "boolean");
}

/** Reply routing settings: thread mode, optional router model, and escalation. */
export function isValidChannelReplies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.mode !== undefined && !["always-thread", "channel", "auto"].includes(value.mode)) return false;
  if (value.escalate !== undefined && typeof value.escalate !== "boolean") return false;
  if (value.followUp !== undefined && typeof value.followUp !== "boolean") return false;
  if (value.contextMessages !== undefined &&
      (!Number.isInteger(value.contextMessages) || value.contextMessages < 0 || value.contextMessages > 25)) return false;
  if (value.routerModel !== undefined) {
    const model = value.routerModel;
    if (!model || typeof model !== "object" || typeof model.provider !== "string" || !model.provider ||
        typeof model.id !== "string" || !model.id) return false;
  }
  return true;
}

export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}
