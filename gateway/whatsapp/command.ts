import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshProviderCatalogs } from "../../providers/refresh.js";
import { getAvailablePickerModels } from "../../ux/available-models.js";
import { defaultThinkingSetting } from "../default-thinking.js";
import { withDiscordDialogSession } from "../dialog-session.js";
import { DiscordInputDialog } from "../input-dialog.js";
import { selectDiscordModel } from "../model-dialog.js";
import { runGatewaySettingsPage } from "../settings-page.js";
import { selectGatewayTimezone, timezoneLabel } from "../timezones.js";
import { readGatewayPid, resolvePiInvocation } from "../runtime/process.js";
import { DEFAULT_SESSION_ROLLOVER, isValidSessionRollover, type SessionRolloverPolicy } from "../runtime/session-rollover.mjs";
import { PairingQrView } from "./qr.js";
import { acquireLock, gatewayPaths, PAIR_TIMEOUT_MS, PHONE, prepareDirectory, readConfig, readJson, removeAuth, writeJson, type WhatsAppConfig } from "./storage.mjs";

type Paths = ReturnType<typeof gatewayPaths>;
interface DaemonStatus { pid?: number; state?: string; detail?: string; instance?: string; }
const ACTIONS = ["setup", "configure", "start", "restart", "stop", "status", "logs", "teardown"];
const HELP = `/whatsapp ${ACTIONS.join("|")}`;

export async function handleWhatsAppCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const paths = gatewayPaths();
  let action = args.trim().toLowerCase();
  try {
    if (!action || action === "status") {
      const pid = readGatewayPid(paths.pid);
      const status = readJson(paths.status) as DaemonStatus | undefined;
      const configured = existsSync(paths.config);
      const linked = configured && await hasPairing(paths, status);
      const title = statusLine(pid, status, configured, linked);
      if (action === "status" || ctx.mode !== "tui") return output(ctx, title);
      if (!linked) {
        // Another terminal may still be scanning. Don't offer to replace its link.
        if (pid) return output(ctx, title);
        action = "setup";
      } else {
        const choices = [...(pid ? ["Restart", "Stop"] : ["Start"]), "Settings", "View logs", "Remove configuration"];
        const choice = await ctx.ui.select(title, choices);
        if (!choice) return;
        action = choice === "Settings" ? "configure" : choice === "View logs" ? "logs" :
          choice === "Remove configuration" ? "teardown" : choice.toLowerCase();
      }
    }
    if (action === "logs") return output(ctx, recentLogs(paths));
    if (!ACTIONS.includes(action)) return output(ctx, HELP);
    if (ctx.mode !== "tui") return output(ctx, "Manage the WhatsApp gateway from the local Pi terminal.", "warning");
    prepareDirectory(paths.directory);
    const release = await acquireLock(paths, "command").catch(() => {
      throw new Error("Another WhatsApp management command is in progress or its lock is unavailable.");
    });
    try { await manage(ctx, paths, action); }
    finally { await release(); }
  } catch (error) {
    // Do not surface library error bodies, paths, or auth data in UI output.
    output(ctx, error instanceof UserError ? error.message : "WhatsApp gateway operation failed. Check the workspace, status, and logs locally.", "error");
  }
}

class UserError extends Error {}

async function manage(ctx: ExtensionCommandContext, paths: Paths, action: string) {
  if (action === "teardown") {
    if (!await ctx.ui.confirm("Remove WhatsApp gateway configuration?", "Stops the daemon and deletes local pairing credentials and configuration. Pi conversations and logs are kept. Revoke the linked device separately in WhatsApp.")) return;
    await stop(paths);
    await clearLink(paths, true);
    output(ctx, "WhatsApp configuration removed. Unlink the device in WhatsApp to revoke it.");
    return;
  }
  if (action === "stop") {
    await stop(paths);
    output(ctx, "WhatsApp gateway is stopped.");
    return;
  }
  const existing = readConfig(paths.config);
  if (action === "configure") {
    if (!existing) throw new UserError("Run /whatsapp setup first.");
    await withDiscordDialogSession(ctx, (dialogCtx) => showSettings(dialogCtx, paths));
    return;
  }
  if (action === "setup") {
    if (process.env.PI_TUI_WRITE_LOG || process.env.PI_TUI_DEBUG_REDRAW === "1" || process.env.PI_TUI_DEBUG === "1") {
      throw new UserError("Disable Pi terminal debugging before displaying a pairing QR code.");
    }
    const config = await chooseConfig(ctx, existing);
    if (!config) return;
    if (!await ctx.ui.confirm("Pair a WhatsApp linked device?", "Baileys is unofficial and may put the linked account at risk. Setup replaces any saved link; unlink the old device in WhatsApp if needed. Only scan from the account you want Pi to use.")) return;
    await stop(paths);
    await clearLink(paths);
    writeJson(paths.config, config);
    await pair(ctx, paths);
    return;
  }
  if (!existing || !await hasPairing(paths, readJson(paths.status) as DaemonStatus | undefined)) {
    throw new UserError("Run /whatsapp setup to pair first.");
  }
  if (action === "start" && readGatewayPid(paths.pid)) throw new UserError("The WhatsApp gateway is already running.");
  if (action === "restart") await stop(paths);
  await start(paths);
  output(ctx, "WhatsApp gateway started in the background. Use /whatsapp status to check the connection.");
}

