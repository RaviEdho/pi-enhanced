import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateJson } from "./persistence.mjs";
import { log, safeErrorName } from "./logging.mjs";
import { onceExit } from "./pi-rpc.mjs";

/** Process status, graceful draining, and replacement-daemon handoff. */
export function createLifecycle({ client, config, paths, daemonPath, sessions, interactions, closeCommands }) {
  const { configPath, pidPath, statusPath, restartRequestPath, logPath } = paths;
  let activeMessageHandlers = 0;
  let pendingMessageTasks = 0;
  let restartRequested = false;
  let restartStarted = false;
  let shuttingDown = false;
  let idleCleanupTimer;
  let restartRequestPollTimer;
  const startedAt = new Date().toISOString();
  let gatewayStatus = { pid: process.pid, state: "starting", startedAt, updatedAt: startedAt };

  function writeStatus() {
    gatewayStatus.updatedAt = new Date().toISOString();
    writePrivateJson(statusPath, gatewayStatus);
  }

  function updateStatus(state, fields = {}) {
    gatewayStatus = { ...gatewayStatus, ...fields, pid: process.pid, state, updatedAt: new Date().toISOString() };
    writeStatus();
  }

  function checkRestartRequest() {
    if (shuttingDown || restartRequested || !restartRequestPath || !existsSync(restartRequestPath)) return;
    let request;
    try {
      request = JSON.parse(readFileSync(restartRequestPath, "utf8"));
    } catch (error) {
      log(`Could not read gateway restart request: ${safeErrorName(error)}`);
      try { unlinkSync(restartRequestPath); } catch { /* best-effort cleanup */ }
      return;
    }
    if (request?.type !== "restart") {
      log("Ignored an invalid gateway control request");
      return;
    }
    restartRequested = true;
    updateStatus("restarting", { lastError: undefined });
    log(`Graceful restart requested${typeof request.reason === "string" && request.reason ? `: ${request.reason.slice(0, 200)}` : ""}; draining accepted messages`);
    maybeStartRequestedRestart();
  }

  function maybeStartRequestedRestart() {
    if (!restartRequested || restartStarted || shuttingDown || activeMessageHandlers > 0 || pendingMessageTasks > 0 || sessions.hasWork()) return;
    restartStarted = true;
    void shutdown("Discord agent requested restart", 0, true).catch((error) => {
      const summary = `Gateway restart failed: ${safeErrorName(error)}`;
      log(summary);
      updateStatus("failed", { lastError: summary });
      removeOwnPid();
      process.exit(1);
    });
  }

  function trackTask(promise) {
    pendingMessageTasks += 1;
    return promise.finally(() => {
      pendingMessageTasks -= 1;
      maybeStartRequestedRestart();
    });
  }

  async function handleMessage(task) {
    activeMessageHandlers += 1;
    try {
      await task();
    } catch (error) {
      log(`Message handling failed: ${safeErrorName(error)}`);
    } finally {
      activeMessageHandlers -= 1;
      maybeStartRequestedRestart();
    }
  }

  async function shutdown(reason, exitCode = 0, restart = false) {
    if (shuttingDown) return;
    shuttingDown = true;
    const failureMessage = exitCode !== 0 ? gatewayStatus.lastError || "Gateway process terminated unexpectedly." : undefined;
    clearInterval(idleCleanupTimer);
    clearInterval(restartRequestPollTimer);
    if (!restart) updateStatus("stopping", { lastError: undefined });
    log(`Shutting down (${reason})`);
    interactions.close();
    closeCommands();
    await sessions.close();

    if (restart && exitCode === 0) {
      try {
        const replacementPid = await spawnReplacementGateway();
        log(`Started replacement Discord gateway (PID ${replacementPid})`);
        await destroyDiscordClient();
        process.exit(0);
      } catch (error) {
        const summary = `Could not restart Discord gateway: ${error instanceof Error ? error.message : String(error)}`;
        log(summary);
        updateStatus("failed", { lastError: summary });
        await sendHomeNotification(`Discord gateway restart failed: ${summary}`);
        await destroyDiscordClient();
        removeOwnPid();
        process.exit(1);
      }
    }
    if (exitCode === 0) {
      updateStatus("stopped", { lastError: undefined });
      await sendHomeNotification("Discord gateway stopped.");
    } else {
      updateStatus("failed", { lastError: failureMessage });
      await sendHomeNotification(`Discord gateway failed: ${failureMessage}`);
    }
    await destroyDiscordClient();
    removeOwnPid();
    process.exit(exitCode);
  }

  async function destroyDiscordClient() {
    try {
      await client.destroy();
    } catch {
      // The Discord client may not have completed login.
    }
  }

  async function spawnReplacementGateway() {
    if (restartRequestPath && existsSync(restartRequestPath)) unlinkSync(restartRequestPath);
    const logFd = logPath ? openSync(logPath, "a", 0o600) : undefined;
    let child;
    try {
      // Always restart the entry point, never this extracted lifecycle module.
      child = spawn(process.execPath, [daemonPath], {
        cwd: process.cwd(), detached: true,
        stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
        env: { ...process.env, PI_ENHANCED_DISCORD_START_REASON: "replacement" },
        windowsHide: true,
      });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (!child.pid) throw new Error("replacement process did not receive a PID");
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("replacement process exited before initializing");
      let status;
      try {
        status = JSON.parse(readFileSync(statusPath, "utf8"));
      } catch {
        // The replacement has not written its startup status yet.
      }
      if (status?.pid === child.pid && status.state === "ready") return child.pid;
      if (status?.pid === child.pid && status.state === "failed") {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        throw new Error(status.lastError || "replacement process failed to initialize");
      }
      await delay(100);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([onceExit(child), delay(3000)]);
    }
    throw new Error("replacement process did not initialize within 15 seconds");
  }

  function removeOwnPid() {
    try {
      const recordedPid = JSON.parse(readFileSync(pidPath, "utf8"))?.pid;
      if (recordedPid === process.pid) unlinkSync(pidPath);
    } catch {
      // The launcher or replacement may have already changed the PID file.
    }
  }

  async function sendHomeNotification(text) {
    let homeChannelId = config.homeChannelId;
    try {
      const latestConfig = JSON.parse(readFileSync(configPath, "utf8"));
      homeChannelId = typeof latestConfig.homeChannelId === "string" && /^\d{17,20}$/.test(latestConfig.homeChannelId)
        ? latestConfig.homeChannelId : undefined;
    } catch {
      // Keep the in-memory destination when the config is unavailable.
    }
    if (!homeChannelId) return;
    try {
      const channel = await client.channels.fetch(homeChannelId);
      if (!channel || typeof channel.send !== "function") throw new Error("configured home channel is unavailable or cannot receive messages");
      await channel.send({ content: text, allowedMentions: { parse: [] } });
      log(`Sent home-channel notification: ${text}`);
    } catch (error) {
      log(`Could not send home-channel notification: ${safeErrorName(error)}`);
    }
  }

  function start() {
    writePrivateJson(pidPath, { pid: process.pid, startedAt });
    writeStatus();
    idleCleanupTimer = setInterval(() => { void sessions.closeIdle(); }, 60_000);
    idleCleanupTimer.unref();
    if (restartRequestPath) {
      restartRequestPollTimer = setInterval(checkRestartRequest, 250);
      restartRequestPollTimer.unref();
    }
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("uncaughtException", (error) => {
      const summary = `Uncaught error: ${safeErrorName(error)}`;
      updateStatus("failed", { lastError: summary });
      log(summary);
      void shutdown("uncaughtException", 1);
    });
    process.on("unhandledRejection", (error) => { log(`Unhandled rejection: ${safeErrorName(error)}`); });
  }

  return {
    start, updateStatus, shutdown, sendHomeNotification, trackTask, handleMessage,
    isStopping: () => restartRequested || shuttingDown,
    isShuttingDown: () => shuttingDown,
    recordEvent: () => updateStatus(gatewayStatus.state, { lastEventAt: new Date().toISOString() }),
  };
}
