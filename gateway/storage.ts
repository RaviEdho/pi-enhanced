import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface DiscordChannelReplies {
  mode: DiscordChannelReplyMode;
  /** Omit for cheapest; follow Pi's global or the gateway's configured default explicitly. */
  routerModel?: "pi-default" | "gateway-default" | { provider: string; id: string };
  /** Recent channel messages for each routing decision (0–25; defaults to 5). */
  contextMessages?: number;
  /** Escalate a channel reply that used editing, shell, or delegation tools. */
  escalate: boolean;
  /** Escalate a repeat mention from the same participant in the same channel. */
  followUp: boolean;
}

export type DiscordChannelReplyMode = "always-thread" | "channel" | "auto";

export interface DiscordChannelSessions {
  enabled: boolean;
  timezone: string;
  resetHour: number;
  idleHours: number;
}

export const DEFAULT_DISCORD_CHANNEL_SESSIONS: DiscordChannelSessions = {
  enabled: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", resetHour: 4, idleHours: 6,
};

export interface DiscordToolCallVisibility {
  channels: boolean;
  threads: boolean;
  dms: boolean;
}

export interface DiscordTableRendering {
  enabled: boolean;
  showTitleFooter: boolean;
  attachMarkdown: boolean;
}

export interface DiscordGatewayConfig {
  token: string;
  /** Optional on disk; omitted/empty lists are normalized to [] (deny all). */
  allowedUserIds: string[];
  allowedChannelIds: string[];
  allowDirectMessages: boolean;
  allowServerMessages: boolean;
  homeChannelId?: string;
  /** Send config reload outcomes to the home channel. Defaults to off. */
  notifyConfigReloads?: boolean;
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  toolCallVerbosity?: "none" | "tool-only" | "full";
  toolCallVisibility?: DiscordToolCallVisibility;
  tableRendering?: DiscordTableRendering;
  channelReplies: DiscordChannelReplies;
  channelSessions?: DiscordChannelSessions;
  /** Automatically included recent messages per conversation turn (0–25; defaults to 5). */
  contextMessages: number;
  configuredAt: string;
}

export interface DiscordGatewayStatus {
  pid: number;
  state: "starting" | "ready" | "disconnected" | "restarting" | "stopping" | "stopped" | "failed";
  startedAt: string;
  updatedAt: string;
  botTag?: string;
  supervision?: "detached" | "systemd";
  lastEventAt?: string;
  lastError?: string;
  configReload?: {
    outcome: "applied" | "rejected" | "valid";
    at: string;
    tokenRestartPending: boolean;
  };
}

export interface DiscordGatewayPaths {
  directory: string;
  config: string;
  pid: string;
  status: string;
  log: string;
  sessions: string;
  threads: string;
  restartRequest: string;
}

export function getDiscordGatewayPaths(): DiscordGatewayPaths {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const directory = resolve(agentDir, "discord-gateway");
  return {
    directory,
    config: join(directory, "config.json"),
    pid: join(directory, "daemon.pid"),
    status: join(directory, "status.json"),
    log: join(directory, "gateway.log"),
    sessions: join(directory, "sessions"),
    threads: join(directory, "threads.json"),
    restartRequest: join(directory, "restart-request.json"),
  };
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // chmod is best-effort on filesystems that do not support POSIX modes.
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temporaryPath, 0o600);
  } catch {
    // chmod is best-effort on filesystems that do not support POSIX modes.
  }
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort on filesystems that do not support POSIX modes.
  }
}

