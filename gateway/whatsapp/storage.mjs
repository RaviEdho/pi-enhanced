import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import lockfile from "proper-lockfile";
import { isValidSessionRollover } from "../runtime/session-rollover.mjs";

export const PHONE = /^[1-9]\d{6,14}$/;
export const PAIR_TIMEOUT_MS = 90_000;

export function gatewayPaths() {
  const directory = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "whatsapp-gateway");
  return {
    directory, config: join(directory, "config.json"), auth: join(directory, "auth.json"),
    sessions: join(directory, "sessions"), recent: join(directory, "recent.json"),
    status: join(directory, "status.json"), pid: join(directory, "pid.json"),
    stopRequest: join(directory, "stop.json"), log: join(directory, "gateway.log"),
  };
}

export function prepareDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("Gateway directory must not be a symlink.");
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

export async function acquireLock(paths, name, onCompromised) {
  // proper-lockfile indexes its heartbeat by target, not lockfilePath. Setup
  // holds the command lock while briefly taking the daemon lock, so each needs
  // a distinct target. Keep the on-disk lock paths compatible with old daemons.
  const path = join(realpathSync(paths.directory), `${name}.lock`);
  let compromised;
  // Sync lock operations keep heartbeat file I/O and release from interleaving
  // in the same process. Compromise must not throw from the heartbeat timer.
  const release = lockfile.lockSync(path, {
    realpath: false, lockfilePath: path, stale: 120_000,
    onCompromised(error) {
      compromised = error;
      onCompromised?.(error);
    },
  });
  return async () => {
    if (compromised) throw compromised;
    release();
  };
}

export function readJson(path, { maxBytes = 32 * 1024, reviver } = {}) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid gateway file");
    return JSON.parse(readFileSync(path, "utf8"), reviver);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeJson(path, value, { replacer, maxBytes } = {}) {
  const content = JSON.stringify(value, replacer) + "\n";
  if (maxBytes !== undefined && Buffer.byteLength(content) > maxBytes) throw new Error("Gateway data exceeds its storage limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Call while holding the daemon lock. A process killed during an atomic write
// can leave a temporary copy of credentials even if auth.json was never saved.
export function removeAuth(paths) {
  rmSync(paths.auth, { force: true });
  for (const name of readdirSync(paths.directory)) {
    if (/^auth\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) rmSync(join(paths.directory, name), { force: true });
  }
}

export function readConfig(path) {
  const value = readJson(path);
  if (!value) return undefined;
  if (value.version !== 1 || typeof value.cwd !== "string" || !value.cwd ||
      !Array.isArray(value.allowedPhones) || value.allowedPhones.length > 100 ||
      !value.allowedPhones.every((phone) => typeof phone === "string" && PHONE.test(phone)) ||
      (value.model !== undefined && (typeof value.model?.provider !== "string" || !value.model.provider ||
        typeof value.model.id !== "string" || !value.model.id)) ||
      (value.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)) ||
      (value.dmSessions !== undefined && !isValidSessionRollover(value.dmSessions))) {
    throw new Error("Invalid WhatsApp gateway configuration. Fix config.json or use /whatsapp teardown to start over.");
  }
  return value;
}
