import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshProviderCatalogs } from "../providers/refresh.js";
import { getAvailablePickerModels } from "../ux/available-models.js";
import { DiscordConfirmationDialog, type DiscordConfirmationDialogOptions } from "./confirm-dialog.js";
import { DiscordInputDialog } from "./input-dialog.js";
import { withDiscordDialogSession } from "./dialog-session.js";
import { selectDiscordModel } from "./model-dialog.js";
import { gatewayPidRecord, readGatewayPid } from "./runtime/process.js";
import { createGatewayBootService } from "./systemd.js";
import { discordSelectItems, DiscordSelectDialog, type DiscordSelectDialogOptions } from "./select-dialog.js";
import { runDiscordSettingsPage, type DiscordSettingRow } from "./settings-page.js";
import { timezoneLabel, timezoneOffsetGroups } from "./timezones.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DISCORD_CHANNEL_SESSIONS,
  ensurePrivateDirectory,
  getDiscordGatewayPaths,
  isValidDiscordChannelSessions,
  isDiscordSnowflake,
  readDiscordGatewayConfig,
  writePrivateJson,
  type DiscordChannelReplyMode,
  type DiscordGatewayConfig,
  type DiscordGatewayPaths,
  type DiscordGatewayStatus,
  type DiscordToolCallVisibility,
  type DiscordTableRendering,
} from "./storage.js";

const TOKEN_ENV_VAR = "PI_ENHANCED_DISCORD_BOT_TOKEN";
const onOff = (value: boolean) => value ? "on" : "off";

function openSetting(
  kind: "group" | "picker" | "input" | "action", id: string, label: string, currentValue: string,
  description: string, open: () => void | Promise<void>,
): DiscordSettingRow {
  return { kind, id, label, currentValue, description, open };
}

function cycleSetting<T>(
  id: string, label: string, current: T, description: string, choices: readonly T[],
  format: (value: T) => string, change: (value: T) => void,
): DiscordSettingRow {
  const values = choices.map(format);
  const currentValue = format(current);
  return {
    kind: "inline", id, label, description, currentValue, values,
    change: (value) => {
      const index = values.indexOf(value);
      if (index >= 0 && value !== currentValue) change(choices[index]!);
    },
  };
}

function toggleSetting(
  id: string, label: string, current: boolean, description: string, change: (value: boolean) => void,
): DiscordSettingRow {
  return cycleSetting(id, label, current, description, [false, true], onOff, change);
}

