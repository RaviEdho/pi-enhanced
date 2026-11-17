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
import { refreshProviderCatalogs } from "../providers/refresh.js";
import { getAvailablePickerModels } from "../ux/available-models.js";
import { DiscordConfirmationDialog, type DiscordConfirmationDialogOptions } from "./confirm-dialog.js";
import { DiscordInputDialog } from "./input-dialog.js";
import { withDiscordDialogSession } from "./dialog-session.js";
import { selectDiscordModel } from "./model-dialog.js";
import { DiscordSelectDialog, type DiscordSelectDialogOptions } from "./select-dialog.js";
import { DiscordToggleDialog, type DiscordAccessPaths } from "./toggle-dialog.js";
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
  type DiscordGatewayStatus,
  type DiscordToolCallVisibility,
  type DiscordTableRendering,
} from "./storage.js";

const TOKEN_ENV_VAR = "PI_ENHANCED_DISCORD_BOT_TOKEN";

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

  let selectedOption: string | undefined;
  while (true) {
    const config = readDiscordGatewayConfig();
    if (!config) {
      await setupGateway(ctx);
      return;
    }

    const selected = await selectDiscordOption(ctx, {
      title: "Discord Settings",
      selectedOption,
      options: [
        {
          label: "Bot token",
          currentValue: "configured",
          description: "Replace the saved Discord bot token. Input is visible; the token is stored in private local config.",
        },
        {
          label: "Allowed users",
          currentValue: config.allowedUserIds.includes("*") ? "everyone" : config.allowedUserIds.length ? `${config.allowedUserIds.length} allowed` : "none (blocked)",
          description: 'Choose which Discord users can interact in DMs and servers. Use "*" for everyone or "off" to block all users.',
        },
        {
          label: "Allowed channels",
          currentValue: config.allowedChannelIds.includes("*") ? "all channels" : config.allowedChannelIds.length ? `${config.allowedChannelIds.length} allowed` : "none (servers/history blocked)",
          description: 'Choose allowed channels, "*" for all, or "off" to block server messages/history. DM messaging uses only the user whitelist; shared-thread participants may see history results.',
        },
        {
          label: "Notification channel",
          currentValue: config.homeChannelId ?? "off",
          description: "Set the text channel for gateway start, restart, stop, and failure notices, or turn notifications off.",
        },
        {
          label: "Workspace",
          currentValue: config.cwd,
          description: "Set the starting directory for gateway Pi sessions. This is not a filesystem sandbox; tools may access other files.",
        },
        {
          label: "Default model",
          currentValue: config.model ? `${config.model.provider}/${config.model.id}` : "Pi default",
          description: "Choose the model used when gateway Pi sessions start, or follow Pi's configured default.",
        },
        {
          label: "Message access",
          currentValue: `DMs ${config.allowDirectMessages ? "on" : "off"} · Servers ${config.allowServerMessages ? "on" : "off"}`,
          description: "Enable or disable direct messages and server messages independently. User and channel allowlists still apply.",
        },
        {
          label: "Tool call verbosity",
          currentValue: config.toolCallVerbosity ?? "full",
          description: "Control tool activity shown in Discord: none, tool only, or full (including intermediate assistant text). Workspace change notices stay visible.",
        },
        {
          label: "Tool call visibility",
          currentValue: `Channels ${config.toolCallVisibility?.channels ? "on" : "off"} · Threads ${config.toolCallVisibility?.threads !== false ? "on" : "off"} · DMs ${config.toolCallVisibility?.dms !== false ? "on" : "off"}`,
          description: "Show or hide tool activity and intermediate assistant text separately in server channels, threads, and DMs. Prompts and workspace notices stay visible.",
        },
        {
          label: "Tables",
          currentValue: config.tableRendering?.enabled === true ? `On · Title/footer ${config.tableRendering?.showTitleFooter ? "on" : "off"} · Markdown ${config.tableRendering?.attachMarkdown ? "on" : "off"}` : "rendering off",
          description: "Enable or disable table images (off by default). Title/footer and Markdown attachment are independent options and also default to off.",
        },
        {
          label: "Channel replies",
          currentValue: channelReplyModeLabel(config.channelReplies.mode),
          description: "Choose where new server conversations answer: a thread, the channel, or a routing model's choice. Existing threads and DMs are unchanged.",
        },
        {
          label: "Channel sessions",
          currentValue: config.channelSessions?.enabled !== false
            ? `${config.channelSessions?.resetHour ?? 4}:00 · ${config.channelSessions?.timezone ?? "Asia/Jakarta"} · ${config.channelSessions?.idleHours ?? 6}h quiet`
            : "overnight rollover off",
          description: "Configure overnight context rollover. Busy nights are skipped; replying to a bot message always continues its linked session without changing the default.",
        },
        {
          label: "Recent context",
          currentValue: contextMessagesLabel(config.contextMessages),
          description: "Set surrounding messages added for context: before the reply target when replying, or before your new message otherwise. Non-replies skip already-delivered context; off disables history.",
        },
        ...(config.channelReplies.mode === "auto"
          ? [
            {
              label: "Routing model",
              currentValue: routingModelLabel(config.channelReplies.routerModel),
              description: "Use the cheapest authenticated model, Pi's global default, the gateway's default, or a specific model. Each routing decision costs one model call; failures start a thread.",
            },
            {
              label: "Routing context",
              currentValue: contextMessagesLabel(config.channelReplies.contextMessages ?? 5),
              description: "Set channel messages sent to the router, independently of the agent: before the reply target when replying, otherwise before your new message. The direct quote is always included; off disables only history.",
            },
            {
              label: "Tool escalation",
              currentValue: config.channelReplies.escalate ? "on" : "off",
              description: "Open a thread when a channel reply uses editing, shell, or delegation tools. Read-only replies stay in the channel; the thread inherits the conversation.",
            },
            {
              label: "Follow-up escalation",
              currentValue: config.channelReplies.followUp ? "on" : "off",
              description: "Open a thread when the same user mentions the bot again in the same channel within ten minutes of a channel reply. When off, the routing model decides.",
            },
          ]
          : []),
      ],
    });
    selectedOption = selected;
    switch (selected) {
      case "Bot token":
        await configureBotToken(ctx, config);
        break;
      case "Allowed users":
        await configureWhitelist(ctx, config, "users");
        break;
      case "Allowed channels":
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
      case "Tool call verbosity":
        await configureToolCallVerbosity(ctx, config);
        break;
      case "Tool call visibility":
        await configureToolCallVisibility(ctx, config);
        break;
      case "Tables":
        await configureTableRendering(ctx, config);
        break;
      case "Channel replies":
        await configureChannelReplies(ctx, config);
        break;
      case "Channel sessions":
        await configureChannelSessions(ctx, config);
        break;
      case "Recent context":
        await configureContextMessages(ctx, config);
        break;
      case "Routing model":
        await configureRoutingModel(ctx, config);
        break;
      case "Routing context":
        await configureContextMessages(ctx, config, true);
        break;
      case "Tool escalation":
        await configureToolEscalation(ctx, config);
        break;
      case "Follow-up escalation":
        await configureFollowUpEscalation(ctx, config);
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
      label: currentValue ? "Pi default" : "Pi default (current)",
      description: "Use Pi's configured default at startup",
    },
    ...models.map(({ value, model }) => ({
      value,
      label: `${value}${value === currentValue ? " (current)" : ""}`,
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

async function configureToolCallVerbosity(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = config.toolCallVerbosity ?? "full";
  const selected = await selectDiscordOption(ctx, {
    title: "Tool call verbosity",
    description: "Full includes intermediate assistant text; tool only shows tool activity. Workspace change notices remain visible.",
    options: ["none", "tool only", "full"].map((label) => `${label}${label.replace(" ", "-") === current ? " (current)" : ""}`),
  });
  if (!selected) return;
  const value = selected.startsWith("none") ? "none" : selected.startsWith("tool only") ? "tool-only" : "full";
  if (value === current) {
    notify(ctx, "Tool call verbosity is unchanged.", "info");
    return;
  }
  saveGatewayConfig(ctx, config, { toolCallVerbosity: value }, `Tool call verbosity set to ${value}.`);
}

async function configureToolCallVisibility(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = { channels: false, threads: true, dms: true, ...config.toolCallVisibility };
  const destinations: { key: keyof DiscordToolCallVisibility; label: string }[] = [
    { key: "channels", label: "Server channels" },
    { key: "threads", label: "Threads" },
    { key: "dms", label: "Direct messages" },
  ];
  const selected = await selectDiscordOption(ctx, {
    title: "Tool call visibility",
    description: "Choose where to change tool activity and intermediate assistant text. Verbosity still applies where enabled; prompts and workspace notices stay visible.",
    options: destinations.map(({ key, label }) => ({
      label,
      currentValue: current[key] ? "on" : "off",
      description: `Show or hide tool activity and intermediate assistant text in ${label.toLowerCase()}. Prompts and workspace notices remain visible.`,
    })),
  });
  const destination = destinations.find(({ label }) => label === selected);
  if (!destination) return;
  const enabled = current[destination.key];
  const choice = await selectDiscordOption(ctx, {
    title: `Tool calls: ${destination.label}`,
    options: [enabled ? "On (current)" : "On", enabled ? "Off" : "Off (current)"],
  });
  if (!choice) return;
  const value = choice.startsWith("On");
  if (value === enabled) {
    notify(ctx, "Tool call visibility is unchanged.", "info");
    return;
  }
  saveGatewayConfig(ctx, config, {
    toolCallVisibility: { ...current, [destination.key]: value },
  }, `Tool call info in ${destination.label.toLowerCase()} turned ${value ? "on" : "off"}.`);
}

async function configureTableRendering(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = { enabled: false, showTitleFooter: false, attachMarkdown: false, ...config.tableRendering };
  const settings: { key: keyof DiscordTableRendering; label: string; description: string }[] = [
    { key: "enabled", label: "Render tables", description: "Convert Markdown tables to images. Off sends the original Markdown as text, without table images or .md attachments; other table preferences are preserved." },
    { key: "showTitleFooter", label: "Title and footer", description: "Show the table title, page numbering and row/column ranges together. Off shows only the table grid." },
    { key: "attachMarkdown", label: "Markdown attachment", description: "Attach the original table as a .md file alongside its images for copying text and links." },
  ];
  const selected = await selectDiscordOption(ctx, {
    title: "Discord Tables",
    options: settings.map(({ key, label, description }) => ({ label, description, currentValue: current[key] ? "on" : "off" })),
  });
  const setting = settings.find(({ label }) => label === selected);
  if (!setting) return;
  const enabled = current[setting.key];
  const choice = await selectDiscordOption(ctx, {
    title: `Tables: ${setting.label}`,
    description: setting.description,
    options: [enabled ? "On (current)" : "On", enabled ? "Off" : "Off (current)"],
  });
  if (!choice) return;
  const value = choice.startsWith("On");
  if (value === enabled) {
    notify(ctx, "Table rendering is unchanged.", "info");
    return;
  }
  saveGatewayConfig(ctx, config, {
    tableRendering: { ...current, [setting.key]: value },
  }, `Table ${setting.label.toLowerCase()} turned ${value ? "on" : "off"}.`);
}

async function configureChannelSessions(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = { ...DEFAULT_DISCORD_CHANNEL_SESSIONS, ...config.channelSessions };
  const selected = await selectDiscordOption(ctx, {
    title: "Channel sessions",
    description: "At the daily boundary, roll over only after the inactivity window and with no running/queued work. Otherwise skip until the next day. Old replies keep their linked sessions; plain mentions use the newest default. Restart the gateway to apply changes.",
    options: [
      { label: "Overnight rollover", currentValue: current.enabled ? "on" : "off", description: "Enable daily context rotation without deleting older reply-linked sessions." },
      { label: "Timezone", currentValue: current.timezone, description: "Use an explicit IANA timezone, independent of the server's clock settings." },
      { label: "Reset hour", currentValue: `${String(current.resetHour).padStart(2, "0")}:00`, description: "Local hour at which each day's rollover eligibility is evaluated." },
      { label: "Inactivity window", currentValue: `${current.idleHours} hours`, description: "Required quiet time before the daily boundary. Busy nights skip the entire day." },
    ],
  });
  if (!selected) return;
  const next = { ...current };
  if (selected === "Overnight rollover") {
    const choice = await selectDiscordOption(ctx, {
      title: "Overnight rollover",
      options: [current.enabled ? "On (current)" : "On", current.enabled ? "Off" : "Off (current)"],
    });
    if (!choice) return;
    next.enabled = choice.startsWith("On");
  } else {
    const timezone = selected === "Timezone";
    const hour = selected === "Reset hour";
    const value = await promptDiscordInput(ctx, {
      title: selected,
      instruction: timezone ? "IANA timezone, e.g. Asia/Jakarta or UTC."
        : hour ? "Whole hour in the selected timezone (0–23)."
        : "Whole hours without accepted requests in the default session (1–168). A request exactly at the cutoff skips that day's rollover.",
      initialValue: timezone ? current.timezone : String(hour ? current.resetHour : current.idleHours),
      placeholder: timezone ? "Asia/Jakarta" : hour ? "4" : "6",
    });
    if (value === undefined) return;
    if (timezone) next.timezone = value.trim();
    else if (hour) next.resetHour = value.trim() ? Number(value) : Number.NaN;
    else next.idleHours = value.trim() ? Number(value) : Number.NaN;
  }
  if (!isValidDiscordChannelSessions(next)) {
    notify(ctx, "Use a valid IANA timezone, reset hour 0–23, and inactivity window 1–168 whole hours.", "error");
    return;
  }
  saveGatewayConfig(ctx, config, { channelSessions: next }, "Channel session settings saved.");
}

async function configureContextMessages(ctx: ExtensionCommandContext, config: DiscordGatewayConfig, routing = false): Promise<void> {
  const current = routing ? config.channelReplies.contextMessages ?? 5 : config.contextMessages;
  const title = routing ? "Routing context" : "Recent context";
  const values = [...new Set([0, 3, 5, 10, 20, 25, current])].sort((a, b) => a - b);
  const label = (value: number) => value === 0 ? "Off" : `${value} message${value === 1 ? "" : "s"}`;
  const selected = await selectDiscordOption(ctx, {
    title,
    description: routing
      ? "Messages sent to the router before the reply target, or before your new message when not replying. Independent of agent context. Off disables history, not the direct quote. More context uses more input tokens."
      : "Messages before the reply target, or before your new message when not replying. Non-replies skip already-delivered context; explicit replies revisit older context. Off disables history.",
    options: values.map((value) => `${label(value)}${value === current ? " (current)" : ""}`),
  });
  if (!selected) return;
  const value = values.find((entry) => selected.startsWith(label(entry)));
  if (value === undefined) return;
  if (value === current) {
    notify(ctx, `${title} is unchanged.`, "info");
    return;
  }
  saveGatewayConfig(
    ctx,
    config,
    routing ? { channelReplies: { ...config.channelReplies, contextMessages: value } } : { contextMessages: value },
    value === 0 ? `${title} disabled.${routing ? " Direct reply quotes remain included." : ""}` : `${title} set to ${label(value).toLowerCase()}.`
  );
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

async function configureChannelReplies(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = config.channelReplies.mode;
  const choices: { value: DiscordChannelReplyMode; label: string; result: string }[] = [
    { value: "always-thread", label: "Always start a thread", result: "New server conversations start in a thread." },
    { value: "channel", label: "Always answer in the channel", result: "New server conversations answer directly in the channel." },
    { value: "auto", label: "Model decides", result: "New server conversations ask a routing model where to answer; failures start a thread." },
  ];
  const selected = await selectDiscordOption(ctx, {
    title: "Channel replies",
    description: "Where a new server conversation answers when the bot is mentioned. Threads keep long work out of the channel. Existing threads and DMs are unchanged.",
    options: choices.map((choice) => `${choice.label}${choice.value === current ? " (current)" : ""}`),
  });
  if (!selected) return;
  const choice = choices.find((entry) => selected.startsWith(entry.label));
  if (!choice) return;
  if (choice.value === current) {
    notify(ctx, "Channel replies are unchanged.", "info");
    return;
  }
  saveGatewayConfig(ctx, config, { channelReplies: { ...config.channelReplies, mode: choice.value } }, choice.result);
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
      label: currentValue ? "Cheapest available" : "Cheapest available (current)",
      description: "Use the lowest-cost authenticated chat model at decision time",
    },
    {
      value: "pi-default",
      label: `Pi default${currentValue === "pi-default" ? " (current)" : ""}`,
      description: "Follow Pi's global saved default at each decision; missing/unavailable defaults start a thread",
    },
    {
      value: "gateway-default",
      label: `Gateway default${currentValue === "gateway-default" ? " (current)" : ""}`,
      description: "Follow the gateway's configured default; use the cheapest authenticated model when unset",
    },
    ...models.map(({ value, model }) => ({
      value,
      label: `${value}${value === currentValue ? " (current)" : ""}`,
      description: model.name,
    })),
  ];
  const selected = await selectDiscordModel(ctx, choices, currentValue, refresh, {
    title: "Discord Routing Model",
    description: `Current: ${routingModelLabel(routerModel)}. Chooses channel or thread replies; defaults are followed at decision time.`,
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

async function configureToolEscalation(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = config.channelReplies.escalate;
  const selected = await selectDiscordOption(ctx, {
    title: "Tool escalation",
    description: "Open a thread when a channel reply used editing, shell, or delegation tools. Read-only replies stay in the channel. The thread inherits the channel conversation.",
    options: [`On${current ? " (current)" : ""}`, `Off${current ? "" : " (current)"}`],
  });
  if (!selected) return;
  const value = selected.startsWith("On");
  if (value === current) {
    notify(ctx, "Tool escalation is unchanged.", "info");
    return;
  }
  saveGatewayConfig(
    ctx,
    config,
    { channelReplies: { ...config.channelReplies, escalate: value } },
    `Tool escalation turned ${value ? "on" : "off"}.`
  );
}

async function configureFollowUpEscalation(ctx: ExtensionCommandContext, config: DiscordGatewayConfig): Promise<void> {
  const current = config.channelReplies.followUp;
  const selected = await selectDiscordOption(ctx, {
    title: "Follow-up escalation",
    description: "Open a thread when the same user mentions the bot again in the same channel within ten minutes of a channel reply. Turning this off leaves every new mention to the routing model.",
    options: [`On${current ? " (current)" : ""}`, `Off${current ? "" : " (current)"}`],
  });
  if (!selected) return;
  const value = selected.startsWith("On");
  if (value === current) {
    notify(ctx, "Follow-up escalation is unchanged.", "info");
    return;
  }
  saveGatewayConfig(
    ctx,
    config,
    { channelReplies: { ...config.channelReplies, followUp: value } },
    `Follow-up escalation turned ${value ? "on" : "off"}.`
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
    options.options.map((option) => typeof option === "string" ? option : option.label)
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

  if (input.trim().toLowerCase() === "off") return [];
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