function input(ctx: ExtensionCommandContext, title: string, instruction: string, initialValue: string) {
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
    new DiscordInputDialog(tui, theme, title, instruction, initialValue, "", done, keys));
}

async function chooseAllowedPhones(ctx: ExtensionCommandContext, current: string[] = [], confirmAll = false) {
  const allowlist = await input(ctx, "Allowed WhatsApp numbers", "Comma-separated with country codes; blank blocks everyone.", current.map((phone) => `+${phone}`).join(", "));
  if (allowlist === undefined) return undefined;
  const allowedPhones = [...new Set(allowlist.split(/[,\s]+/).filter(Boolean).map((phone) => phone.replace(/^\+/, "")))];
  if (allowedPhones.length > 100 || !allowedPhones.every((phone) => PHONE.test(phone))) {
    throw new UserError("Use up to 100 international phone numbers with digits and an optional leading +. Wildcards are not supported.");
  }
  if (allowedPhones.some((phone) => confirmAll || !current.includes(phone)) && !await ctx.ui.confirm("Grant Pi tool access to these senders?", "Allowed senders can ask Pi to run shell commands and edit local files with your OS permissions. Only allow people you trust with that access.")) return undefined;
  return allowedPhones;
}

async function resolveWorkspace(ctx: ExtensionCommandContext, value: string) {
  const absolute = resolve(ctx.cwd, value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
  if (!existsSync(absolute)) {
    if (!await ctx.ui.confirm("Create workspace?", absolute)) return undefined;
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  if (!statSync(absolute).isDirectory()) throw new UserError("The workspace must be a directory.");
  return realpathSync(absolute);
}

async function chooseConfig(ctx: ExtensionCommandContext, existing?: WhatsAppConfig): Promise<WhatsAppConfig | undefined> {
  const defaultWorkspace = existing?.cwd ?? "~/pi-workspaces/whatsapp-gateway";
  const value = await input(ctx, "WhatsApp gateway workspace", "This is a starting directory, not a sandbox.", defaultWorkspace);
  if (value === undefined) return undefined;
  const allowedPhones = await chooseAllowedPhones(ctx, existing?.allowedPhones, true);
  if (!allowedPhones) return undefined;
  const cwd = await resolveWorkspace(ctx, value.trim() || defaultWorkspace);
  if (!cwd) return undefined;
  return {
    version: 1, cwd, allowedPhones,
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : existing?.model ? { model: existing.model } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
    ...(existing?.dmSessions ? { dmSessions: existing.dmSessions } : {}),
  };
}

async function showSettings(ctx: ExtensionCommandContext, paths: Paths) {
  const restartHint = "Run /whatsapp restart to apply this to new conversations; saved conversations keep their settings.";
  function save(update: Partial<WhatsAppConfig>, message: string) {
    const current = readConfig(paths.config);
    if (!current) throw new UserError("Run /whatsapp setup first.");
    writeJson(paths.config, { ...current, ...update });
    output(ctx, message);
  }

  await runGatewaySettingsPage(ctx, { title: "WhatsApp Settings", gatewayLabel: "WhatsApp gateway", searchable: true }, () => {
    const config = readConfig(paths.config);
    if (!config) return undefined;
    const selectedModel = config.model ? `${config.model.provider}/${config.model.id}` : "";
    const dmSessions = { ...DEFAULT_SESSION_ROLLOVER, ...config.dmSessions };
    return [
      { kind: "input", id: "users", label: "Allowed users",
        currentValue: config.allowedPhones.length ? `${config.allowedPhones.length} allowed` : "none (blocked)",
        description: "Only these phone numbers can send DMs to Pi. Changes apply immediately; blank blocks everyone.",
        async open() {
          const allowedPhones = await chooseAllowedPhones(ctx, config.allowedPhones);
          if (allowedPhones && allowedPhones.join() !== config.allowedPhones.join()) save({ allowedPhones }, "WhatsApp allowlist updated.");
        } },
      { kind: "input", id: "workspace", label: "Workspace", currentValue: config.cwd,
        description: `Starting directory, not a filesystem sandbox. ${restartHint}`,
        async open() {
          const value = await input(ctx, "WhatsApp gateway workspace", "Leave blank to keep the current workspace.", config.cwd);
          if (!value?.trim()) return;
          const cwd = await resolveWorkspace(ctx, value.trim());
          if (cwd && cwd !== config.cwd) save({ cwd }, `WhatsApp workspace updated. ${restartHint}`);
        } },
      { kind: "picker", id: "default-model", label: "Default model", currentValue: selectedModel || "Pi default",
        description: `Choose a model for new WhatsApp conversations or follow Pi's default. ${restartHint}`,
        async open() {
          const refresh = refreshProviderCatalogs(ctx);
          const models = (await getAvailablePickerModels(ctx))
            .map((model) => ({ value: `${model.provider}/${model.id}`, model }))
            .sort((a, b) => a.value.localeCompare(b.value));
          const choices = [{ value: "", label: "Pi default", description: "Use Pi's configured default at startup" },
            ...models.map(({ value, model }) => ({ value, label: value, description: model.name }))];
          const selected = await selectDiscordModel(ctx, choices, selectedModel, refresh,
            { title: "WhatsApp Default Model", description: "Used when new WhatsApp conversations start." });
          if (selected === undefined || selected === selectedModel) return;
          const model = models.find(({ value }) => value === selected)?.model;
          if (selected && !model) return;
          save({ model: model ? { provider: model.provider, id: model.id } : undefined }, `WhatsApp default model updated. ${restartHint}`);
        } },
      defaultThinkingSetting(ctx, config.model, config.thinkingLevel, restartHint,
        (thinkingLevel) => save({ thinkingLevel }, `WhatsApp default thinking updated. ${restartHint}`)),
      { kind: "group", id: "dm-sessions", label: "DM sessions",
        currentValue: dmSessions.enabled ? `${resetHourLabel(dmSessions.resetHour)} · ${dmSessions.timezone} · ${dmSessions.idleHours}h quiet` : "overnight rollover off",
        description: "Configure when an idle DM starts with fresh context. Changes apply to incoming DMs without a restart.",
        open: () => showDmSessionSettings(ctx, paths, (settings) =>
          save({ dmSessions: settings }, "WhatsApp DM session settings updated. No restart is needed.")) },
    ];
  });
}

function resetHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

async function showDmSessionSettings(
  ctx: ExtensionCommandContext, paths: Paths, save: (settings: Partial<SessionRolloverPolicy>) => void,
) {
  await runGatewaySettingsPage(ctx, {
    title: "DM sessions", gatewayLabel: "WhatsApp gateway",
    description: "The next DM starts with fresh context after a quiet daily boundary. A busy boundary is skipped for the day. Old session files are kept.",
  }, () => {
    const config = readConfig(paths.config);
    if (!config) return undefined;
    const saved = config.dmSessions;
    const current = { ...DEFAULT_SESSION_ROLLOVER, ...saved };
    function update(patch: Partial<SessionRolloverPolicy>) {
      const next = { ...saved, ...patch };
      if (!isValidSessionRollover(next)) throw new UserError("Use a valid timezone, a reset hour from 0 to 23, and an inactivity window from 1 to 168 hours.");
      save(next);
    }
    async function editNumber(field: "resetHour" | "idleHours", title: string, instruction: string) {
      const value = await input(ctx, title, instruction, String(current[field]));
      if (value !== undefined) {
        const next = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
        if (next !== current[field]) update({ [field]: next });
      }
    }
    return [
      { kind: "inline", id: "rollover", label: "Overnight rollover", currentValue: current.enabled ? "on" : "off",
        description: "Start with fresh context after a quiet daily boundary instead of resuming the previous conversation.",
        values: ["on", "off"], change: (value) => update({ enabled: value === "on" }) },
      { kind: "picker", id: "timezone", label: "Timezone", currentValue: timezoneLabel(current.timezone),
        description: `Sets the local timezone for rollover. If unset, uses the machine timezone (${DEFAULT_SESSION_ROLLOVER.timezone}).`,
        async open() {
          const timezone = await selectGatewayTimezone(ctx, current.timezone);
          if (timezone !== undefined && timezone !== current.timezone) update({ timezone });
        } },
      { kind: "input", id: "reset-hour", label: "Reset hour", currentValue: resetHourLabel(current.resetHour),
        description: "Local hour at which each day's rollover eligibility is evaluated.",
        open: () => editNumber("resetHour", "Reset hour", "Whole hour in the selected timezone (0–23).") },
      { kind: "input", id: "idle-hours", label: "Inactivity window", currentValue: `${current.idleHours}h`,
        description: "Required quiet time before the daily boundary. Activity exactly at the cutoff skips that day's rollover.",
        open: () => editNumber("idleHours", "Inactivity window", "Whole hours without accepted DMs (1–168).") },
    ];
  });
}

async function stop(paths: Paths) {
  const pid = readGatewayPid(paths.pid);
  if (!pid) return;
  const status = readJson(paths.pid) as DaemonStatus | undefined;
  if (status?.pid !== pid || !status.instance) throw new UserError("Could not verify which WhatsApp daemon to stop.");
  writeJson(paths.stopRequest, { instance: status.instance });
  const deadline = Date.now() + 42_000;
  while (Date.now() < deadline) {
    if (readGatewayPid(paths.pid) !== pid) return;
    await delay(150);
  }
  throw new UserError("The WhatsApp daemon did not stop in time; configuration was not removed.");
}

async function clearLink(paths: Paths, teardown = false) {
  // The daemon releases its lock just after removing the PID file.
  const release = await acquireDaemonLock(paths);
  try {
    if (readGatewayPid(paths.pid)) throw new UserError("Stop the WhatsApp daemon before removing its credentials.");
    removeAuth(paths);
    if (teardown) {
      for (const path of [paths.config, paths.status, paths.stopRequest]) rmSync(path, { force: true });
    }
  } finally { await release(); }
}

async function acquireDaemonLock(paths: Paths) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await acquireLock(paths, "daemon"); }
    catch { await delay(200); }
  }
  throw new UserError("The WhatsApp daemon still owns its files. Try again shortly.");
}

