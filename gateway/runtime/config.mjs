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

export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}