export async function handleDiscordCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  const action = trimmed ? trimmed.toLowerCase().split(/\s+/, 1)[0] : "menu";
  try {
    const run = (dialogCtx: ExtensionCommandContext) => executeDiscordCommand(action, dialogCtx);
    if (["menu", "setup", "config", "configure", "teardown"].includes(action)) {
      await withDiscordDialogSession(ctx, run);
    } else {
      await run(ctx);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Discord gateway: ${message}`, "error");
  }
}

async function executeDiscordCommand(action: string, ctx: ExtensionCommandContext): Promise<void> {
  switch (action) {
    case "menu":
      await showDiscordMenu(ctx);
      return;
    case "setup":
      await setupGateway(ctx);
      return;
    case "config":
    case "configure":
      await showConfigureMenu(ctx);
      return;
    case "start":
      await startGateway(ctx);
      return;
    case "restart":
      await restartGateway(ctx);
      return;
    case "stop":
      await stopGateway(ctx);
      return;
    case "teardown":
      await teardownGateway(ctx);
      return;
    case "status":
      await showStatus(ctx);
      return;
    case "logs":
      showLogs(ctx);
      return;
    case "help":
      notify(
        ctx,
        [
          "/discord          Open the gateway menu (or setup if unconfigured)",
          "/discord setup    Configure the bot, access allowlists, workspace, and optional home channel",
          "/discord configure Open gateway settings (also /discord config)",
          "/discord start    Start the independent background gateway",
          "/discord restart  Restart the background gateway",
          "/discord stop     Stop the gateway",
          "/discord teardown Stop it and remove the saved bot config",
          "/discord status   Check gateway health",
          "/discord logs     Show recent gateway logs",
        ].join("\n"),
        "info"
      );
      return;
    default:
      notify(ctx, "Unknown /discord action. Use /discord help.", "error");
  }
}

async function showDiscordMenu(ctx: ExtensionCommandContext): Promise<void> {
  let selectedOption: string | undefined;
  while (true) {
    const config = readDiscordGatewayConfig();
    if (!config) {
      if (ctx.hasUI) await setupGateway(ctx);
      else notify(ctx, "Discord gateway is not configured. Run /discord setup in an interactive Pi session.", "info");
      return;
    }

    if (!ctx.hasUI) {
      await showStatus(ctx);
      notify(ctx, "Use /discord start, /discord restart, /discord stop, /discord setup, /discord configure, or /discord logs.", "info");
      return;
    }

    const { pid, status, boot } = await inspectGateway(getDiscordGatewayPaths());
    const statusLabel = pid
      ? status?.state === "restarting" ? "draining for restart"
        : status?.botTag ? `running as ${status.botTag}` : `running (${status?.state || "connecting"})`
      : boot.active ? "starting under systemd"
        : status?.state === "failed" && status.lastError ? `stopped — ${status.lastError}`
          : boot.failed ? "systemd service failed — see logs" : "stopped";
    const actions = [
      ...(pid || boot.active ? ["Restart", "Stop"] : ["Start"]),
      "Settings", "View logs", "Remove configuration",
    ];
    const selected = await selectDiscordOption(ctx, {
      title: "Discord Gateway",
      description: `Status: ${statusLabel}`,
      options: actions,
      selectedOption,
    });
    selectedOption = selected;
    switch (selected) {
      case "Start":
        await startGateway(ctx);
        return;
      case "Restart":
        await restartGateway(ctx);
        return;
      case "Stop":
        await stopGateway(ctx);
        return;
      case "Settings":
        await showConfigureMenu(ctx);
        continue;
      case "Remove configuration":
        await teardownGateway(ctx);
        return;
      case "View logs":
        showLogs(ctx);
        return;
      default:
        return;
    }
  }
}

async function configureBootService(ctx: ExtensionCommandContext, paths: DiscordGatewayPaths): Promise<void> {
  const service = createGatewayBootService(paths);
  if (!service.supported) throw new Error("This setting requires Linux with a systemd user manager.");
  const { boot, pid, status } = await inspectGateway(paths);
  if (boot.unavailable) throw new Error("The systemd user manager is unavailable.");
  const selected = await selectDiscordOption(ctx, {
    title: "Start at boot",
    description: "Enabling starts the systemd service after any accepted work finishes. Disabling leaves the gateway running until you stop it or reboot.",
    options: [
      { label: "Enable", current: boot.enabled, description: "Start the gateway now and at boot." },
      { label: "Disable", current: !boot.enabled, description: "Do not start the gateway automatically at boot." },
    ],
    selectedOption: boot.enabled ? "Enable" : "Disable",
  });
  if (!selected || (selected === "Enable") === boot.enabled) return;
  if (selected === "Disable") {
    await service.disable();
    notify(ctx, "Start at boot is off. A running gateway stays online until stopped or rebooted.", "info");
    return;
  }

  if (pid && !status?.supervision) {
    throw new Error("Restart the gateway once with /discord restart to load support for systemd handoff, then try again.");
  }
  const config = readDiscordGatewayConfig();
  if (!config) throw new Error("A valid gateway configuration is required.");
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    throw new Error(`Configured workspace is unavailable: ${config.cwd}`);
  }
  const argv = resolvePiInvocation();
  if (!argv) throw new Error("Could not locate the running Pi CLI.");
  prepareGatewayDirectory(paths);
  const launcher = fileURLToPath(new URL("./systemd-launch.mjs", import.meta.url));
  await service.enable(process.execPath, launcher, gatewayLaunchEnv(paths, argv, "start"));
  notify(ctx, pid && !boot.active
    ? "Start at boot is on. The running gateway will finish accepted work before systemd takes over."
    : "Start at boot is on. The systemd service is started; use /discord status to check the connection.", "info");
}

async function showConfigureMenu(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Run /discord configure in an interactive Pi session to change gateway settings.", "error");
    return;
  }

  if (!readDiscordGatewayConfig()) {
    await setupGateway(ctx);
    return;
  }

  const paths = getDiscordGatewayPaths();
  let { bootLabel } = await inspectGateway(paths);
  await runDiscordSettingsPage(ctx, { title: "Discord Settings", searchable: true }, () => {
    const config = readDiscordGatewayConfig();
    if (!config) return undefined;
    const { channelReplies: replies, channelSessions: sessions } = config;
    const visibility = toolVisibility(config);
    const tables = tableSettings(config);
    return [
      openSetting("action", "boot", "Start at boot", bootLabel,
        "Run the gateway as a systemd user service when this machine boots. Off by default.", async () => {
          try {
            await configureBootService(ctx, paths);
          } finally {
            ({ bootLabel } = await inspectGateway(paths));
          }
        }),
      openSetting("input", "token", "Bot token", "configured",
        "Replace the saved Discord bot token. Input is visible; the token is stored in private local config. Restart the gateway to reconnect with it.",
        () => configureBotToken(ctx, config)),
      openSetting("input", "users", "Allowed users",
        config.allowedUserIds.includes("*") ? "everyone" : config.allowedUserIds.length ? `${config.allowedUserIds.length} allowed` : "none (blocked)",
        'Choose which Discord users can interact in DMs and servers. Use "*" for everyone or "off" to block all users.',
        () => configureWhitelist(ctx, config, "users")),
      openSetting("input", "channels", "Allowed channels",
        config.allowedChannelIds.includes("*") ? "all channels" : config.allowedChannelIds.length ? `${config.allowedChannelIds.length} allowed` : "none (servers/history blocked)",
        'Choose allowed channels, "*" for all, or "off" to block server messages/history. DM messaging uses only the user whitelist; shared-thread participants may see history results.',
        () => configureWhitelist(ctx, config, "channels")),
      openSetting("input", "notifications", "Notification channel", config.homeChannelId ?? "off",
        "Set the channel for lifecycle and optional config reload notices, or turn notifications off.",
        () => configureHomeChannel(ctx, config)),
      toggleSetting("reload-notices", "Config reload notices", config.notifyConfigReloads === true,
        "Send config reload outcomes to the notification channel without sharing config values. /discord status always shows the latest outcome."
          + (config.homeChannelId ? "" : " Set a notification channel to receive notices in Discord."),
        (enabled) => saveGatewayConfig(ctx, config, { notifyConfigReloads: enabled },
          `Config reload notices ${enabled ? "enabled" : "disabled"}.`
            + (enabled && !config.homeChannelId ? " Set a notification channel to receive them in Discord." : ""))),
      openSetting("input", "workspace", "Workspace", config.cwd,
        "Set the starting directory for gateway Pi sessions. This is not a filesystem sandbox; tools may access other files.",
        () => configureWorkspace(ctx, config)),
      openSetting("picker", "default-model", "Default model", config.model ? `${config.model.provider}/${config.model.id}` : "Pi default",
        "Choose the model used when gateway Pi sessions start, or follow Pi's configured default.",
        () => configureDefaultModel(ctx, config)),
      openSetting("group", "access", "Message access", `DMs ${onOff(config.allowDirectMessages)} · Servers ${onOff(config.allowServerMessages)}`,
        "Enable or disable direct messages and server messages independently. User and channel allowlists still apply.",
        () => configureAccessPaths(ctx, config)),
      cycleSetting<NonNullable<DiscordGatewayConfig["toolCallVerbosity"]>>("verbosity", "Tool call verbosity", config.toolCallVerbosity ?? "full",
        "Control tool activity shown in Discord: none, tool only, or full (including intermediate assistant text). Workspace change notices stay visible.",
        ["none", "tool-only", "full"], (value) => value === "tool-only" ? "tool only" : value,
        (value) => saveGatewayConfig(ctx, config, { toolCallVerbosity: value }, `Tool call verbosity set to ${value}.`)),
      openSetting("group", "visibility", "Tool call visibility",
        `Channels ${onOff(visibility.channels)} · Threads ${onOff(visibility.threads)} · DMs ${onOff(visibility.dms)}`,
        "Show or hide tool activity and intermediate assistant text separately in server channels, threads, and DMs.",
        () => configureToolCallVisibility(ctx)),
      openSetting("group", "tables", "Tables",
        tables.enabled ? `on · Title/footer ${onOff(tables.showTitleFooter)} · Markdown ${onOff(tables.attachMarkdown)}` : "off",
        "Configure Markdown table images, with independent options for title/footer and Markdown attachments.",
        () => configureTableRendering(ctx)),
      cycleSetting<DiscordChannelReplyMode>("replies", "Channel replies", replies.mode,
        "Choose where new server conversations answer: a thread, the channel, or a routing model's choice. Routing settings appear in model-decides mode. Existing threads and DMs are unchanged.",
        ["always-thread", "channel", "auto"], channelReplyModeLabel,
        (mode) => saveGatewayConfig(ctx, config, { channelReplies: { ...replies, mode } }, `Channel replies set to ${channelReplyModeLabel(mode)}.`)),
      openSetting("group", "sessions", "Channel sessions", sessions?.enabled !== false
        ? `${resetHourLabel(sessions?.resetHour ?? DEFAULT_DISCORD_CHANNEL_SESSIONS.resetHour)} · ${sessions?.timezone ?? DEFAULT_DISCORD_CHANNEL_SESSIONS.timezone} · ${sessions?.idleHours ?? DEFAULT_DISCORD_CHANNEL_SESSIONS.idleHours}h quiet`
        : "overnight rollover off",
        "Configure overnight context rollover. Busy nights are skipped; replying to a bot message always continues its linked session without changing the default.",
        () => configureChannelSessions(ctx)),
      contextSetting(ctx, config),
      ...(replies.mode === "auto" ? [
        openSetting("picker", "routing-model", "Routing model", routingModelLabel(replies.routerModel),
          "Use the cheapest authenticated model, Pi's default, the gateway's default, or a specific model. Each routing decision costs one model call; failures start a thread.",
          () => configureRoutingModel(ctx, config)),
        contextSetting(ctx, config, true),
        toggleSetting("tool-escalation", "Tool escalation", replies.escalate,
          "Open a thread when a channel reply uses editing, shell, or delegation tools. Read-only replies stay in the channel; the thread inherits the conversation.",
          (value) => saveGatewayConfig(ctx, config, { channelReplies: { ...replies, escalate: value } }, `Tool escalation turned ${onOff(value)}.`)),
        toggleSetting("follow-up", "Follow-up escalation", replies.followUp,
          "Open a thread when the same user mentions the bot again in the same channel within ten minutes of a channel reply. When off, the routing model decides.",
          (value) => saveGatewayConfig(ctx, config, { channelReplies: { ...replies, followUp: value } }, `Follow-up escalation turned ${onOff(value)}.`)),
      ] : []),
    ];
  });
}

async function setupGateway(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Run /discord setup in an interactive Pi session to configure the bot.", "error");
    return;
  }

  const existing = readDiscordGatewayConfig();
  let token = process.env[TOKEN_ENV_VAR]?.trim() || "";
  if (!token && existing) {
    const tokenChoice = await selectDiscordOption(ctx, {
      title: "Discord Bot Token",
      options: ["Keep saved token", "Enter new token"],
    });
    if (!tokenChoice) return;
    if (tokenChoice === "Keep saved token") {
      token = existing.token;
    } else {
      token = (await promptForBotToken(ctx)) || "";
    }
  } else if (!token) {
    token = (await promptForBotToken(ctx)) || "";
  }
  if (!token) {
    notify(ctx, "Setup cancelled: no bot token was provided.", "warning");
    return;
  }

  const userIdsInput = await promptDiscordInput(ctx, {
    title: "Allowed Users",
    instruction: 'Comma-separated user IDs, or "*" for everyone. Leave blank to block all DMs and server messages until users are added.',
    initialValue: existing?.allowedUserIds.join(", ") || "",
    placeholder: "Comma-separated user IDs or *",
  });
  if (userIdsInput === undefined) return;
  const allowedUserIds = parseAllowlist(userIdsInput);
  const channelIdsInput = await promptDiscordInput(ctx, {
    title: "Allowed Channels",
    instruction: 'Comma-separated channel IDs, or "*" for all. Leave blank to block server messages and history; DM messaging uses only the user whitelist.',
    initialValue: existing?.allowedChannelIds.join(", ") || "",
    placeholder: "Comma-separated channel IDs or *",
  });
  if (channelIdsInput === undefined) return;
  const allowedChannelIds = parseAllowlist(channelIdsInput);
  const homeChannelInput = await promptDiscordInput(ctx, {
    title: "Notification Channel",
    instruction: "Text channel ID for start, restart, stop, and failure notices. Leave blank to disable.",
    initialValue: existing?.homeChannelId || "",
    placeholder: "Optional Discord text channel ID",
  });
  if (homeChannelInput === undefined) return;
  const homeChannelId = homeChannelInput.trim() || undefined;
  if (homeChannelId && !isDiscordSnowflake(homeChannelId)) {
    notify(ctx, "The home notification channel must be a 17–20 digit Discord channel ID.", "error");
    return;
  }

  const defaultWorkspace = existing?.cwd || join(homedir(), "pi-workspaces", "discord-gateway");
  const cwdInput = await promptDiscordInput(ctx, {
    title: "Gateway Workspace",
    instruction: "Starting directory, not a filesystem sandbox. Leave blank to use the default.",
    initialValue: "",
    placeholder: defaultWorkspace,
  });
  if (cwdInput === undefined) return;
  const workspaceInput = cwdInput.trim() || defaultWorkspace;
  const cwd = resolve(workspaceInput.replace(/^~(?=$|[\\/])/, homedir()));
  if (!existsSync(cwd)) {
    const createWorkspace = await confirmDiscordAction(ctx, {
      title: "Create Gateway Workspace?",
      content: [`Create ${cwd}?`, "The Pi agent will start here, but this does not restrict access to other files."],
      confirmLabel: "Create workspace",
      rejectLabel: "Do not create workspace",
    });
    if (!createWorkspace) return;
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    notify(ctx, `Workspace is not a directory: ${cwd}`, "error");
    return;
  }

  let bot = await validateBotToken(token);
  if (!bot && existing && token === existing.token && !process.env[TOKEN_ENV_VAR]?.trim()) {
    token = (await promptDiscordInput(ctx, {
      title: "Replace Discord Bot Token",
      instruction: "The saved token was rejected. Enter a replacement token. Input is visible; it will be stored in the private gateway config.",
      initialValue: "",
      placeholder: "Paste the replacement bot token",
    }))?.trim() || "";
    if (token) bot = await validateBotToken(token);
  }
  if (!bot) {
    notify(ctx, "Discord rejected that bot token. Check it and try /discord setup again.", "error");
    return;
  }
  if (homeChannelId && !(await validateHomeChannel(token, homeChannelId))) {
    notify(ctx, "Discord could not verify that home channel. Check the channel ID and ensure the bot can view it.", "error");
    return;
  }

  const usersAreWildcard = allowedUserIds.includes("*");
  const channelsAreWildcard = allowedChannelIds.includes("*");
  const userAccessLine = `Users (DMs + servers): ${usersAreWildcard ? "everyone (*)" : allowedUserIds.length ? `${allowedUserIds.length} allowed` : "none — all incoming messages blocked"}`;
  const channelAccessLine = `Channels (server routing + history/discovery): ${channelsAreWildcard ? "all channels (*)" : allowedChannelIds.length ? `${allowedChannelIds.length} allowed` : "none — server messages and history blocked"}`;
  const dmAccessLine = `DM access: ${existing?.allowDirectMessages === false ? "Off" : "On"}`;
  const serverAccessLine = `Server access: ${existing?.allowServerMessages === false ? "Off" : "On"}`;
  const highlightedAccessLines = [
    ...(usersAreWildcard ? [userAccessLine] : []),
    ...(channelsAreWildcard ? [channelAccessLine] : []),
  ];
  const confirmationLines = [
    `Bot: ${bot.username}`,
    "",
    "ACCESS",
    userAccessLine,
    channelAccessLine,
    dmAccessLine,
    serverAccessLine,
    "Mention the bot to start a server thread. Allowed channels also authorize history sources, including the requester's DM.",
    "History and channel discovery results may be visible to shared-thread participants.",
    `Recent context: ${contextMessagesLabel(existing?.contextMessages ?? 5)} added automatically per turn`,
    `Notifications: ${homeChannelId || "off"}`,
    "",
    "UNATTENDED TOOLS",
    "Pi tools can edit files and run shell commands without local approval.",
    `Workspace: ${cwd}`,
    "The workspace is not a sandbox; tools may access files outside it.",
    "",
    "The bot token will be stored in a private local config file.",
  ];

  const approved = await confirmDiscordAction(ctx, {
    title: "Save Discord Configuration?",
    content: confirmationLines,
    highlightedLines: highlightedAccessLines,
    confirmLabel: "Save configuration",
    rejectLabel: existing ? "Keep current configuration" : "Not now",
  });
  if (!approved) {
    notify(ctx, "Setup cancelled; no configuration was saved.", "warning");
    return;
  }

  const config: DiscordGatewayConfig = {
    token,
    allowedUserIds,
    allowedChannelIds,
    allowDirectMessages: existing?.allowDirectMessages ?? true,
    allowServerMessages: existing?.allowServerMessages ?? true,
    ...(homeChannelId ? { homeChannelId } : {}),
    notifyConfigReloads: existing?.notifyConfigReloads ?? false,
    cwd,
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : existing?.model ? { model: existing.model } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
    toolCallVerbosity: existing?.toolCallVerbosity ?? "full",
    toolCallVisibility: existing?.toolCallVisibility ?? { channels: false, threads: true, dms: true },
    tableRendering: existing?.tableRendering ?? { enabled: false, showTitleFooter: false, attachMarkdown: false },
    channelReplies: existing?.channelReplies ?? { mode: "always-thread", escalate: true, followUp: true, contextMessages: 5 },
    channelSessions: existing?.channelSessions ?? { ...DEFAULT_DISCORD_CHANNEL_SESSIONS },
    contextMessages: existing?.contextMessages ?? 5,
    configuredAt: new Date().toISOString(),
  };
  const paths = getDiscordGatewayPaths();
  const alreadyRunning = readGatewayPid(paths.pid) !== undefined;
  writePrivateJson(paths.config, config);
  const applyMessage = !alreadyRunning ? "" : existing?.token !== token
    ? " Settings reload automatically; run /discord restart to reconnect with the new bot token."
    : " The gateway will reload these settings automatically.";
  notify(
    ctx,
    `Discord gateway configured for ${bot.username}.\nWorkspace: ${cwd}\nConfig: ${paths.config}\nEnable the Message Content Intent in Discord's Developer Portal, invite the bot with View Channel, Read Message History, Send Messages, Create Public Threads, Send Messages in Threads, and Manage Threads so it can rename generated thread titles.${applyMessage}`,
    "info"
  );

  if (!alreadyRunning && await confirmDiscordAction(ctx, {
    title: "Start Gateway Now?",
    content: ["Pi will start a detached background process."],
    confirmLabel: "Start gateway",
    rejectLabel: "Not now",
  })) {
    await startGateway(ctx);
  }
}

