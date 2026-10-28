import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { loadGatewayConfig } from "./runtime/config.mjs";
import { createCommandHandlers } from "./runtime/commands.mjs";
import { createInteractionManager } from "./runtime/interactions.mjs";
import { createLifecycle } from "./runtime/lifecycle.mjs";
import { log, safeErrorName, summarizeDiscordError } from "./runtime/logging.mjs";
import { PiRpcSession } from "./runtime/pi-rpc.mjs";
import { createMessageRouter } from "./runtime/router.mjs";
import { createSessionManager } from "./runtime/sessions.mjs";
import { createThreadRegistry } from "./runtime/threads.mjs";

// This remains the standalone Node entry point used by /discord and restarts.
const { config, paths, piExecutable, piArgs, startReason } = loadGatewayConfig();
const allowedUsers = new Set(config.allowedUserIds);
const allowedChannels = new Set(config.allowedChannelIds);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});
const threads = createThreadRegistry({ threadsPath: paths.threadsPath });
const interactions = createInteractionManager();
// Lazy callbacks break the lifecycle/command dependency without shared mutable state.
const sessions = createSessionManager({
  sessionRoot: paths.sessionRoot,
  createSession: (directory) => new PiRpcSession(directory, { config, piExecutable, piArgs, interactions }),
  onSessionClosed: (session) => commands.cancelSession(session),
});
const lifecycle = createLifecycle({
  client, config, paths,
  daemonPath: fileURLToPath(import.meta.url),
  sessions, interactions,
  closeCommands: () => commands.close(),
});
const commands = createCommandHandlers({
  client, config, configPath: paths.configPath,
  allowedUsers, allowedChannels, threads, sessions, lifecycle,
});
const router = createMessageRouter({
  client, config, allowedUsers, allowedChannels, threads, sessions, interactions, lifecycle,
});

client.on("clientReady", (readyClient) => {
  lifecycle.updateStatus("ready", { botTag: readyClient.user.tag, lastError: undefined });
  log(`Connected as ${readyClient.user.tag}`);
  void commands.registerSlashCommands(readyClient);
  void lifecycle.sendHomeNotification(startReason === "start"
    ? "Discord gateway started and is online."
    : "Discord gateway restarted and is online.");
});
client.on("shardDisconnect", (event) => {
  lifecycle.updateStatus("disconnected", {
    lastError: `Discord gateway disconnected (code ${Number(event?.code) || "unknown"}); reconnecting if possible.`,
  });
});
client.on("shardResume", () => lifecycle.updateStatus("ready", { lastError: undefined }));
client.on("error", (error) => {
  lifecycle.updateStatus("disconnected", { lastError: summarizeDiscordError(error) });
  log(`Discord client error: ${summarizeDiscordError(error)}`);
});
client.on("messageCreate", (message) => {
  void lifecycle.handleMessage(() => router.handleMessage(message));
});
client.on("interactionCreate", (interaction) => {
  if (interaction.isChatInputCommand?.()) {
    void commands.handleChatInputCommand(interaction).catch((error) => {
      log(`Discord slash command failed: ${safeErrorName(error)}`);
    });
    return;
  }
  const handler = typeof interaction.customId === "string" && interaction.customId.startsWith("picmd:")
    ? commands.handleConversationSettingInteraction
    : interactions.handleInteraction;
  void handler(interaction).catch((error) => {
    log(`Discord UI interaction failed: ${safeErrorName(error)}`);
  });
});

lifecycle.start();
try {
  await client.login(config.token);
} catch (error) {
  const summary = summarizeDiscordError(error);
  lifecycle.updateStatus("failed", { lastError: summary });
  log(`Discord login failed: ${summary}`);
  await lifecycle.shutdown("login failure", 1);
}
