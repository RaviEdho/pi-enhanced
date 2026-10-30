import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { buildCommitCardPayload, buildConversationSettingPayload } from "./components.mjs";
import { replyEphemeral } from "./interactions.mjs";
import { discordOptionLabel, startTyping } from "./messages.mjs";
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
          .setDescription("Choose the model for this Discord conversation")
          .addStringOption((option) => option
            .setName("model")
            .setDescription("Search available models, or leave blank to open the picker")
            .setRequired(false)
            .setAutocomplete(true)),
        new SlashCommandBuilder()
          .setName("commit")
          .setDescription("Review and commit changes in this conversation's working directory")
          .addStringOption((option) => option
            .setName("args")
            .setDescription("Optional instruction or flags, e.g. fix login timeout, -u, -s, or -m")
            .setRequired(false)),
        new SlashCommandBuilder()
          .setName("thinking")
          .setDescription("Choose the thinking level for this Discord conversation")
          .addStringOption((option) => option
            .setName("level")
            .setDescription("Search available thinking levels")
            .setRequired(true)
            .setAutocomplete(true)),
      ].map((command) => command.toJSON());
      await readyClient.application?.commands.set(commands);

      // Keep these as global commands only; registering both scopes makes Discord
      // display duplicate entries. Remove guild-scoped copies created by older versions,
      // while preserving any unrelated commands registered directly in those guilds.
      const gatewayCommandNames = new Set(["sethome", "model", "thinking", "reasoning", "commit"]);
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

  async function handleAutocomplete(interaction) {
    const setting = interaction.commandName === "model" || interaction.commandName === "thinking"
      ? interaction.commandName
      : undefined;
    if (!setting) return;

    const respond = async (choices) => {
      try {
        await interaction.respond(choices);
      } catch {
        // Discord autocomplete interactions expire quickly; stale replies are best-effort.
      }
    };

    if (lifecycle.isStopping() || (!allowedUsers.has("*") && !allowedUsers.has(interaction.user?.id))) {
      await respond([]);
      return;
    }
    const sessionKey = getConversationSessionKey(interaction);
    if (!sessionKey) {
      await respond([]);
      return;
    }

    try {
      const expectedOption = setting === "model" ? "model" : "level";
      const focused = interaction.options.getFocused(true);
      if (focused.name !== expectedOption) {
        await respond([]);
        return;
      }
      const session = sessions.peek(sessionKey);
      if (!session || session.closed) {
        await respond([]);
        return;
      }

      const response = await session.request(
        setting === "model" ? "get_available_models" : "get_available_thinking_levels",
        {},
        2000,
      );
      if (!response.success) {
        await respond([]);
        return;
      }
      const query = typeof focused.value === "string" ? focused.value : "";
      const options = setting === "model"
        ? buildModelAutocompleteChoices(response.data?.models, query)
        : buildThinkingAutocompleteChoices(response.data?.levels, query);
      await respond(options);
    } catch (error) {
      log(`Discord /${setting} autocomplete failed: ${safeErrorName(error)}`);
      await respond([]);
    }
  }

  async function handleChatInputCommand(interaction) {
    if (interaction.commandName === "commit") {
      await lifecycle.trackTask(handleCommitCommand(interaction));
      return;
    }
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

  async function handleCommitCommand(interaction) {
    if (lifecycle.isStopping()) {
      await replyEphemeral(interaction, "The Discord gateway is restarting or stopping. Please try again when it is back online.");
      return;
    }
    if (!allowedUsers.has("*") && !allowedUsers.has(interaction.user?.id)) {
      await replyEphemeral(interaction, "You are not authorized to control this bot.");
      return;
    }
    const sessionKey = getConversationSessionKey(interaction);
    if (!sessionKey || typeof interaction.channel?.send !== "function") {
      await replyEphemeral(interaction, "Use this command in a direct message or an active gateway conversation thread.");
      return;
    }

    const args = interaction.options?.getString("args")?.trim() || "";
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(buildCommitCardPayload("Commit request queued. Staging prompts and commit review will appear in this conversation."));
    try {
      await sessions.enqueue(sessionKey, () => sessions.withRunSlot(async () => {
        // Resolve after dequeuing: earlier work may have switched this conversation's
        // workspace. The command runs in this child's ctx.cwd, never config.cwd.
        const session = await sessions.get(sessionKey);
        const available = await session.request("get_commands");
        if (!available.success || !available.data?.commands?.some((command) => command.name === "commit" && command.source === "extension")) {
          await interaction.editReply(buildCommitCardPayload("The /commit extension command is not loaded in this Pi session. Enable pi-enhanced for the gateway's configured Pi executable, then restart the gateway.", { notifyType: "error" }));
          return;
        }
        await interaction.editReply(buildCommitCardPayload("Staging prompts and commit review will appear in this conversation.", { workspace: session.cwd }));
        const typing = startTyping(interaction.channel);
        try {
          // Send the real extension command, not a natural-language agent prompt.
          // The prompt response arrives only after the command and its dialogs finish.
          await session.promptAndWait(`/commit${args ? ` ${args}` : ""}`, {
            channel: interaction.channel,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            typing,
            workflow: "commit",
          }, [], { extensionCommand: true });
          await interaction.editReply(buildCommitCardPayload("Commit workflow finished. See the updated commit card for the result.", { workspace: session.cwd })).catch(() => undefined);
        } catch (error) {
          await session.ui.sendCommitNotice(interaction.channel, "Could not complete the commit workflow. Check the gateway logs before retrying.", "error").catch(() => undefined);
          throw error;
        } finally {
          typing.stop();
        }
      }));
    } catch (error) {
      log(`Discord /commit failed: ${safeErrorName(error)}`);
      await interaction.editReply(buildCommitCardPayload("Could not complete the commit workflow. Check the conversation and gateway logs before retrying.", { notifyType: "error" })).catch(() => undefined);
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

      const selectedValue = interaction.options?.getString(setting === "model" ? "model" : "level");
      if (selectedValue !== null && selectedValue !== undefined) {
        const selected = setting === "model"
          ? options.find((option) => `${option?.provider}/${option?.id}` === selectedValue)
          : options.find((option) => option === selectedValue);
        if (selected === undefined) {
          await interaction.editReply(`That ${setting === "model" ? "model" : "thinking level"} is not available to this Pi session.`);
          return;
        }

        const label = setting === "model"
          ? `${selected.provider}/${selected.id}`
          : String(selected);
        void lifecycle.trackTask(sessions.enqueue(sessionKey, async () => {
          if (lifecycle.isStopping()) throw new Error("The gateway is restarting or stopping");
          if (session.closed || sessions.peek(sessionKey) !== session) {
            throw new Error("The conversation session is no longer active");
          }
          if (session.running) throw new Error("This conversation is currently generating a response");
          const result = setting === "model"
            ? await session.request("set_model", { provider: selected.provider, modelId: selected.id })
            : await session.request("set_thinking_level", { level: selected });
          if (!result.success) throw new Error(result.error || "Pi rejected the setting");
        }).then(async () => {
          await interaction.editReply({
            content: `This conversation will use ${setting === "model" ? "model" : "thinking level"} **${label}**.`,
            allowedMentions: { parse: [] },
          });
        }).catch(async (error) => {
          log(`Discord /${setting} selection failed: ${safeErrorName(error)}`);
          await interaction.editReply(`Could not apply that ${setting} setting. Run the command again and choose an available option.`).catch(() => undefined);
        }));
        return;
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

  return { registerSlashCommands, handleAutocomplete, handleChatInputCommand, handleConversationSettingInteraction, close, cancelSession };
}

function buildModelAutocompleteChoices(models, query) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  return models
    .map((model, index) => {
      if (typeof model?.provider !== "string" || typeof model?.id !== "string") return undefined;
      const value = `${model.provider}/${model.id}`;
      if (value.length > 100 || seen.has(value)) return undefined;
      seen.add(value);
      const modelName = typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
      const searchText = `${modelName} ${value}`.toLowerCase();
      const score = autocompleteMatchScore(query, searchText);
      if (score === undefined) return undefined;
      const label = modelName === model.id ? value : `${value} — ${modelName}`;
      return {
        choice: { name: discordOptionLabel(label), value },
        score,
        index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, 25)
    .map((item) => item.choice);
}

function buildThinkingAutocompleteChoices(levels, query) {
  if (!Array.isArray(levels)) return [];
  return levels
    .filter((level) => typeof level === "string" && level.length <= 100)
    .map((level, index) => ({
      choice: { name: discordOptionLabel(level), value: level },
      score: autocompleteMatchScore(query, level.toLowerCase()),
      index,
    }))
    .filter((item) => item.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, 25)
    .map((item) => item.choice);
}

function autocompleteMatchScore(query, searchableText) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return 0;
  const terms = normalized.split(/\s+/);
  if (!terms.every((term) => searchableText.includes(term))) return undefined;
  if (searchableText.startsWith(normalized)) return 0;
  if (searchableText.includes(normalized)) return 1;
  return 2;
}
