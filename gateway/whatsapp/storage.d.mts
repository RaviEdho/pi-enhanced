import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionRolloverPolicy } from "../runtime/session-rollover.mjs";

export interface WhatsAppConfig {
  version: 1;
  cwd: string;
  allowedPhones: string[];
  model?: { provider: string; id: string };
  thinkingLevel?: ModelThinkingLevel;
  dmSessions?: Partial<SessionRolloverPolicy>;
}
export const PHONE: RegExp;
export const PAIR_TIMEOUT_MS: number;
export function gatewayPaths(): Record<"directory" | "config" | "auth" | "sessions" | "recent" | "status" | "pid" | "stopRequest" | "log", string>;
export function prepareDirectory(directory: string): void;
export function acquireLock(paths: ReturnType<typeof gatewayPaths>, name: "command" | "daemon", onCompromised?: (error: Error) => void): Promise<() => Promise<void>>;
export function readJson(path: string, options?: { maxBytes?: number }): unknown;
export function writeJson(path: string, value: unknown): void;
export function removeAuth(paths: ReturnType<typeof gatewayPaths>): void;
export function readConfig(path: string): WhatsAppConfig | undefined;
