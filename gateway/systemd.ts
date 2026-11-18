import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { SYSTEMD_RESTART_EXIT } from "./runtime/process.js";
import { writePrivateJson, type DiscordGatewayPaths } from "./storage.js";

const run = promisify(execFile);
const UNIT_MARKER = "# Managed by pi-enhanced /discord Start at boot\n";

export function createGatewayBootService(paths: DiscordGatewayPaths) {
  let directory = paths.directory;
  try { directory = realpathSync(directory); } catch { /* Not configured yet. */ }
  const id = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  const unit = `pi-enhanced-discord-${id}.service`;
  const configHome = process.env.XDG_CONFIG_HOME;
  const units = join(configHome && isAbsolute(configHome) ? configHome : join(homedir(), ".config"), "systemd", "user");
  const unitPath = join(units, unit);
  const launchPath = join(directory, "systemd-launch.json");
  const supported = process.platform === "linux";

  async function systemctl(...args: string[]) {
    try {
      const { stdout } = await run("systemctl", ["--user", "--no-pager", ...args], { timeout: 30_000 });
      return stdout.trim();
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
      throw new Error(stderr || `systemctl --user ${args[0]} failed. Check that the systemd user manager is available.`);
    }
  }

  function isInstalled() {
    try { return readFileSync(unitPath, "utf8").startsWith(UNIT_MARKER); } catch { return false; }
  }

  async function inspect() {
    const installed = supported && isInstalled();
    const inactive = { enabled: false, active: false, failed: false, unavailable: false };
    if (!installed) return inactive;
    try {
      const fields = new Map((await systemctl("show", unit, "-p", "ActiveState", "-p", "UnitFileState")).split("\n").map((line) => line.split("=", 2) as [string, string]));
      const state = fields.get("ActiveState");
      return { ...inactive, enabled: fields.get("UnitFileState") === "enabled", active: Boolean(state && state !== "inactive" && state !== "failed"), failed: state === "failed" };
    } catch {
      return { ...inactive, unavailable: true };
    }
  }

  async function enable(node: string, launcher: string, launchEnv: Record<string, string>) {
    if (!supported) throw new Error("Start at boot requires Linux with a systemd user manager.");
    await systemctl("show-environment");
    let linger;
    try {
      linger = (await run("loginctl", ["show-user", String(process.getuid!()), "--property=Linger", "--value"], { timeout: 5_000 })).stdout.trim();
    } catch {
      throw new Error("Could not check systemd user lingering. Start at boot requires lingering for this account.");
    }
    if (linger !== "yes") throw new Error("Start at boot requires user lingering. Run `loginctl enable-linger` (or ask your administrator), then try again.");
    if (existsSync(unitPath) && !isInstalled()) throw new Error(`Will not overwrite an existing systemd unit: ${unitPath}`);
    const content = UNIT_MARKER + [
      "[Unit]",
      "Description=Pi Enhanced Discord gateway",
      // Allow slow networking at boot, but do not loop forever on bad credentials.
      "StartLimitIntervalSec=5min",
      "StartLimitBurst=24",
      "[Service]",
      "Type=exec",
      `ExecStart=:${[node, launcher, launchPath].map(quoteExecArg).join(" ")}`,
      "UMask=0077",
      `StandardOutput=append:${unitPathValue(paths.log)}`,
      "StandardError=inherit",
      "KillMode=mixed",
      "TimeoutStopSec=20s",
      "Restart=on-failure",
      "RestartSec=5s",
      "RestartPreventExitStatus=78",
      `SuccessExitStatus=${SYSTEMD_RESTART_EXIT}`,
      `RestartForceExitStatus=${SYSTEMD_RESTART_EXIT}`,
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    mkdirSync(units, { recursive: true });
    writePrivateJson(launchPath, launchEnv);
    writeFileSync(unitPath, content, { mode: 0o600 });
    await systemctl("daemon-reload");
    await systemctl("enable", unit);
    try {
      await systemctl("start", unit);
    } catch (error) {
      await systemctl("disable", unit).catch(() => {});
      throw error;
    }
  }

  async function remove() {
    if (!supported || !isInstalled()) return;
    await systemctl("disable", unit);
    await systemctl("stop", unit);
    rmSync(unitPath);
    rmSync(launchPath, { force: true });
    await systemctl("daemon-reload");
  }

  return {
    supported, inspect, enable, remove,
    disable: () => systemctl("disable", unit),
    start: () => systemctl("start", unit),
    stop: () => systemctl("stop", unit),
  };
}

function unitPathValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Start at boot does not support paths containing control characters.");
  return value.replaceAll("%", "%%");
}

function quoteExecArg(value: string): string {
  return `"${unitPathValue(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
