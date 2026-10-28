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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordConfirmationDialog, type DiscordConfirmationDialogOptions } from "./confirm-dialog.js";
import { DiscordInputDialog } from "./input-dialog.js";
import { selectDiscordModel } from "./model-dialog.js";
import { DiscordSelectDialog, type DiscordSelectDialogOptions } from "./select-dialog.js";
import { DiscordToggleDialog, type DiscordAccessPaths } from "./toggle-dialog.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ensurePrivateDirectory,
  getDiscordGatewayPaths,
  isDiscordSnowflake,
  readDiscordGatewayConfig,
  writePrivateJson,
  type DiscordGatewayConfig,
  type DiscordGatewayStatus,
} from "./storage.js";

const TOKEN_ENV_VAR = "PI_ENHANCED_DISCORD_BOT_TOKEN";

export async function handleDiscordCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  const action = trimmed ? trimmed.toLowerCase().split(/\s+/, 1)[0] : "menu";
  try {
    switch (action) {
      case "menu":
        await showDiscordMenu(ctx);
        return;
      case "setup":
        await setupGateway(ctx);
        return;
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
        stopGateway(ctx);
        return;
      case "teardown":
        await teardownGateway(ctx);
        return;
      case "status":
        showStatus(ctx);
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
            "/discord configure Open bot, access, notification, workspace, and default-model settings",
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Discord gateway: ${message}`, "error");
  }
}

async function showDiscordMenu(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const config = readDiscordGatewayConfig();
    if (!config) {
      if (ctx.hasUI) await setupGateway(ctx);
      else notify(ctx, "Discord gateway is not configured. Run /discord setup in an interactive Pi session.", "info");
      return;
    }

    const paths = getDiscordGatewayPaths();
    const pid = readPid(paths.pid);
    const running = pid !== undefined && isProcessAlive(pid);
    if (!running && existsSync(paths.pid)) unlinkSync(paths.pid);
    const status = readJson<DiscordGatewayStatus>(paths.status);
    const statusLabel = running
      ? status?.botTag ? `running as ${status.botTag}` : `running (${status?.state || "connecting"})`
      : status?.state === "failed" && status.lastError ? `stopped — ${status.lastError}` : "stopped";

    if (!ctx.hasUI) {
      showStatus(ctx);
      notify(ctx, "Use /discord start, /discord restart, /discord stop, /discord setup, /discord configure, or /discord logs.", "info");
      return;
    }

    const actions = running
      ? ["Restart", "Stop", "Settings", "View logs", "Remove configuration"]
      : ["Start", "Settings", "View logs", "Remove configuration"];
    const selected = await selectDiscordOption(ctx, {
      title: "Discord Gateway",
      description: `Status: ${statusLabel}`,
      options: actions,
    });
    switch (selected) {
      case "Start":
        await startGateway(ctx);
        return;
      case "Restart":
        await restartGateway(ctx);
        return;
      case "Stop":
        stopGateway(ctx);
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

async function showConfigureMenu(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Run /discord configure in an interactive Pi session to change gateway settings.", "error");
    return;
  }

  while (true) {
    const config = readDiscordGatewayConfig();
    if (!config) {
      await setupGateway(ctx);
      return;
    }

    const selected = await selectDiscordOption(ctx, {
      title: "Discord Settings",
      description: `DMs ${config.allowDirectMessages ? "on" : "off"} · Servers ${config.allowServerMessages ? "on" : "off"} · Notifications ${config.homeChannelId ? "on" : "off"}`,
      options: [
        "Bot token",
        "Allowed users",
        "Allowed server channels",
        "Notification channel",
        "Workspace",
        "Default model",
        "Message access",
      ],
    });
    switch (selected) {
      case "Bot token":
        await configureBotToken(ctx, config);
        break;
      case "Allowed users":
        await configureWhitelist(ctx, config, "users");
        break;
      case "Allowed server channels":
        await configureWhitelist(ctx, config, "channels");
        break;
      case "Notification channel":
        await configureHomeChannel(ctx, config);
        break;
      case "Workspace":
        await configureWorkspace(ctx, config);
        break;
      case "Default model":
        await configureDefaultModel(ctx, config);
        break;
      case "Message access":
        await configureAccessPaths(ctx, config);
        break;
      default:
        return;
    }
  }
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
    instruction: 'Comma-separated user IDs, or "*" for everyone. Applies to DMs and servers.',
    initialValue: existing?.allowedUserIds.join(", ") || "",
    placeholder: "Comma-separated user IDs or *",
  });
  if (userIdsInput === undefined) return;
  const allowedUserIds = parseAllowlist(userIdsInput);
  if (allowedUserIds.length === 0) {
    notify(ctx, "Add at least one allowed Discord user ID.", "error");
    return;
  }

  const channelIdsInput = await promptDiscordInput(ctx, {
    title: "Allowed Server Channels",
    instruction: 'Comma-separated channel IDs, or "*" for all server channels.',
    initialValue: existing?.allowedChannelIds.join(", ") || "",
    placeholder: "Comma-separated channel IDs or *",
  });
  if (channelIdsInput === undefined) return;
  const allowedChannelIds = parseAllowlist(channelIdsInput);
  if (allowedChannelIds.length === 0) {
    notify(ctx, "Add at least one allowed server channel ID.", "error");
    return;
  }

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
  const userAccessLine = `Users (DMs + servers): ${usersAreWildcard ? "everyone (*)" : `${allowedUserIds.length} allowed`}`;
  const channelAccessLine = `Server channels: ${channelsAreWildcard ? "all channels (*)" : `${allowedChannelIds.length} allowed`}`;
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
    "Mention the bot to start a server thread.",
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
    cwd,
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : existing?.model ? { model: existing.model } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : existing?.thinkingLevel ? { thinkingLevel: existing.thinkingLevel } : {}),
    configuredAt: new Date().toISOString(),
  };
  const paths = getDiscordGatewayPaths();
  const currentPid = readPid(paths.pid);
  const alreadyRunning = currentPid !== undefined && isProcessAlive(currentPid);
  writePrivateJson(paths.config, config);
  notify(
    ctx,
    `Discord gateway configured for ${bot.username}.\nWorkspace: ${cwd}\nConfig: ${paths.config}\nEnable the Message Content Intent in Discord's Developer Portal, invite the bot with View Channel, Read Message History, Send Messages, Create Public Threads, Send Messages in Threads, and Manage Threads so it can rename generated thread titles.${alreadyRunning ? " The running gateway still has its previous settings; run /discord stop, then /discord start to apply these changes." : ""}`,
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
  const title = isUsers ? "Allowed Users" : "Allowed Server Channels";
  const instruction = isUsers
    ? 'Comma-separated user IDs, or "*" for everyone (DMs and servers). Leave blank to keep current.'
    : 'Comma-separated channel IDs, or "*" for all server channels. Leave blank to keep current.';
  const value = await promptDiscordInput(ctx, {
    title,
    instruction,
    initialValue: "",
    placeholder: currentValues.join(", "),
  });
  if (value === undefined || !value.trim()) return;

  const allowlist = parseAllowlist(value);
  if (allowlist.length === 0) {
    notify(ctx, `Add at least one ${isUsers ? "user" : "server channel"} ID, or enter * by itself.`, "error");
    return;
  }

  const isWildcard = allowlist.includes("*");
  const summary = isUsers
    ? `Allowed users: ${isWildcard ? "everyone (*)" : `${allowlist.length} user ID(s)`}`
    : `Allowed server channels: ${isWildcard ? "all server channels (*)" : `${allowlist.length} channel ID(s)`}`;
  const approved = await confirmDiscordAction(ctx, {
    title: isUsers ? "Save Allowed Users?" : "Save Allowed Server Channels?",
    content: [summary],
    highlightedLines: isWildcard ? [summary] : [],
    confirmLabel: isUsers ? "Save users" : "Save channels",
    rejectLabel: "Keep current access",
  });
  if (!approved) return;

  saveGatewayConfig(
    ctx,
    config,
    isUsers ? { allowedUserIds: allowlist } : { allowedChannelIds: allowlist },
    `Allowed ${isUsers ? "users" : "server channels"} updated.`
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
  const currentValue = config.model ? `${config.model.provider}/${config.model.id}` : "";
  const models = ctx.modelRegistry.getAvailable()
    .map((model) => ({ value: `${model.provider}/${model.id}`, model }))
    .sort((a, b) => a.value.localeCompare(b.value));
  const choices = [
    {
      value: "",
      label: currentValue ? "Pi default" : "Pi default (current)",
      description: "Use Pi's configured default at startup",
    },
    ...models.map(({ value, model }) => ({
      value,
      label: `${value}${value === currentValue ? " (current)" : ""}`,
      description: model.name,
    })),
  ];
  const selected = await selectDiscordModel(ctx, choices, currentValue);
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

async function configureAccessPaths(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const accessPaths = await promptDiscordAccessPaths(ctx, {
    allowDirectMessages: config.allowDirectMessages,
    allowServerMessages: config.allowServerMessages,
  });
  if (!accessPaths) return;
  if (
    accessPaths.allowDirectMessages === config.allowDirectMessages &&
    accessPaths.allowServerMessages === config.allowServerMessages
  ) {
    notify(ctx, "Message access is unchanged.", "info");
    return;
  }
  saveGatewayConfig(ctx, config, accessPaths, "Discord message access updated.");
}

async function promptDiscordAccessPaths(
  ctx: ExtensionCommandContext,
  initialValues: DiscordAccessPaths
): Promise<DiscordAccessPaths | undefined> {
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom<DiscordAccessPaths | undefined>((tui, theme, keybindings, done) =>
        new DiscordToggleDialog(tui, theme, initialValues, done, keybindings)
      );
    } catch {
      // Fall back to native selectors if custom rendering is unavailable.
    }
  }

  const dmOptions = initialValues.allowDirectMessages
    ? ["On (current)", "Off"]
    : ["Off (current)", "On"];
  const dmChoice = await selectDiscordOption(ctx, {
    title: "DM Access",
    description: "Choose whether the gateway accepts direct messages.",
    options: dmOptions,
  });
  if (!dmChoice) return undefined;

  const serverOptions = initialValues.allowServerMessages
    ? ["On (current)", "Off"]
    : ["Off (current)", "On"];
  const serverChoice = await selectDiscordOption(ctx, {
    title: "Server Access",
    description: "Choose whether the gateway accepts server mentions and gateway-thread replies.",
    options: serverOptions,
  });
  if (!serverChoice) return undefined;

  return {
    allowDirectMessages: dmChoice.startsWith("On"),
    allowServerMessages: serverChoice.startsWith("On"),
  };
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
  const pid = readPid(getDiscordGatewayPaths().pid);
  const restartMessage = pid && isProcessAlive(pid)
    ? " Run /discord restart to apply this change."
    : " The change will take effect the next time the gateway starts.";
  notify(ctx, `${message}${restartMessage}`, "info");
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

  return ctx.ui.select(
    options.description ? `${options.title}\n${options.description}` : options.title,
    options.options
  );
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
  ensurePrivateDirectory(paths.directory);
  ensurePrivateDirectory(paths.sessions);

  const currentPid = readPid(paths.pid);
  if (currentPid && isProcessAlive(currentPid)) {
    notify(ctx, `Discord gateway is already running (PID ${currentPid}).`, "info");
    return;
  }
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

  writePrivateJson(paths.pid, { pid: child.pid, startedAt });
  child.unref();
  notify(ctx, `Discord gateway started in the background (PID ${child.pid}). Use /discord status to check the connection.`, "info");
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
    return { executable: process.execPath, args: [entrypoint] };
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
      "This stops the gateway and removes its locally saved bot token and configuration.",
      "Conversation sessions and logs are kept.",
      "This does not revoke the token in Discord; revoke it separately in the Developer Portal if needed.",
    ],
    highlightedLines: ["This does not revoke the token in Discord; revoke it separately in the Developer Portal if needed."],
    confirmLabel: "Remove configuration",
    rejectLabel: "Keep gateway configured",
  });
  if (!approved) return;

  const pid = readPid(paths.pid);
  if (pid && isProcessAlive(pid)) {
    const status = readJson<DiscordGatewayStatus>(paths.status);
    if (status) writePrivateJson(paths.status, { ...status, state: "stopping", updatedAt: new Date().toISOString() });
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (isProcessAlive(pid)) {
        notify(ctx, `Could not stop gateway PID ${pid}; configuration was kept. ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
    }

    for (let attempt = 0; attempt < 40 && isProcessAlive(pid); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (isProcessAlive(pid)) {
      notify(ctx, `Gateway PID ${pid} is still stopping; configuration was kept. Run /discord stop and try teardown again.`, "error");
      return;
    }
  }

  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  unlinkSync(paths.config);
  notify(ctx, `Discord gateway stopped and local bot configuration removed. Conversation sessions remain at ${paths.sessions}.`, "info");
}

async function restartGateway(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getDiscordGatewayPaths();
  const pid = readPid(paths.pid);
  if (pid && isProcessAlive(pid)) {
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

  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  await startGateway(ctx, "restart");
}

function stopGateway(ctx: ExtensionCommandContext): void {
  const paths = getDiscordGatewayPaths();
  const pid = readPid(paths.pid);
  if (!pid || !isProcessAlive(pid)) {
    if (existsSync(paths.pid)) unlinkSync(paths.pid);
    notify(ctx, "Discord gateway is not running.", "info");
    return;
  }

  const status = readJson<DiscordGatewayStatus>(paths.status);
  if (status) writePrivateJson(paths.status, { ...status, state: "stopping", updatedAt: new Date().toISOString() });
  try {
    process.kill(pid, "SIGTERM");
    notify(ctx, `Sent stop signal to Discord gateway (PID ${pid}).`, "info");
  } catch (error) {
    notify(ctx, `Could not stop gateway PID ${pid}: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function showStatus(ctx: ExtensionCommandContext): void {
  const paths = getDiscordGatewayPaths();
  const configured = Boolean(readDiscordGatewayConfig());
  const pid = readPid(paths.pid);
  if (!pid || !isProcessAlive(pid)) {
    if (existsSync(paths.pid)) unlinkSync(paths.pid);
    const status = readJson<DiscordGatewayStatus>(paths.status);
    const lines = [configured ? "Discord gateway is stopped." : "Discord gateway is not configured. Run /discord setup."];
    if (status?.state === "failed" && status.lastError) lines.push(`Last error: ${status.lastError}`);
    if (configured) lines.push(`Config: ${paths.config}`);
    lines.push(`Logs: ${paths.log}`);
    notify(ctx, lines.join("\n"), status?.state === "failed" ? "error" : "info");
    return;
  }

  const status = readJson<DiscordGatewayStatus>(paths.status);
  const lines = [`Discord gateway: ${status?.state || "running"} (PID ${pid})`];
  if (status?.botTag) lines.push(`Bot: ${status.botTag}`);
  if (status?.lastEventAt) lines.push(`Last authorized message: ${status.lastEventAt}`);
  if (status?.lastError) lines.push(`Last error: ${status.lastError}`);
  lines.push(`Logs: ${paths.log}`);
  notify(ctx, lines.join("\n"), status?.state === "failed" ? "error" : "info");
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

function readPid(path: string): number | undefined {
  const value = readJson<{ pid?: unknown }>(path)?.pid;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
