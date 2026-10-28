import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { buildConversationSettingPayload } from "./components.mjs";
import { replyEphemeral } from "./interactions.mjs";
import { log, safeErrorName, summarizeDiscordError } from "./logging.mjs";
import { writePrivateJson } from "./persistence.mjs";

const UI_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function createCommandHandlers({ client, config, configPath, allowedUsers, allowedChannels, threads, sessions, lifecycle }) {
  const pendingDiscordCommands = new Map();

  async function registerSlashCommands(readyClient) {
    try {
      const commands = [
        new SlashCommandBuilder()
          .setName("sethome")
          .setDescription("Set the home channel for gateway notifications to this channel"),
        new SlashCommandBuilder()
          .setName("model")
          .setDescription("Choose the model for this Discord conversation"),
        new SlashCommandBuilder()
          .setName("thinking")
          .setDescription("Choose the thinking level for this Discord conversation"),
      ].map((command) => command.toJSON());
      await readyClient.application?.commands.set(commands);

      // Keep these as global commands only; registering both scopes makes Discord
      // display duplicate entries. Remove guild-scoped copies created by older versions,
      // while preserving any unrelated commands registered directly in those guilds.
      const gatewayCommandNames = new Set(["sethome", "model", "thinking", "reasoning"]);
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          const guildCommands = await guild.commands.fetch();
          await Promise.all(
            guildCommands
              .filter((command) => gatewayCommandNames.has(command.name))
              .map((command) => command.delete()),
          );
        } catch (error) {
          log(`Failed to remove duplicate guild slash commands in ${guild.id}: ${summarizeDiscordError(error)}`);
        }
      }
      log("Discord slash commands registered globally; duplicate guild-scoped commands cleaned up.");
    } catch (error) {
      log(`Failed to register slash commands: ${summarizeDiscordError(error)}`);
    }
  }

  async function handleChatInputCommand(interaction) {
    if (interaction.commandName === "model" || interaction.commandName === "thinking") {
      await handleConversationSettingCommand(interaction, interaction.commandName);
      return;
    }
    if (interaction.commandName !== "sethome") return;

    if (!allowedUsers.has("*") && !allowedUsers.has(interaction.user?.id)) {
      await replyEphemeral(interaction, "You are not authorized to configure this bot.");
      return;
    }

    if (!interaction.guildId) {
      await replyEphemeral(interaction, "The home channel must be a server text channel. Please run this command in a server channel.");
      return;
    }

    let targetChannel = interaction.channel;
    let targetChannelId = interaction.channelId;
    let isThread = false;

    if (targetChannel?.isThread?.()) {
      isThread = true;
      targetChannelId = targetChannel.parentId;
      targetChannel = targetChannel.parent || (targetChannelId ? await client.channels.fetch(targetChannelId).catch(() => null) : null);
    }

    if (!targetChannel || !targetChannelId) {
      await replyEphemeral(interaction, "Could not determine the target channel.");
      return;
    }

    if (!targetChannel.isTextBased?.() || typeof targetChannel.send !== "function") {
      await replyEphemeral(interaction, "The home channel must be a text-based server channel where the bot can send messages.");
      return;
    }

    const me = interaction.guild?.members?.me || (await interaction.guild?.members?.fetchMe().catch(() => null));
    if (me) {
      const permissions = targetChannel.permissionsFor?.(me);
      if (permissions && (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages))) {
        await replyEphemeral(
          interaction,
          `I don't have permission to view or send messages in <#${targetChannelId}>. Please ensure the bot has View Channel and Send Messages permissions.`
        );
        return;
      }
    }

    if (targetChannelId === config.homeChannelId) {
      const text = isThread
        ? `<#${targetChannelId}> (parent channel of this thread) is already configured as the home channel.`
        : `<#${targetChannelId}> is already configured as the home channel.`;
      try {
        await interaction.reply({ content: text, allowedMentions: { parse: [] } });
      } catch {
        // Best-effort response.
      }
      return;
    }

    let latestConfig;
    try {
      latestConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      latestConfig = { ...config };
    }

    latestConfig.homeChannelId = targetChannelId;
    latestConfig.configuredAt = new Date().toISOString();

    if (!allowedChannels.has("*") && !allowedChannels.has(targetChannelId)) {
      allowedChannels.add(targetChannelId);
      latestConfig.allowedChannelIds = [...new Set([...(latestConfig.allowedChannelIds || []), targetChannelId])];
    }

    writePrivateJson(configPath, latestConfig);
    config.homeChannelId = targetChannelId;
    log(`Home channel set to ${targetChannelId} by ${interaction.user?.tag || interaction.user?.id}`);

    const confirmationText = isThread
      ? `Home channel set to <#${targetChannelId}> (parent channel of this thread).`
      : `Home channel set to <#${targetChannelId}>.`;

    try {
      await interaction.reply({ content: confirmationText, allowedMentions: { parse: [] } });
    } catch (replyError) {
      log(`Failed to reply to /sethome command: ${safeErrorName(replyError)}`);
    }
  }

  async function handleConversationSettingCommand(interaction, setting) {
    if (lifecycle.isStopping()) {
      await replyEphemeral(interaction, "The Discord gateway is restarting or stopping. Please try again when it is back online.");
      return;
    }
    if (!allowedUsers.has("*") && !allowedUsers.has(interaction.user?.id)) {
      await replyEphemeral(interaction, "You are not authorized to control this bot.");
      return;
    }

    const sessionKey = getConversationSessionKey(interaction);
    if (!sessionKey) {
      await replyEphemeral(interaction, "Use this command in a direct message or an active gateway conversation thread.");
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const session = await sessions.get(sessionKey);
      if (session.running) {
        await interaction.editReply("This conversation is currently generating a response. Try again when it finishes.");
        return;
      }

      let options;
      let state;
      if (setting === "model") {
        const [modelsResponse, stateResponse] = await Promise.all([
          session.request("get_available_models"),
          session.request("get_state"),
        ]);
        if (!modelsResponse.success || !stateResponse.success) throw new Error("Could not read model settings");
        options = Array.isArray(modelsResponse.data?.models) ? modelsResponse.data.models : [];
        state = stateResponse.data;
        if (options.length === 0) {
          await interaction.editReply("No models are currently available to this Pi session.");
          return;
        }
      } else {
        const [levelsResponse, stateResponse] = await Promise.all([
          session.request("get_available_thinking_levels"),
          session.request("get_state"),
        ]);
        if (!levelsResponse.success || !stateResponse.success) throw new Error("Could not read thinking settings");
        options = Array.isArray(levelsResponse.data?.levels) ? levelsResponse.data.levels : [];
        state = stateResponse.data;
        if (options.length === 0) {
          await interaction.editReply("The current model does not support configurable thinking levels.");
          return;
        }
      }

      const token = randomUUID();
      const pending = {
        token,
        setting,
        session,
        sessionKey,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        options,
        current: setting === "model"
          ? `${state?.model?.provider}/${state?.model?.id}`
          : state?.thinkingLevel,
        page: 0,
      };
      pending.timer = setTimeout(() => pendingDiscordCommands.delete(token), UI_DEFAULT_TIMEOUT_MS);
      pending.timer.unref?.();
      pendingDiscordCommands.set(token, pending);
      await interaction.editReply(buildConversationSettingPayload(pending));
    } catch (error) {
      log(`Discord /${setting} failed: ${safeErrorName(error)}`);
      await interaction.editReply(`Could not load ${setting} settings from this Pi session.`).catch(() => undefined);
    }
  }

  function getConversationSessionKey(interaction) {
    const userId = interaction.user?.id;
    if (!userId || !interaction.channelId) return undefined;
    if (interaction.guildId == null) {
      return config.allowDirectMessages !== false ? `dm:${interaction.channelId}:${userId}` : undefined;
    }
    if (config.allowServerMessages === false || !interaction.channel?.isThread?.()) return undefined;
    const registration = threads.get(interaction.channelId);
    if (!registration || (!allowedChannels.has("*") && !allowedChannels.has(registration.parentChannelId))) return undefined;
    return `guild:${registration.parentChannelId}:thread:${interaction.channelId}:user:${userId}`;
  }

  async function handleConversationSettingInteraction(interaction) {
    const [, token, action] = interaction.customId.split(":");
    const pending = pendingDiscordCommands.get(token);
    if (!pending || interaction.user?.id !== pending.userId || interaction.channelId !== pending.channelId) {
      await replyEphemeral(interaction, "This setting picker is no longer active or belongs to another user.");
      return;
    }
    if (action === "prev" || action === "next") {
      const pageCount = Math.ceil(pending.options.length / 25);
      pending.page = action === "prev"
        ? Math.max(0, pending.page - 1)
        : Math.min(pageCount - 1, pending.page + 1);
      await interaction.update(buildConversationSettingPayload(pending));
      return;
    }
    if (!interaction.isStringSelectMenu?.() || action !== "select") {
      await replyEphemeral(interaction, "That control doesn't match this setting picker.");
      return;
    }

    const selectedIndex = Number(interaction.values?.[0]);
    const selected = Number.isInteger(selectedIndex) ? pending.options[selectedIndex] : undefined;
    if (selected === undefined) {
      await replyEphemeral(interaction, "That setting is no longer available.");
      return;
    }
    clearTimeout(pending.timer);
    pendingDiscordCommands.delete(token);
    await interaction.deferUpdate();
    void lifecycle.trackTask(sessions.enqueue(pending.sessionKey, async () => {
      if (lifecycle.isStopping()) throw new Error("The gateway is restarting or stopping");
      if (pending.session.closed || sessions.peek(pending.sessionKey) !== pending.session) {
        throw new Error("The conversation session is no longer active");
      }
      const result = pending.setting === "model"
        ? await pending.session.request("set_model", { provider: selected.provider, modelId: selected.id })
        : await pending.session.request("set_thinking_level", { level: selected });
      if (!result.success) throw new Error(result.error || "Pi rejected the setting");
      const label = pending.setting === "model"
        ? `${selected.provider}/${selected.id}`
        : String(selected);
      await interaction.editReply({
        content: `This conversation will use ${pending.setting === "model" ? "model" : "thinking level"} **${label}**.`,
        components: [],
        allowedMentions: { parse: [] },
      });
    }).catch(async (error) => {
      log(`Discord /${pending.setting} selection failed: ${safeErrorName(error)}`);
      await interaction.editReply({
        content: `Could not apply that ${pending.setting} setting. Run the command again and choose an available option.`,
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }));
  }

  function close() {
    for (const pending of pendingDiscordCommands.values()) clearTimeout(pending.timer);
    pendingDiscordCommands.clear();
  }

  function cancelSession(session) {
    for (const [token, pending] of pendingDiscordCommands) {
      if (pending.session !== session) continue;
      clearTimeout(pending.timer);
      pendingDiscordCommands.delete(token);
    }
  }

  return { registerSlashCommands, handleChatInputCommand, handleConversationSettingInteraction, close, cancelSession };
}