async function configureBotToken(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const token = await promptDiscordInput(ctx, {
    title: "Bot Token",
    instruction: "Input is visible. The new token will replace the saved token in private local config.",
    initialValue: "",
    placeholder: "Saved token configured; leave blank to keep it",
  });
  const normalizedToken = token?.trim();
  if (!normalizedToken) return;

  const bot = await validateBotToken(normalizedToken);
  if (!bot) {
    notify(ctx, "Discord rejected that bot token. The saved token was not changed.", "error");
    return;
  }

  const approved = await confirmDiscordAction(ctx, {
    title: "Save New Bot Token?",
    content: [`Discord validated the token for ${bot.username}.`, "This replaces the currently saved bot token."],
    confirmLabel: "Save new token",
    rejectLabel: "Keep current token",
  });
  if (!approved) return;
  saveGatewayConfig(ctx, config, { token: normalizedToken }, `Bot token updated for ${bot.username}.`);
}

async function configureWhitelist(
  ctx: ExtensionCommandContext,
  config: DiscordGatewayConfig,
  kind: "users" | "channels"
): Promise<void> {
  const isUsers = kind === "users";
  const currentValues = isUsers ? config.allowedUserIds : config.allowedChannelIds;
  const title = isUsers ? "Allowed Users" : "Allowed Channels";
  const instruction = isUsers
    ? 'Comma-separated user IDs, "*" for everyone, or "off" to block all DMs and servers. Leave blank to keep current.'
    : 'Comma-separated channel IDs, "*" for all, or "off" to block servers/history. DMs use only the user whitelist; blank keeps current.';
  const value = await promptDiscordInput(ctx, {
    title,
    instruction,
    initialValue: "",
    placeholder: currentValues.join(", ") || "No entries (blocked)",
  });
  if (value === undefined || !value.trim()) return;

  const allowlist = parseAllowlist(value);
  const isWildcard = allowlist.includes("*");
  const summary = isUsers
    ? `Allowed users: ${isWildcard ? "everyone (*)" : allowlist.length ? `${allowlist.length} user ID(s)` : "none — all incoming messages blocked"}`
    : `Allowed channels: ${isWildcard ? "all channels (*)" : allowlist.length ? `${allowlist.length} channel ID(s)` : "none — server messages and history blocked"}`;
  const approved = await confirmDiscordAction(ctx, {
    title: isUsers ? "Save Allowed Users?" : "Save Allowed Channels?",
    content: isUsers ? [summary] : [summary, "This list also authorizes history sources, including the current requester’s DM. Shared-thread participants may see history results."],
    highlightedLines: isWildcard ? [summary] : [],
    confirmLabel: isUsers ? "Save users" : "Save channels",
    rejectLabel: "Keep current access",
  });
  if (!approved) return;

  saveGatewayConfig(
    ctx,
    config,
    isUsers ? { allowedUserIds: allowlist } : { allowedChannelIds: allowlist },
    `Allowed ${isUsers ? "users" : "channels"} updated.`
  );
}

