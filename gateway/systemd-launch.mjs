import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadGatewayConfig } from "./runtime/config.mjs";
import { writePrivateJson } from "./runtime/persistence.mjs";
import { readGatewayPid } from "./runtime/process.js";
import { validateWorkspaceDirectory } from "./runtime/workspace.mjs";

// Remain the systemd MainPID through handoff, Discord login, and shutdown.
try {
  let env;
  try { env = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch { throw new Error("Missing or invalid gateway launch settings."); }
  Object.assign(process.env, env);
  process.env.PI_ENHANCED_DISCORD_SYSTEMD = "1";
  process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  const { config, paths } = loadGatewayConfig();
  process.chdir(validateWorkspaceDirectory(config.cwd));

  let requestedPid;
  for (let pid; (pid = readGatewayPid(paths.pidPath));) {
    let status;
    try { status = JSON.parse(readFileSync(paths.statusPath, "utf8")); } catch { /* PID can appear before status. */ }
    if (pid !== requestedPid && status?.pid === pid && status.state !== "stopping" && status.state !== "restarting" && !existsSync(paths.restartRequestPath)) {
      if (status.supervision !== "detached") {
        throw new Error("A gateway is already running. Restart an older detached gateway before enabling systemd.");
      }
      writePrivateJson(paths.restartRequestPath, {
        type: "handoff",
        reason: "Systemd is taking over the gateway",
      });
      requestedPid = pid;
    }
    await delay(250);
  }
  // Never replay a request left by a process that died before consuming it.
  rmSync(paths.restartRequestPath, { force: true });
} catch (error) {
  console.error(`Discord systemd launcher: ${error.message}`);
  process.exit(78);
}

await import("./daemon.mjs");
