import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "../runtime/logging.mjs";
import { PiRpcSession } from "../runtime/pi-rpc.mjs";
import { gatewayPidRecord, readGatewayPid } from "../runtime/process.js";
import { createSessionManager } from "../runtime/sessions.mjs";
import { validateWorkspaceDirectory } from "../runtime/workspace.mjs";
import { openAuthStore } from "./auth.mjs";
import { createWhatsAppConnection } from "./connection.mjs";
import { createDmSessionRollover } from "./dm-sessions.mjs";
import { createDmRouter } from "./dms.mjs";
import { whatsappPiTransport } from "./pi-ui.mjs";
import { acquireLock, gatewayPaths, PAIR_TIMEOUT_MS, prepareDirectory, readConfig, readJson, removeAuth, writeJson } from "./storage.mjs";

process.umask(0o077);
const paths = gatewayPaths();
const startedAt = new Date().toISOString();
const instance = randomUUID();
const record = { ...gatewayPidRecord(process.pid, startedAt), instance };
const wantsPairing = process.argv[2] === "pair" && Boolean(process.connected);
let paired = false;
let ownsPid = false;
let stopping = false;
let release;
let sessions;
let connection;
let pairingTimeout;
let idleTimer;
let controlTimer;

function ipc(message, disconnect = false) {
  if (!process.connected) return;
  process.send(message, () => {
    if (disconnect && process.connected) process.disconnect();
  });
}

function report(state, detail) {
  if (!ownsPid) return;
  try {
    writeJson(paths.status, { pid: record.pid, instance, state, detail, startedAt, updatedAt: new Date().toISOString() });
  } catch { log("Could not write WhatsApp gateway status."); }
  log(`WhatsApp gateway: ${state}${detail ? `. ${detail}` : "."}`);
}

async function shutdown(state = "stopped", detail, drain = false) {
  if (stopping) return;
  stopping = true;
  clearInterval(controlTimer);
  clearInterval(idleTimer);
  clearTimeout(pairingTimeout);
  if (drain) {
    report("stopping");
    const deadline = Date.now() + 30_000;
    while (sessions?.hasWork() && Date.now() < deadline) await delay(100);
  }
  connection?.close();
  await sessions?.close({ force: true }).catch(() => log("Could not cleanly close all WhatsApp Pi sessions."));
  if (ownsPid) {
    if (wantsPairing && !paired) {
      try { removeAuth(paths); } catch { log("Could not remove partial WhatsApp credentials."); }
    }
    report(state, detail);
  }
  if (process.connected && detail) ipc({ type: "error", detail });
  try {
    if (ownsPid && readJson(paths.pid)?.instance === instance) rmSync(paths.pid, { force: true });
  } catch { log("Could not remove the WhatsApp daemon PID record."); }
  try { await release?.(); } catch { /* lock is already unavailable */ }
  // Give the startup/QR UI the terminal status before exiting.
  if (process.connected) {
    await new Promise((resolve) => process.send({ type: "closed", detail }, resolve));
    if (process.connected) process.disconnect();
  }
  process.exit(state === "failed" || state === "needs-pairing" ? 1 : 0);
}

process.on("SIGTERM", () => { void shutdown("stopped", undefined, true); });
process.on("SIGINT", () => { void shutdown(); });
process.on("disconnect", () => { if (wantsPairing && !paired) void shutdown(); });
// Do not let unhandled library errors dump auth material or raw stanzas.
process.on("uncaughtException", () => { void shutdown("failed", "Unexpected WhatsApp gateway error."); });
process.on("unhandledRejection", () => { void shutdown("failed", "Unexpected WhatsApp gateway error."); });

async function main() {
  prepareDirectory(paths.directory);
  try {
    release = await acquireLock(paths, "daemon", () => { void shutdown("failed", "Lost the WhatsApp daemon lock."); });
    if (readGatewayPid(paths.pid)) throw new Error("already running");
  } catch {
    await shutdown("failed", "A WhatsApp gateway is already running or its lock is unavailable.");
    return;
  }
  if (stopping) return;
  writeJson(paths.pid, record);
  ownsPid = true;
  if (wantsPairing && !process.connected) {
    await shutdown();
    return;
  }
  const config = readConfig(paths.config);
  if (!config) {
    await shutdown("failed", "Run /whatsapp setup to configure the gateway.");
    return;
  }
  config.cwd = validateWorkspaceDirectory(config.cwd);
  const piExecutable = process.env.PI_ENHANCED_WHATSAPP_PI_EXECUTABLE;
  const piArgs = JSON.parse(process.env.PI_ENHANCED_WHATSAPP_PI_ARGS || "[]");
  delete process.env.PI_ENHANCED_WHATSAPP_PI_EXECUTABLE;
  delete process.env.PI_ENHANCED_WHATSAPP_PI_ARGS;
  if (!piExecutable || !Array.isArray(piArgs) || piArgs.some((arg) => typeof arg !== "string")) {
    await shutdown("failed", "Start the WhatsApp gateway from the local Pi terminal.");
    return;
  }
  const auth = openAuthStore(paths.auth, () => { void shutdown("failed", "Could not safely save WhatsApp credentials."); });
  if (!wantsPairing && !auth.account) {
    await shutdown("needs-pairing", "Run /whatsapp setup to pair the device.");
    return;
  }
  prepareDirectory(paths.sessions);
  const extensionRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  sessions = createSessionManager({
    sessionRoot: paths.sessions,
    createSession: (directory) => new PiRpcSession(directory, { config, piExecutable, piArgs, extensionRoot, transport: whatsappPiTransport }),
  });
  const router = createDmRouter({
    paths, sessions, rollover: createDmSessionRollover({ sessionRoot: paths.sessions, sessions }),
    isCurrent: (link) => connection.isLive(link),
    canAccept: (link) => !stopping && connection.isLive(link),
  });
  connection = createWhatsAppConnection({
    auth, pairing: wantsPairing, report, receive: router.receive,
    fail: (state, detail) => { void shutdown(state, detail); },
    showQr: (qr) => { if (wantsPairing && !paired) ipc({ type: "qr", qr }); },
    finishPairing: () => {
      paired = true;
      clearTimeout(pairingTimeout);
      ipc({ type: "paired" }, true);
    },
  });
  controlTimer = setInterval(() => {
    try {
      if (readJson(paths.stopRequest)?.instance === instance) void shutdown("stopped", undefined, true);
    } catch { /* ignore unreadable or unrelated requests */ }
  }, 300);
  idleTimer = setInterval(() => {
    void sessions.closeIdle().catch(() => log("Could not evict an idle WhatsApp Pi session."));
  }, 60_000);
  if (wantsPairing) {
    pairingTimeout = setTimeout(() => { void shutdown("failed", "WhatsApp pairing timed out. Run /whatsapp setup to try again."); }, PAIR_TIMEOUT_MS);
  } else {
    report("starting");
    ipc({ type: "started" }, true);
  }
  connection.start();
}

try {
  await main();
} catch {
  await shutdown("failed", "Could not initialize the WhatsApp gateway. Check the workspace and saved configuration.");
}