async function configureHomeChannel(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const input = await promptDiscordInput(ctx, {
    title: "Notification Channel",
    instruction: "Text channel ID, or 'off' to disable notifications. Leave blank to keep current.",
    initialValue: "",
    placeholder: config.homeChannelId || "Optional Discord text channel ID",
  });
  if (input === undefined || !input.trim()) return;

  const value = input.trim();
  const homeChannelId = value.toLowerCase() === "off" ? undefined : value;
  if (homeChannelId && !isDiscordSnowflake(homeChannelId)) {
    notify(ctx, "The home notification channel must be a 17–20 digit Discord channel ID, or enter 'off'.", "error");
    return;
  }
  if (homeChannelId && !(await validateHomeChannel(config.token, homeChannelId))) {
    notify(ctx, "Discord could not verify that home channel. Check the channel ID and ensure the bot can view it.", "error");
    return;
  }
  if (homeChannelId === config.homeChannelId) {
    notify(ctx, "Home notification channel is unchanged.", "info");
    return;
  }

  saveGatewayConfig(
    ctx,
    config,
    { homeChannelId },
    homeChannelId ? `Home notification channel set to ${homeChannelId}.` : "Home channel notifications disabled."
  );
}

async function configureWorkspace(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const input = await promptDiscordInput(ctx, {
    title: "Gateway Workspace",
    instruction: "Starting directory, not a filesystem sandbox. Leave blank to keep current.",
    initialValue: "",
    placeholder: config.cwd,
  });
  if (input === undefined || !input.trim()) return;

  const cwd = resolve(input.trim().replace(/^~(?=$|[\\/])/, homedir()));
  if (!existsSync(cwd)) {
    const createWorkspace = await confirmDiscordAction(ctx, {
      title: "Create Gateway Workspace?",
      content: [`Create ${cwd}?`, "The workspace is a starting directory, not a filesystem sandbox."],
      confirmLabel: "Create workspace",
      rejectLabel: "Keep current workspace",
    });
    if (!createWorkspace) return;
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    notify(ctx, `Workspace is not a directory: ${cwd}`, "error");
    return;
  }
  if (cwd === config.cwd) {
    notify(ctx, "Gateway workspace is unchanged.", "info");
    return;
  }

  saveGatewayConfig(ctx, config, { cwd }, `Gateway workspace updated to ${cwd}.`);
}