function launch(paths: Paths, pairing: boolean) {
  const pi = resolvePiInvocation();
  if (!pi) throw new UserError("Could not locate the Pi CLI.");
  if (!process.versions.node || Number(process.versions.node.split(".")[0]) < 20) throw new UserError("Baileys requires Node.js 20 or newer.");
  const fd = openSync(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    return spawn(process.execPath, [fileURLToPath(new URL("./daemon.mjs", import.meta.url)), pairing ? "pair" : "start"], {
      detached: true, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"],
      env: { ...process.env, PI_CODING_AGENT_DIR: dirname(paths.directory),
        PI_ENHANCED_WHATSAPP_PI_EXECUTABLE: pi.executable, PI_ENHANCED_WHATSAPP_PI_ARGS: JSON.stringify(pi.args) },
    });
  } finally { closeSync(fd); }
}

type LaunchResult = { ok: true } | { ok: false; detail?: string };

function observeLaunch(child: ChildProcess, pairing: boolean, onQr?: (qr?: string) => void) {
  let succeeded = false;
  let detail: string | undefined;
  let finish: (result: LaunchResult) => void = () => {};
  const result = new Promise<LaunchResult>((resolve) => { finish = resolve; });
  child.on("message", (value) => {
    const message = value as { type?: string; qr?: string; detail?: string } | null;
    if (message?.type === "error") detail = message.detail;
    if (message?.type === "qr" && pairing) onQr?.(message.qr);
    if (message?.type === (pairing ? "paired" : "started")) {
      succeeded = true;
      child.unref();
      finish({ ok: true });
    }
  });
  child.once("exit", () => finish({ ok: false, detail }));
  child.once("error", () => finish({ ok: false, detail }));
  child.once("disconnect", () => { if (!succeeded) finish({ ok: false, detail }); });
  return result;
}

