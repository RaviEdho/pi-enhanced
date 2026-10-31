import {
  getDiscordImageAttachments, hasDiscordReply, loadDiscordImages, loadDiscordReplyContext,
  sendText, startTyping, stripBotMention,
} from "./messages.mjs";
import { getThreadSessionKey, makeThreadName } from "./threads.mjs";
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
      return {
        kind: "thread", parentChannelId: registration.parentChannelId,
        sessionKey: getThreadSessionKey(message.channelId, registration),
      };
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
      await sendText(message.channel, "The gateway is restarting after the current work finishes. Please send this again once the bot reconnects.", message.id);
      return;
    }
    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 3000) seenMessages.delete(seenMessages.values().next().value);

    const imageAttachments = getDiscordImageAttachments(message);
    const isReply = hasDiscordReply(message);
    if (!content && imageAttachments.length === 0 && !isReply) {
      const hasAttachments = (message.attachments?.size || 0) > 0;
      await sendText(message.channel, hasAttachments
        ? "I can read text and PNG, JPEG, GIF, or WebP image attachments. This message has no supported image or text."
        : "Please send a text message or attach an image.", message.id);
      return;
    }
    let target = message.channel;
    let sessionKey;
    let conversationLabel;
    if (route.kind === "dm") {
      sessionKey = `dm:${message.channelId}:${message.author.id}`;
      conversationLabel = `DM with ${message.author.username}`;
    } else if (route.kind === "thread") {
      sessionKey = route.sessionKey;
      conversationLabel = `Discord thread ${message.channelId}`;
    } else {
      try {
        const thread = await message.startThread({ name: makeThreadName(message.author.username, content), autoArchiveDuration: 1440 });
        const registration = {
          parentChannelId: message.channelId,
          createdByUserId: message.author.id,
          createdAt: new Date().toISOString(),
        };
        threads.register(thread.id, registration);
        target = thread;
        sessionKey = getThreadSessionKey(thread.id, registration);
        conversationLabel = `Discord thread ${thread.id}`;
        log(`Created thread ${thread.id} in allowlisted channel ${message.channelId}`);
      } catch (error) {
        log(`Could not create Discord thread: ${summarizeDiscordError(error)}`);
        await sendText(message.channel, "I couldn't start a conversation thread. Check that the bot can create public threads and send messages in threads.", message.id);
        return;
      }
    }
    const queuedRun = sessions.enqueue(sessionKey, async () => {
      const typing = startTyping(target);
      try {
        const result = await sessions.withRunSlot(async () => {
          const replyContext = await loadDiscordReplyContext(message);
          const { images, skippedCount } = await loadDiscordImages(imageAttachments);
          if (!content && images.length === 0 && !isReply) {
            await sendText(target, "I couldn't load any attached images. Try PNG, JPEG, GIF, or WebP images under 10 MB each.", message.id);
            return undefined;
          }
          const messageContent = content || (isReply
            ? "Please respond to the message I am replying to."
            : "Please inspect the attached image(s) and describe what you see.");
          const imageNote = skippedCount > 0
            ? `\n\n[Gateway note: ${skippedCount} image attachment(s) could not be included. Analyze only the images attached to this prompt.]`
            : "";
          const prompt = `Discord message from ${message.author.username} (user ID ${message.author.id}) in ${conversationLabel}:\n\n${messageContent}${imageNote}${replyContext}`;
          const session = await sessions.get(sessionKey);
          // Observe background title generation during the run, not just after it.
          threads.watchThreadTitle(target, session);
          const result = await session.promptAndWait(prompt, {
            channel: target, userId: message.author.id, channelId: target.id, replyToMessageId: message.id, typing,
          }, images);
          // Retry if the early watch expired before the title became available.
          threads.watchThreadTitle(target, session);
          return session.forceStopped ? "The agent run was cancelled." : result;
        });
        if (result === undefined) return;
        if (result.trim()) await sendText(target, result, message.id);
        else await sendText(target, "The agent finished without a text response.", message.id);
      } catch (error) {
        log(`Pi run failed: ${safeErrorName(error)}`);
        await sendText(target, "The agent couldn't complete that request. Check the gateway logs and your Pi model/provider configuration.", message.id);
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