async function configureDefaultModel(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const refresh = refreshProviderCatalogs(ctx);
  const currentValue = config.model ? `${config.model.provider}/${config.model.id}` : "";
  const models = (await getAvailablePickerModels(ctx))
    .map((model) => ({ value: `${model.provider}/${model.id}`, model }))
    .sort((a, b) => a.value.localeCompare(b.value));
  const choices = [
    {
      value: "",
      label: "Pi default",
      description: "Use Pi's configured default at startup",
    },
    ...models.map(({ value, model }) => ({
      value,
      label: value,
      description: model.name,
    })),
  ];
  const selected = await selectDiscordModel(ctx, choices, currentValue, refresh);
  if (selected === undefined) return;
  if (selected === currentValue) {
    notify(ctx, "Discord default model is unchanged.", "info");
    return;
  }

  const model = models.find((entry) => entry.value === selected)?.model;
  if (selected && !model) return;
  saveGatewayConfig(
    ctx,
    config,
    { model: model ? { provider: model.provider, id: model.id } : undefined },
    `Discord default model set to ${selected || "Pi default"}. Used when gateway Pi sessions start.`
  );
}

function toolVisibility(config: DiscordGatewayConfig): DiscordToolCallVisibility {
  return { channels: false, threads: true, dms: true, ...config.toolCallVisibility };
}

async function configureToolCallVisibility(ctx: ExtensionCommandContext): Promise<void> {
  const destinations = [
    { key: "channels", label: "Server channels" },
    { key: "threads", label: "Threads" },
    { key: "dms", label: "Direct messages" },
  ] as const;
  await runDiscordSettingsPage(ctx, {
    title: "Tool call visibility",
    description: "Verbosity still applies where enabled. Prompts and workspace notices stay visible.",
  }, () => {
    const config = readDiscordGatewayConfig();
    if (!config) return;
    const current = toolVisibility(config);
    return destinations.map(({ key, label }) => toggleSetting(key, label, current[key],
      `Show or hide tool activity and intermediate assistant text in ${label.toLowerCase()}.`,
      (value) => saveGatewayConfig(ctx, config, { toolCallVisibility: { ...current, [key]: value } },
        `Tool call info in ${label.toLowerCase()} turned ${onOff(value)}.`)));
  });
}

function tableSettings(config: DiscordGatewayConfig): DiscordTableRendering {
  return { enabled: false, showTitleFooter: false, attachMarkdown: false, ...config.tableRendering };
}

async function configureTableRendering(ctx: ExtensionCommandContext): Promise<void> {
  const settings = [
    { key: "enabled", label: "Render tables", description: "Convert Markdown tables to images. Off sends the original Markdown as text, without table images or .md attachments; other table preferences are preserved." },
    { key: "showTitleFooter", label: "Title and footer", description: "Show the table title, page numbering and row/column ranges together. Off shows only the table grid." },
    { key: "attachMarkdown", label: "Markdown attachment", description: "Attach the original table as a .md file alongside its images for copying text and links." },
  ] as const;
  await runDiscordSettingsPage(ctx, { title: "Tables" }, () => {
    const config = readDiscordGatewayConfig();
    if (!config) return;
    const current = tableSettings(config);
    return settings.map(({ key, label, description }) => toggleSetting(key, label, current[key], description,
      (value) => saveGatewayConfig(ctx, config, { tableRendering: { ...current, [key]: value } },
        `${label} turned ${onOff(value)}.`)));
  });
}

function resetHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

async function selectGatewayTimezone(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  const groups = timezoneOffsetGroups(current);
  const currentGroup = groups.find((group) => group.zones.some(({ id }) => id === current));
  let selectedOffset = currentGroup?.offset;
  while (true) {
    selectedOffset = await selectDiscordOption(ctx, {
      title: "Timezone · Choose a UTC offset",
      description: "Offsets are shown for now. The city you choose follows its local time rules, including daylight saving.",
      options: groups.map(({ offset, label }) => ({ value: offset, label, current: offset === currentGroup?.offset })),
      selectedOption: selectedOffset,
    });
    const group = groups.find(({ offset }) => offset === selectedOffset);
    if (!group) return;

    const cityCounts = new Map<string, number>();
    for (const { city } of group.zones) cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
    const zone = await selectDiscordOption(ctx, {
      title: `Timezone · ${group.offset} · Choose a city`,
      options: group.zones.map(({ id, city }) => ({
        value: id,
        label: cityCounts.get(city) === 1 ? city : `${city} (${id})`,
        description: id === city ? undefined : id,
        current: id === current,
      })),
    });
    if (zone !== undefined) return zone;
  }
}