async function stopUnfinishedChild(child: ChildProcess) {
  if (child.connected) child.disconnect();
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  await Promise.race([exited, delay(2000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  child.unref();
}

async function start(paths: Paths) {
  // Wait for a previous daemon to finish releasing the file lock after stop.
  const release = await acquireDaemonLock(paths);
  await release();
  const child = launch(paths, false);
  const result = await Promise.race([
    observeLaunch(child, false), delay(10_000, { ok: false as const }, { ref: false }),
  ]);
  if (!result.ok) {
    await stopUnfinishedChild(child);
    throw new UserError(("detail" in result && result.detail) || "The WhatsApp daemon could not start. Check /whatsapp logs.");
  }
}

async function pair(ctx: ExtensionCommandContext, paths: Paths) {
  const child = launch(paths, true);
  let refresh = () => {};
  let closed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const view = new PairingQrView(() => refresh());
  const result = observeLaunch(child, true, (qr) => { if (!closed) view.setCode(qr); });
  let outcome: LaunchResult | undefined;
  // Newer Pi versions can also report this native dialog as waiting for auth.
  const dialogOptions = { overlay: false, blocked: { kind: "auth" as const, message: "Pair WhatsApp" } };
  try {
    outcome = await ctx.ui.custom<LaunchResult | undefined>((tui, theme, keys, done) => {
      refresh = () => tui.requestRender();
      const finish = (value?: LaunchResult) => {
        if (closed) return;
        closed = true;
        done(value);
      };
      // The daemon's timer is primary; cover a failed/hung startup too.
      timeout = setTimeout(() => finish({ ok: false, detail: "WhatsApp pairing timed out." }), PAIR_TIMEOUT_MS + 5000);
      timeout.unref();
      void result.then(finish);
      const border = new DynamicBorder((line) => theme.fg("border", line));
      return {
        capturesViewportInput: true,
        render: (width) => view.render(width, tui.terminal.rows, theme.fg("accent", "Pair WhatsApp"),
          theme.fg("dim", "Esc cancels pairing"), () => border.render(width)[0] ?? ""),
        invalidate() { view.invalidate(); },
        handleInput(data) {
          if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.interrupt")) finish();
        },
      };
    }, dialogOptions);
  } finally {
    closed = true;
    clearTimeout(timeout);
    refresh = () => {};
    view.clear();
    if (!outcome?.ok) await stopUnfinishedChild(child);
  }
  if (!outcome) return output(ctx, "Pairing cancelled. If you scanned the QR, remove the device in WhatsApp.");
  if (!outcome.ok) throw new UserError(outcome.detail || "Pairing failed. Check /whatsapp status and /whatsapp logs.");
  output(ctx, "WhatsApp is linked and the gateway is running in the background.");
}

async function hasPairing(paths: Paths, status?: DaemonStatus) {
  if (status?.state === "needs-pairing" || !existsSync(paths.auth)) return false;
  const { hasSavedLink } = await import("./auth.mjs");
  return hasSavedLink(paths.auth);
}

function statusLine(pid: number | undefined, status: DaemonStatus | undefined, configured: boolean, linked: boolean) {
  if (pid && status?.pid !== pid) return "WhatsApp gateway: starting";
  if (pid || status?.state === "needs-pairing" || status?.state === "failed") {
    return `WhatsApp gateway: ${status?.state ?? "starting"}${status?.detail ? ` — ${status.detail}` : ""}`;
  }
  if (linked) return "WhatsApp gateway: stopped";
  return configured ? "WhatsApp gateway: needs pairing. Run /whatsapp setup." : "WhatsApp gateway: not configured";
}

function recentLogs(paths: Paths) {
  if (!existsSync(paths.log)) return "No WhatsApp gateway log yet.";
  const fd = openSync(paths.log, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return "No WhatsApp gateway log yet.";
    const bytes = Buffer.alloc(Math.min(info.size, 8192));
    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
    return bytes.toString("utf8", 0, count).trim().split("\n").slice(-16).join("\n") || "No WhatsApp gateway log yet.";
  } finally { closeSync(fd); }
}

function output(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(text, type);
  else console.log(text);
}