export function readDiscordGatewayConfig(): DiscordGatewayConfig | undefined {
  const path = getDiscordGatewayPaths().config;
  if (!existsSync(path)) return undefined;

  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DiscordGatewayConfig>;
  if (
    typeof value.token !== "string" ||
    !value.token.trim() ||
    (value.allowedUserIds !== undefined && !isDiscordAllowlist(value.allowedUserIds)) ||
    (value.allowedChannelIds !== undefined && !isDiscordAllowlist(value.allowedChannelIds)) ||
    (value.allowDirectMessages !== undefined && typeof value.allowDirectMessages !== "boolean") ||
    (value.allowServerMessages !== undefined && typeof value.allowServerMessages !== "boolean") ||
    (value.homeChannelId !== undefined && !isDiscordSnowflake(value.homeChannelId)) ||
    (value.notifyConfigReloads !== undefined && typeof value.notifyConfigReloads !== "boolean") ||
    (value.toolCallVerbosity !== undefined && !["none", "tool-only", "full"].includes(value.toolCallVerbosity)) ||
    (value.toolCallVisibility !== undefined && !isValidToolCallVisibility(value.toolCallVisibility)) ||
    (value.tableRendering !== undefined && !isValidTableRendering(value.tableRendering)) ||
    (value.channelReplies !== undefined && !isValidChannelReplies(value.channelReplies)) ||
    (value.channelSessions !== undefined && !isValidDiscordChannelSessions(value.channelSessions)) ||
    (value.contextMessages !== undefined &&
      (!Number.isInteger(value.contextMessages) || value.contextMessages < 0 || value.contextMessages > 25)) ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    (value.model !== undefined &&
      (value.model === null || typeof value.model !== "object" ||
        typeof value.model.provider !== "string" ||
        !value.model.provider ||
        typeof value.model.id !== "string" ||
        !value.model.id)) ||
    (value.thinkingLevel !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel))
  ) {
    throw new Error(`Invalid Discord gateway configuration at ${path}`);
  }

  return {
    token: value.token,
    allowedUserIds: [...new Set(value.allowedUserIds ?? [])],
    allowedChannelIds: [...new Set(value.allowedChannelIds ?? [])],
    allowDirectMessages: value.allowDirectMessages !== false,
    allowServerMessages: value.allowServerMessages !== false,
    ...(typeof value.homeChannelId === "string" ? { homeChannelId: value.homeChannelId } : {}),
    notifyConfigReloads: value.notifyConfigReloads === true,
    cwd: value.cwd,
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel as DiscordGatewayConfig["thinkingLevel"] } : {}),
    toolCallVerbosity: value.toolCallVerbosity ?? "full",
    toolCallVisibility: { channels: false, threads: true, dms: true, ...value.toolCallVisibility },
    tableRendering: { enabled: false, showTitleFooter: false, attachMarkdown: false, ...value.tableRendering },
    channelReplies: readChannelReplies(value.channelReplies),
    channelSessions: { ...DEFAULT_DISCORD_CHANNEL_SESSIONS, ...value.channelSessions },
    contextMessages: value.contextMessages ?? 5,
    configuredAt: typeof value.configuredAt === "string" ? value.configuredAt : new Date(0).toISOString(),
  };
}

function isValidToolCallVisibility(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordToolCallVisibility>;
  return [entry.channels, entry.threads, entry.dms].every((setting) => setting === undefined || typeof setting === "boolean");
}

function isValidTableRendering(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordTableRendering>;
  return [entry.enabled, entry.showTitleFooter, entry.attachMarkdown].every((setting) => setting === undefined || typeof setting === "boolean");
}

export function isValidDiscordChannelSessions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordChannelSessions>;
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return false;
  if (entry.resetHour !== undefined && (!Number.isInteger(entry.resetHour) || entry.resetHour < 0 || entry.resetHour > 23)) return false;
  if (entry.idleHours !== undefined && (!Number.isInteger(entry.idleHours) || entry.idleHours < 1 || entry.idleHours > 168)) return false;
  if (entry.timezone !== undefined) {
    if (typeof entry.timezone !== "string" || !entry.timezone.trim()) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: entry.timezone }); } catch { return false; }
  }
  return true;
}

function isValidChannelReplies(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordChannelReplies>;
  if (entry.mode !== undefined && !["always-thread", "channel", "auto"].includes(entry.mode)) return false;
  if (entry.escalate !== undefined && typeof entry.escalate !== "boolean") return false;
  if (entry.followUp !== undefined && typeof entry.followUp !== "boolean") return false;
  if (entry.contextMessages !== undefined &&
      (!Number.isInteger(entry.contextMessages) || entry.contextMessages < 0 || entry.contextMessages > 25)) return false;
  if (entry.routerModel !== undefined && entry.routerModel !== "pi-default" &&
      entry.routerModel !== "gateway-default" && !isModelChoice(entry.routerModel)) return false;
  return true;
}

function isModelChoice(value: unknown): value is { provider: string; id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as { provider?: unknown; id?: unknown };
  return typeof model.provider === "string" && Boolean(model.provider) && typeof model.id === "string" && Boolean(model.id);
}

function readChannelReplies(value: unknown): DiscordChannelReplies {
  const entry = (value ?? {}) as Partial<DiscordChannelReplies>;
  return {
    mode: entry.mode ?? "always-thread",
    contextMessages: entry.contextMessages ?? 5,
    ...(entry.routerModel === "pi-default" || entry.routerModel === "gateway-default" || isModelChoice(entry.routerModel)
      ? { routerModel: entry.routerModel } : {}),
    escalate: entry.escalate !== false,
    followUp: entry.followUp !== false,
  };
}

function isDiscordAllowlist(value: unknown): value is string[] {
  return Array.isArray(value) && (
    (value.length === 1 && value[0] === "*") || value.every(isDiscordSnowflake)
  );
}

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}