async function configureChannelSessions(ctx: ExtensionCommandContext): Promise<void> {
  await runDiscordSettingsPage(ctx, {
    title: "Channel sessions",
    description: "At the daily boundary, roll over only after the inactivity window and with no running or queued work. Old replies keep their linked sessions; plain mentions use the newest default.",
  }, () => {
    const config = readDiscordGatewayConfig();
    if (!config) return;
    const current = { ...DEFAULT_DISCORD_CHANNEL_SESSIONS, ...config.channelSessions };
    const save = (next: typeof current) => {
      if (!isValidDiscordChannelSessions(next)) {
        notify(ctx, "Use a valid IANA timezone, reset hour 0–23, and inactivity window 1–168 whole hours.", "error");
        return;
      }
      saveGatewayConfig(ctx, config, { channelSessions: next }, "Channel session settings saved.");
    };
    const edit = async (field: "resetHour" | "idleHours", title: string, instruction: string) => {
      const value = await promptDiscordInput(ctx, { title, instruction, initialValue: String(current[field]), placeholder: "" });
      if (value === undefined) return;
      const next = value.trim() ? Number(value) : Number.NaN;
      if (next !== current[field]) save({ ...current, [field]: next });
    };
    return [
      toggleSetting("rollover", "Overnight rollover", current.enabled,
        "Rotate the default session daily without deleting older reply-linked sessions.", (enabled) => save({ ...current, enabled })),
      openSetting("picker", "timezone", "Timezone", timezoneLabel(current.timezone),
        `Sets the local timezone for rollover and the default for new scheduled jobs. If unset, uses the machine timezone (${DEFAULT_DISCORD_CHANNEL_SESSIONS.timezone}).`,
        async () => {
          const timezone = await selectGatewayTimezone(ctx, current.timezone);
          if (timezone !== undefined && timezone !== current.timezone) save({ ...current, timezone });
        }),
      openSetting("input", "reset-hour", "Reset hour", resetHourLabel(current.resetHour),
        "Local hour at which each day's rollover eligibility is evaluated.",
        () => edit("resetHour", "Reset hour", "Whole hour in the selected timezone (0–23).")),
      openSetting("input", "idle-hours", "Inactivity window", `${current.idleHours} hours`,
        "Required quiet time before the daily boundary. Busy nights skip the entire day.",
        () => edit("idleHours", "Inactivity window", "Whole hours without accepted requests in the default session (1–168). A request exactly at the cutoff skips that day's rollover.")),
    ];
  });
}

function contextSetting(ctx: ExtensionCommandContext, config: DiscordGatewayConfig, routing = false): DiscordSettingRow {
  const current = routing ? config.channelReplies.contextMessages ?? 5 : config.contextMessages;
  const title = routing ? "Routing context" : "Recent context";
  const values = [...new Set([0, 3, 5, 10, 20, 25, current])].sort((a, b) => a - b);
  return cycleSetting(routing ? "routing-context" : "recent-context", title, current, routing
    ? "Messages sent to the router before the reply target, or before your new message when not replying. Independent of agent context. Off disables history, not the direct quote. More context uses more input tokens."
    : "Messages before the reply target, or before your new message when not replying. Non-replies skip already-delivered context; explicit replies revisit older context. Off disables history.",
    values, contextMessagesLabel, (value) => saveGatewayConfig(ctx, config,
      routing ? { channelReplies: { ...config.channelReplies, contextMessages: value } } : { contextMessages: value },
      value === 0 ? `${title} disabled.${routing ? " Direct reply quotes remain included." : ""}` : `${title} set to ${contextMessagesLabel(value)}.`));
}

function channelReplyModeLabel(mode: DiscordChannelReplyMode): string {
  return mode === "always-thread" ? "always thread" : mode === "channel" ? "channel only" : "model decides";
}

function routingModelLabel(model: DiscordGatewayConfig["channelReplies"]["routerModel"]): string {
  if (model === "pi-default") return "Pi default";
  if (model === "gateway-default") return "Gateway default";
  return model ? `${model.provider}/${model.id}` : "cheapest available";
}

function contextMessagesLabel(count: number): string {
  return count === 0 ? "off" : `${count} message${count === 1 ? "" : "s"}`;
}

async function configureRoutingModel(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const refresh = refreshProviderCatalogs(ctx);
  const routerModel = config.channelReplies.routerModel;
  const currentValue = typeof routerModel === "string" ? routerModel : routerModel ? `${routerModel.provider}/${routerModel.id}` : "";
  const models = (await getAvailablePickerModels(ctx))
    .map((model) => ({ value: `${model.provider}/${model.id}`, model }))
    .sort((a, b) => a.value.localeCompare(b.value));
  const choices = [
    {
      value: "",
      label: "Cheapest available",
      description: "Use the lowest-cost authenticated chat model at decision time",
    },
    {
      value: "pi-default",
      label: "Pi default",
      description: "Follow Pi's global saved default at each decision; missing/unavailable defaults start a thread",
    },
    {
      value: "gateway-default",
      label: "Gateway default",
      description: "Follow the gateway's configured default; use the cheapest authenticated model when unset",
    },
    ...models.map(({ value, model }) => ({
      value,
      label: value,
      description: model.name,
    })),
  ];
  const selected = await selectDiscordModel(ctx, choices, currentValue, refresh, {
    title: "Discord Routing Model",
    description: "Chooses channel or thread replies. Defaults are followed at decision time.",
  });
  if (selected === undefined) return;
  if (selected === currentValue) {
    notify(ctx, "Routing model is unchanged.", "info");
    return;
  }
  const model = models.find((entry) => entry.value === selected)?.model;
  if (selected && selected !== "pi-default" && selected !== "gateway-default" && !model) return;
  const nextModel = selected === "pi-default" || selected === "gateway-default"
    ? selected : model ? { provider: model.provider, id: model.id } : undefined;
  saveGatewayConfig(
    ctx,
    config,
    { channelReplies: { ...config.channelReplies, routerModel: nextModel } },
    `Routing model set to ${routingModelLabel(nextModel)}. Each new server conversation costs one extra model call.`
  );
}

async function configureAccessPaths(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const draft = { allowDirectMessages: config.allowDirectMessages, allowServerMessages: config.allowServerMessages };
  let finished = false;
  await runDiscordSettingsPage(ctx, { title: "Message access", description: "Changes take effect only after you select Save changes. Esc discards them." }, () => finished ? undefined : [
    toggleSetting("dms", "Direct messages", draft.allowDirectMessages, "Accept DMs from allowed users.",
      (value) => { draft.allowDirectMessages = value; }),
    toggleSetting("servers", "Server messages", draft.allowServerMessages, "Accept allowed server mentions and gateway-thread replies.",
      (value) => { draft.allowServerMessages = value; }),
    openSetting("action", "save", "Save changes", "save and go back", "Save both message-access settings at once.", () => {
      const current = readDiscordGatewayConfig();
      if (current && (draft.allowDirectMessages !== config.allowDirectMessages || draft.allowServerMessages !== config.allowServerMessages)) {
        saveGatewayConfig(ctx, current, draft, "Discord message access updated.");
      }
      finished = true;
    }),
  ]);
}

function saveGatewayConfig(
  ctx: ExtensionCommandContext,
  config: DiscordGatewayConfig,
  updates: Partial<DiscordGatewayConfig>,
  message: string
): void {
  const nextConfig: DiscordGatewayConfig = {
    ...config,
    ...updates,
    configuredAt: new Date().toISOString(),
  };
  writePrivateJson(getDiscordGatewayPaths().config, nextConfig);
  const pid = readGatewayPid(getDiscordGatewayPaths().pid);
  const applyMessage = !pid
    ? " The change will take effect the next time the gateway starts."
    : updates.token !== undefined && updates.token !== config.token
      ? " Run /discord restart to reconnect with the new bot token."
      : " The gateway will reload this setting automatically.";
  notify(ctx, `${message}${applyMessage}`, "info");
}

