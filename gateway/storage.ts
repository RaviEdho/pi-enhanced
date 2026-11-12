import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DiscordChannelReplies {
  mode: DiscordChannelReplyMode;
  routerModel?: { provider: string; id: string };
  /** Recent channel messages for each routing decision (0–25; defaults to 5). */
  contextMessages?: number;
  /** Escalate a channel reply that used editing, shell, or delegation tools. */
  escalate: boolean;
  /** Escalate a repeat mention from the same participant in the same channel. */
  followUp: boolean;
}

export type DiscordChannelReplyMode = "always-thread" | "channel" | "auto";

export interface DiscordToolCallVisibility {
  channels: boolean;
  threads: boolean;
  dms: boolean;
}

export interface DiscordGatewayConfig {
  token: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
  allowDirectMessages: boolean;
  allowServerMessages: boolean;
  homeChannelId?: string;
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  toolCallVerbosity?: "none" | "tool-only" | "full";
  toolCallVisibility?: DiscordToolCallVisibility;
  channelReplies: DiscordChannelReplies;
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
  lastEventAt?: string;
  lastError?: string;
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
  const directory = join(agentDir, "discord-gateway");
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
    !isDiscordAllowlist(value.allowedUserIds) ||
    !isDiscordAllowlist(value.allowedChannelIds) ||
    (value.allowDirectMessages !== undefined && typeof value.allowDirectMessages !== "boolean") ||
    (value.allowServerMessages !== undefined && typeof value.allowServerMessages !== "boolean") ||
    (value.homeChannelId !== undefined && !isDiscordSnowflake(value.homeChannelId)) ||
    (value.toolCallVerbosity !== undefined && !["none", "tool-only", "full"].includes(value.toolCallVerbosity)) ||
    (value.toolCallVisibility !== undefined && !isValidToolCallVisibility(value.toolCallVisibility)) ||
    (value.channelReplies !== undefined && !isValidChannelReplies(value.channelReplies)) ||
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
    allowedUserIds: [...new Set(value.allowedUserIds)],
    allowedChannelIds: [...new Set(value.allowedChannelIds)],
    allowDirectMessages: value.allowDirectMessages !== false,
    allowServerMessages: value.allowServerMessages !== false,
    ...(typeof value.homeChannelId === "string" ? { homeChannelId: value.homeChannelId } : {}),
    cwd: value.cwd,
    ...(value.model ? { model: value.model } : {}),
    ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel as DiscordGatewayConfig["thinkingLevel"] } : {}),
    toolCallVerbosity: value.toolCallVerbosity ?? "full",
    toolCallVisibility: { channels: false, threads: true, dms: true, ...value.toolCallVisibility },
    channelReplies: readChannelReplies(value.channelReplies),
    contextMessages: value.contextMessages ?? 5,
    configuredAt: typeof value.configuredAt === "string" ? value.configuredAt : new Date(0).toISOString(),
  };
}

function isValidToolCallVisibility(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordToolCallVisibility>;
  return [entry.channels, entry.threads, entry.dms].every((setting) => setting === undefined || typeof setting === "boolean");
}

function isValidChannelReplies(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DiscordChannelReplies>;
  if (entry.mode !== undefined && !["always-thread", "channel", "auto"].includes(entry.mode)) return false;
  if (entry.escalate !== undefined && typeof entry.escalate !== "boolean") return false;
  if (entry.followUp !== undefined && typeof entry.followUp !== "boolean") return false;
  if (entry.contextMessages !== undefined &&
      (!Number.isInteger(entry.contextMessages) || entry.contextMessages < 0 || entry.contextMessages > 25)) return false;
  if (entry.routerModel !== undefined && !isModelChoice(entry.routerModel)) return false;
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
    ...(isModelChoice(entry.routerModel) ? { routerModel: entry.routerModel } : {}),
    escalate: entry.escalate !== false,
    followUp: entry.followUp !== false,
  };
}

function isDiscordAllowlist(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && (
    (value.length === 1 && value[0] === "*") || value.every(isDiscordSnowflake)
  );
}

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}
