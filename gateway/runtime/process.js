import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export const SYSTEMD_RESTART_EXIT = 75;

function linuxProcessIdentity(pid) {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The comm field can contain spaces and parentheses. Start time is field 22.
  const [state, ...fields] = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  return state !== "Z" && fields[18] ? `${boot}:${fields[18]}` : undefined;
}

export function gatewayPidRecord(pid, startedAt) {
  let identity;
  try { if (process.platform === "linux") identity = linuxProcessIdentity(pid); } catch { /* Process has already exited. */ }
  return { pid, startedAt, identity };
}

export function resolvePiInvocation() {
  const entrypoint = process.argv[1];
  if (entrypoint && existsSync(entrypoint) && /\.(?:mjs|cjs|js)$/i.test(entrypoint)) {
    return { executable: process.execPath, args: [resolve(entrypoint)] };
  }
  const pathEntries = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `pi${extension}`);
      if (existsSync(candidate)) return { executable: candidate, args: [] };
    }
  }
  return undefined;
}

export function readGatewayPid(path) {
  try {
    const { pid, identity } = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // Linux can reuse a stale PID after a crash/reboot. Never signal an unrelated process.
      const current = linuxProcessIdentity(pid);
      if (!current) return undefined;
      if (identity !== undefined) return current === identity ? pid : undefined;
      // Compatibility with PID files written before process identity was recorded.
      const [, entry] = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!entry?.endsWith("/gateway/daemon.mjs")) return undefined;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const recordedPath = env.find((value) => value.startsWith("PI_ENHANCED_DISCORD_PID_PATH="))?.slice("PI_ENHANCED_DISCORD_PID_PATH=".length);
      if (!recordedPath || realpathSync(recordedPath) !== realpathSync(path)) return undefined;
    }
    return pid;
  } catch {
    return undefined;
  }
}