async function selectDiscordOption(
  ctx: ExtensionCommandContext,
  options: DiscordSelectDialogOptions
): Promise<string | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        new DiscordSelectDialog(tui, theme, options, done, keybindings)
      );
    } catch {
      // Fall back to Pi's native selector if custom rendering is unavailable.
    }
  }

  const items = discordSelectItems(options);
  const selected = await ctx.ui.select(
    options.description ? `${options.title}\n${options.description}` : options.title,
    items.map((item) => item.label),
  );
  return items.find((item) => item.label === selected)?.value;
}

async function promptDiscordInput(
  ctx: ExtensionCommandContext,
  options: { title: string; instruction: string; initialValue: string; placeholder: string }
): Promise<string | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        new DiscordInputDialog(
          tui,
          theme,
          options.title,
          options.instruction,
          options.initialValue,
          options.placeholder,
          done,
          keybindings
        )
      );
    } catch {
      // Fall back to Pi's native input if custom rendering is unavailable.
    }
  }

  return ctx.ui.input(`${options.title}\n${options.instruction}`, options.initialValue || options.placeholder);
}

async function confirmDiscordAction(
  ctx: ExtensionCommandContext,
  options: DiscordConfirmationDialogOptions
): Promise<boolean> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<boolean>((tui, theme, keybindings, done) =>
        new DiscordConfirmationDialog(tui, theme, options, done, keybindings)
      );
    } catch {
      // Fall back to Pi's native confirmation if custom rendering is unavailable.
    }
  }

  return ctx.ui.confirm(options.title, options.content.join("\n"));
}

async function promptForBotToken(ctx: ExtensionCommandContext): Promise<string | undefined> {
  return (await promptDiscordInput(ctx, {
    title: "Discord Bot Token",
    instruction: "Input is visible. Set PI_ENHANCED_DISCORD_BOT_TOKEN to avoid entering it here; otherwise the token is stored in private local config.",
    initialValue: "",
    placeholder: "Paste the bot token",
  }))?.trim() || undefined;
}

async function validateHomeChannel(token: string, channelId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const channel = (await response.json()) as { id?: unknown; type?: unknown };
    return channel.id === channelId && (channel.type === 0 || channel.type === 5);
  } catch {
    return false;
  }
}

async function validateBotToken(token: string): Promise<{ id: string; username: string } | undefined> {
  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const result = (await response.json()) as { id?: unknown; username?: unknown; bot?: unknown };
    if (typeof result.id !== "string" || typeof result.username !== "string" || result.bot !== true) {
      return undefined;
    }
    return { id: result.id, username: result.username };
  } catch {
    return undefined;
  }
}

function parseAllowlist(input: string): string[] {
  if (input.trim().toLowerCase() === "off") return [];
  const tokens = input.split(/[\s,]+/).filter(Boolean);
  if (tokens.includes("*")) {
    if (tokens.length !== 1) throw new Error("Use * by itself; do not combine it with individual Discord IDs.");
    return ["*"];
  }
  if (tokens.some((token) => !isDiscordSnowflake(token))) {
    throw new Error("Discord user/channel IDs must be 17–20 digit numeric IDs (enable Developer Mode to copy IDs), or use * by itself.");
  }
  return [...new Set(tokens)];
}

