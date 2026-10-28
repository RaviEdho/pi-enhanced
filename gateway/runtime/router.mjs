import {
  getDiscordImageAttachments, loadDiscordImages, sendText, startTyping, stripBotMention,
} from "./messages.mjs";
import { makeThreadName } from "./threads.mjs";
import { log, safeErrorName, summarizeDiscordError } from "./logging.mjs";

/** Authorization and Discord-to-Pi conversation routing. */
export function createMessageRouter({ client, config, allowedUsers, allowedChannels, threads, sessions, interactions, lifecycle }) {
  const seenMessages = new Set();
  const allowDirectMessages = config.allowDirectMessages !== false;
  const allowServerMessages = config.allowServerMessages !== false;

  function classifyMessage(message) {
    if (message.guildId == null) return allowDirectMessages ? { kind: "dm" } : undefined;
    if (!allowServerMessages) return undefined;
    const channel = message.channel;
    if (typeof channel?.isThread === "function" && channel.isThread()) {
      const registration = threads.get(message.channelId);
      if (!registration || (!allowedChannels.has("*") && !allowedChannels.has(registration.parentChannelId))) return undefined;
      return { kind: "thread", parentChannelId: registration.parentChannelId };
    }
    if (!allowedChannels.has("*") && !allowedChannels.has(message.channelId)) return undefined;
    if (!client.user || !message.mentions?.users?.has(client.user.id)) return undefined;
    if (typeof message.startThread !== "function") return undefined;
    return { kind: "new-thread" };
  }

  async function handleMessage(message) {
    if (lifecycle.isShuttingDown() || message.author?.bot || !message.author?.id || (!allowedUsers.has("*") && !allowedUsers.has(message.author.id))) return;
    const route = classifyMessage(message);
    if (!route) return;
    lifecycle.recordEvent();
    const content = stripBotMention(message.content || "", client.user?.id);
    if (interactions.acceptReply(`${message.channelId}:${message.author.id}`, content)) return;
    if (lifecycle.isStopping()) {
      await sendText(message.channel, "The gateway is restarting after the current work finishes. Please send this again once the bot reconnects.");
      return;
    }
    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 3000) seenMessages.delete(seenMessages.values().next().value);

    const imageAttachments = getDiscordImageAttachments(message);
    if (!content && imageAttachments.length === 0) {
      const hasAttachments = (message.attachments?.size || 0) > 0;
      await sendText(message.channel, hasAttachments
        ? "I can read text and PNG, JPEG, GIF, or WebP image attachments. This message has no supported image or text."
        : "Please send a text message or attach an image.");
      return;
    }
    let target = message.channel;
    let sessionKey;
    let conversationLabel;
    if (route.kind === "dm") {
      sessionKey = `dm:${message.channelId}:${message.author.id}`;
      conversationLabel = `DM with ${message.author.username}`;
    } else if (route.kind === "thread") {
      sessionKey = `guild:${route.parentChannelId}:thread:${message.channelId}:user:${message.author.id}`;
      conversationLabel = `Discord thread ${message.channelId}`;
    } else {
      try {
        const thread = await message.startThread({ name: makeThreadName(message.author.username, content), autoArchiveDuration: 1440 });
        threads.register(thread.id, {
          parentChannelId: message.channelId,
          createdByUserId: message.author.id,
          createdAt: new Date().toISOString(),
        });
        target = thread;
        sessionKey = `guild:${message.channelId}:thread:${thread.id}:user:${message.author.id}`;
        conversationLabel = `Discord thread ${thread.id}`;
        log(`Created thread ${thread.id} in allowlisted channel ${message.channelId}`);
      } catch (error) {
        log(`Could not create Discord thread: ${summarizeDiscordError(error)}`);
        await sendText(message.channel, "I couldn't start a conversation thread. Check that the bot can create public threads and send messages in threads.");
        return;
      }
    }
    const queuedRun = sessions.enqueue(sessionKey, async () => {
      const typing = startTyping(target);
      try {
        const result = await sessions.withRunSlot(async () => {
          const { images, skippedCount } = await loadDiscordImages(imageAttachments);
          if (!content && images.length === 0) {
            await sendText(target, "I couldn't load any attached images. Try PNG, JPEG, GIF, or WebP images under 10 MB each.");
            return undefined;
          }
          const messageContent = content || "Please inspect the attached image(s) and describe what you see.";
          const imageNote = skippedCount > 0
            ? `\n\n[Gateway note: ${skippedCount} image attachment(s) could not be included. Analyze only the images attached to this prompt.]`
            : "";
          const prompt = `Discord message from ${message.author.username} (user ID ${message.author.id}) in ${conversationLabel}:\n\n${messageContent}${imageNote}`;
          const session = await sessions.get(sessionKey);
          const result = await session.promptAndWait(prompt, {
            channel: target, userId: message.author.id, channelId: target.id, typing,
          }, images);
          threads.watchThreadTitle(target, session);
          return result;
        });
        if (result === undefined) return;
        if (result.trim()) await sendText(target, result);
        else await sendText(target, "The agent finished without a text response.");
      } catch (error) {
        log(`Pi run failed: ${safeErrorName(error)}`);
        await sendText(target, "The agent couldn't complete that request. Check the gateway logs and your Pi model/provider configuration.");
      } finally {
        typing.stop();
      }
    });
    void lifecycle.trackTask(queuedRun.catch((error) => {
      log(`Queued Pi run failed: ${safeErrorName(error)}`);
    }));
  }

  return { handleMessage, classifyMessage };
}