async function startGateway(ctx: ExtensionCommandContext, startReason: "start" | "restart" = "start"): Promise<void> {
  const config = readDiscordGatewayConfig();
  if (!config) {
    notify(ctx, "No Discord gateway configuration found. Run /discord setup first.", "error");
    return;
  }
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    notify(ctx, `Configured workspace is unavailable: ${config.cwd}`, "error");
    return;
  }

  const paths = getDiscordGatewayPaths();
  const { boot, pid } = await inspectGateway(paths);
  if (pid || boot.active) {
    notify(ctx, pid ? `Discord gateway is already running (PID ${pid}).` : "The Discord gateway systemd service is already starting.", "info");
    return;
  }
  if (boot.unavailable) throw new Error("Cannot check the installed gateway service. The systemd user manager is unavailable.");
  if (boot.enabled) {
    await createGatewayBootService(paths).start();
    notify(ctx, "Started the gateway under systemd. Use /discord status to check the connection.", "info");
    return;
  }
  prepareGatewayDirectory(paths);
  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  if (existsSync(paths.restartRequest)) unlinkSync(paths.restartRequest);

  const invocation = resolvePiInvocation();
  if (!invocation) {
    notify(ctx, "Could not locate the running Pi CLI. Start Pi from a shell where the `pi` command is available, then retry.", "error");
    return;
  }

  const startedAt = new Date().toISOString();
  writePrivateJson(paths.status, {
    pid: 0,
    state: "starting",
    startedAt,
    updatedAt: startedAt,
  } satisfies DiscordGatewayStatus);

  const logFd = openSync(paths.log, "a", 0o600);
  try {
    chmodSync(paths.log, 0o600);
  } catch {
    // chmod is best-effort on filesystems that do not support POSIX modes.
  }

  const daemonPath = new URL("./daemon.mjs", import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(daemonPath)], {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ...gatewayLaunchEnv(paths, invocation, startReason),
      PI_ENHANCED_DISCORD_SYSTEMD: "0",
    },
  });
  closeSync(logFd);

  try {
    await waitForSpawn(child);
  } catch (error) {
    writePrivateJson(paths.status, {
      pid: 0,
      state: "failed",
      startedAt,
      updatedAt: new Date().toISOString(),
      lastError: "Could not spawn the Discord gateway process.",
    } satisfies DiscordGatewayStatus);
    notify(ctx, `Could not start Discord gateway: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    notify(ctx, "Could not start Discord gateway: the background process exited during startup.", "error");
    return;
  }

  writePrivateJson(paths.pid, gatewayPidRecord(child.pid, startedAt));
  child.unref();
  notify(ctx, `Discord gateway started in the background (PID ${child.pid}). Use /discord status to check the connection.`, "info");
}

function prepareGatewayDirectory(paths: DiscordGatewayPaths) {
  ensurePrivateDirectory(paths.directory);
  ensurePrivateDirectory(paths.sessions);
}

function gatewayLaunchEnv(paths: DiscordGatewayPaths, invocation: { executable: string; args: string[] }, startReason: "start" | "restart") {
  // Only persist explicit launch metadata, never the interactive shell environment or token.
  return {
    PI_CODING_AGENT_DIR: dirname(paths.directory),
    PI_ENHANCED_DISCORD_CONFIG_PATH: paths.config,
    PI_ENHANCED_DISCORD_PID_PATH: paths.pid,
    PI_ENHANCED_DISCORD_STATUS_PATH: paths.status,
    PI_ENHANCED_DISCORD_LOG_PATH: paths.log,
    PI_ENHANCED_DISCORD_SESSION_ROOT: paths.sessions,
    PI_ENHANCED_DISCORD_THREADS_PATH: paths.threads,
    PI_ENHANCED_DISCORD_RESTART_REQUEST_PATH: paths.restartRequest,
    PI_ENHANCED_DISCORD_START_REASON: startReason,
    PI_ENHANCED_DISCORD_PI_EXECUTABLE: invocation.executable,
    PI_ENHANCED_DISCORD_PI_ARGS: JSON.stringify(invocation.args),
  };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", () => resolveSpawn());
    child.once("error", (error) => rejectSpawn(error));
  });
}

function resolvePiInvocation(): { executable: string; args: string[] } | undefined {
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

async function teardownGateway(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getDiscordGatewayPaths();
  if (!existsSync(paths.config)) {
    notify(ctx, "Discord gateway is not configured; nothing to tear down. Conversation sessions were not changed.", "info");
    return;
  }
  if (!ctx.hasUI) {
    notify(ctx, "Run /discord teardown in an interactive Pi session to confirm removing the saved bot configuration.", "error");
    return;
  }

  const approved = await confirmDiscordAction(ctx, {
    title: "Remove Discord Configuration?",
    content: [
      "This stops the gateway, removes its boot service if installed, and deletes the saved bot token, configuration, and scheduled jobs.",
      "Conversation sessions and logs are kept.",
      "This does not revoke the token in Discord; revoke it separately in the Developer Portal if needed.",
    ],
    highlightedLines: ["This does not revoke the token in Discord; revoke it separately in the Developer Portal if needed."],
    confirmLabel: "Remove configuration",
    rejectLabel: "Keep gateway configured",
  });
  if (!approved) return;

  await createGatewayBootService(paths).remove();
  const pid = readGatewayPid(paths.pid);
  if (pid) {
    signalGatewayStop(paths, pid);
    for (let attempt = 0; attempt < 40 && readGatewayPid(paths.pid); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (readGatewayPid(paths.pid)) {
      notify(ctx, `Gateway PID ${pid} is still stopping; configuration was kept. Run /discord stop and try teardown again.`, "error");
      return;
    }
  }

  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  if (existsSync(paths.schedules)) unlinkSync(paths.schedules);
  unlinkSync(paths.config);
  notify(ctx, `Discord gateway stopped and local bot configuration and schedules removed. Conversation sessions remain at ${paths.sessions}.`, "info");
}

async function restartGateway(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getDiscordGatewayPaths();
  const pid = readGatewayPid(paths.pid);
  if (pid) {
    if (existsSync(paths.restartRequest)) {
      notify(ctx, "A Discord gateway restart is already pending.", "info");
      return;
    }
    writePrivateJson(paths.restartRequest, {
      type: "restart",
      requestedAt: new Date().toISOString(),
      reason: "Requested via /discord restart",
    });
    notify(ctx, "Graceful Discord gateway restart requested. Accepted work will finish before it reconnects.", "info");
    return;
  }

  await startGateway(ctx, "restart");
}

async function stopGateway(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getDiscordGatewayPaths();
  const { boot, status, pid } = await inspectGateway(paths);
  if (boot.unavailable) throw new Error("Cannot stop the installed gateway service. The systemd user manager is unavailable.");
  // Stop systemd first so it cannot take over while the detached process is stopping.
  if (boot.active || (pid && status?.supervision === "systemd")) await createGatewayBootService(paths).stop();
  const remainingPid = readGatewayPid(paths.pid);
  if (remainingPid && signalGatewayStop(paths, remainingPid)) {
    notify(ctx, `Sent stop signal to Discord gateway (PID ${remainingPid}).`, "info");
  } else {
    notify(ctx, boot.active ? "Stopped the Discord gateway systemd service." : "Discord gateway is not running.", "info");
  }
}

function signalGatewayStop(paths: DiscordGatewayPaths, pid: number): boolean {
  try {
    if (readGatewayPid(paths.pid) !== pid) return false;
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error) {
    if (readGatewayPid(paths.pid) !== pid) return false;
    throw error;
  }
}

async function inspectGateway(paths: DiscordGatewayPaths) {
  const service = createGatewayBootService(paths);
  const boot = await service.inspect();
  const pid = readGatewayPid(paths.pid);
  const recorded = readJson<DiscordGatewayStatus>(paths.status);
  const status = !pid || recorded?.pid === pid ? recorded : undefined;
  const bootLabel = !service.supported ? "unavailable (requires systemd)" : boot.unavailable ? "systemd unavailable"
    : boot.enabled ? "on" : boot.active ? "off (service still running)" : "off";
  return { boot, pid, status, bootLabel };
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getDiscordGatewayPaths();
  const { boot, pid, status, bootLabel } = await inspectGateway(paths);
  if (!pid) {
    const configured = existsSync(paths.config);
    const lines = [boot.active ? "Discord gateway is starting under systemd." : boot.failed ? "Discord gateway systemd service failed."
      : configured ? "Discord gateway is stopped." : "Discord gateway is not configured. Run /discord setup."];
    lines.push(`Start at boot: ${bootLabel}`);
    if (status?.state === "failed" && status.lastError) lines.push(`Last error: ${status.lastError}`);
    if (configured) lines.push(`Config: ${paths.config}`);
    lines.push(`Logs: ${paths.log}`);
    notify(ctx, lines.join("\n"), boot.failed || status?.state === "failed" ? "error" : "info");
    return;
  }

  const manager = status?.supervision === "systemd" ? ", systemd" : "";
  const lines = [`Discord gateway: ${status?.state || "running"} (PID ${pid}${manager})`, `Start at boot: ${bootLabel}`];
  if (boot.active && status?.supervision === "detached") lines.push("Systemd is waiting to take over after pending work finishes.");
  if (status?.botTag) lines.push(`Bot: ${status.botTag}`);
  if (status?.lastEventAt) lines.push(`Last authorized message: ${status.lastEventAt}`);
  if (status?.lastError) lines.push(`Last error: ${status.lastError}`);
  const reload = status?.pid === pid ? status.configReload : undefined;
  if (reload) {
    const result = reload.outcome === "applied" ? "settings applied"
      : reload.outcome === "rejected" ? "edit rejected; previous settings still active" : "saved config valid; no live settings changed";
    lines.push(`Last config reload: ${result} (${reload.at})`);
    if (reload.tokenRestartPending) lines.push("Bot token: restart pending (/discord restart)");
  }
  lines.push(`Logs: ${paths.log}`);
  notify(ctx, lines.join("\n"), status?.state === "failed" ? "error" : reload?.outcome === "rejected" ? "warning" : "info");
}

function showLogs(ctx: ExtensionCommandContext): void {
  const paths = getDiscordGatewayPaths();
  if (!existsSync(paths.log)) {
    notify(ctx, "No gateway log has been created yet.", "info");
    return;
  }
  const lines = readFileSync(paths.log, "utf8").split(/\r?\n/).filter(Boolean).slice(-30);
  notify(ctx, lines.join("\n") || "Gateway log is empty.", "info");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else if (type === "error") console.error(message);
  else console.log(message);
}
