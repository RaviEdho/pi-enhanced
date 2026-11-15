import { existsSync } from "node:fs";
import {
  fetchRecentContextMessages, formatDiscordEmbedContext, getDiscordImageAttachments, hasDiscordReply, loadDiscordImages, loadDiscordReplyContext, loadRecentContext,
  sendText, startTyping, stripBotMention,
} from "./messages.mjs";
import { sendAgentReply } from "./agent-replies.mjs";
import { getThreadSessionKey, makeThreadName } from "./threads.mjs";
import { log, safeErrorName, summarizeDiscordError } from "./logging.mjs";

/** Tools that mean a channel reply did real work, so the topic needs a thread. */
const ESCALATING_TOOLS = new Set([
  "bash", "discord_gateway_restart", "edit", "set_working_directory",
  "subagent", "subagent_status", "write",
]);
/** A second mention this soon after a channel reply continues the same topic. */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;
const CHANNEL_REPLY_MEMORY = 500;
const DELIVERED_MESSAGE_MEMORY = 2000;
const CONTEXT_MESSAGE_LIMIT = 25;
const DEFAULT_CONTEXT_MESSAGES = 5;

/** One shared session per channel, separate from every thread session. */
export function getChannelSessionKey(guildId, channelId) {
  return `guild:${guildId}:channel:${channelId}`;
}

export function usesEscalatingTool(toolNames) {
  if (!toolNames) return false;
  for (const name of toolNames) {
    if (ESCALATING_TOOLS.has(name)) return true;
  }
  return false;
}

/** Authorization and Discord-to-Pi conversation routing. */
export function createMessageRouter({ client, config, allowedUsers, allowedChannels, threads, sessions, interactions, lifecycle, routeDecider }) {
  const seenMessages = new Set();
  const allowDirectMessages = config.allowDirectMessages !== false;
  const allowServerMessages = config.allowServerMessages !== false;
  const channelReplies = config.channelReplies ?? { mode: "always-thread", escalate: true };
  const decidePerMessage = channelReplies.mode === "auto";
  const escalateChannelReplies = channelReplies.escalate !== false;
  // Separate switch: a repeated mention is a weaker signal than real tool work.
  const escalateFollowUps = escalateChannelReplies && channelReplies.followUp !== false;
  const lastChannelReplyAt = new Map();
  const lastDeliveredMessage = new Map();
  const contextMessageCount = Number.isInteger(config.contextMessages)
    ? Math.min(Math.max(config.contextMessages, 0), CONTEXT_MESSAGE_LIMIT)
    : DEFAULT_CONTEXT_MESSAGES;
  const routingContextMessageCount = Number.isInteger(channelReplies.contextMessages)
    ? Math.min(Math.max(channelReplies.contextMessages, 0), CONTEXT_MESSAGE_LIMIT)
    : DEFAULT_CONTEXT_MESSAGES;

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
    return { kind: "new-thread" };
  }

  function rememberChannelReply(channelId, userId) {
    if (!escalateFollowUps) return;
    const key = `${channelId}:${userId}`;
    lastChannelReplyAt.delete(key);
    lastChannelReplyAt.set(key, Date.now());
    while (lastChannelReplyAt.size > CHANNEL_REPLY_MEMORY) lastChannelReplyAt.delete(lastChannelReplyAt.keys().next().value);
  }

  /** Consume a pending follow-up so one topic escalates at most once. */
  function continuePreviousChannelReply(channelId, userId) {
    if (!escalateFollowUps) return false;
    const key = `${channelId}:${userId}`;
    const at = lastChannelReplyAt.get(key);
    if (at === undefined) return false;
    lastChannelReplyAt.delete(key);
    return Date.now() - at <= FOLLOW_UP_WINDOW_MS;
  }

  /** Remember the newest message already handed to this conversation's Pi session. */
  function rememberDelivered(sessionKey, channelId, messageId) {
    lastDeliveredMessage.delete(sessionKey);
    lastDeliveredMessage.set(sessionKey, { channelId, messageId });
    while (lastDeliveredMessage.size > DELIVERED_MESSAGE_MEMORY) {
      lastDeliveredMessage.delete(lastDeliveredMessage.keys().next().value);
    }
  }

  /**
   * Automatic context only fills gaps: messages newer than the last delivered
   * one. A watermark from another channel cannot order this channel, so the
   * conversation is treated as caught up instead of re-reading old messages.
   */
  function contextWatermark(sessionKey, channelId) {
    const last = lastDeliveredMessage.get(sessionKey);
    if (!last) return { afterId: undefined, skip: false };
    if (last.channelId !== channelId) return { afterId: undefined, skip: true };
    return { afterId: last.messageId, skip: false };
  }

  async function chooseConversationTarget({ message, content, embedContext, imageAttachments, isReply, loadContext }) {
    if (!decidePerMessage) {
      return { target: channelReplies.mode === "channel" ? "channel" : "thread", reason: "mode" };
    }
    if (escalateFollowUps && continuePreviousChannelReply(message.channelId, message.author.id)) {
      return { target: "thread", reason: "follow-up" };
    }
    if (!routeDecider) return { target: "thread", reason: "router-unavailable" };
    const decision = await routeDecider.decide({
      content,
      embedContext,
      author: message.author.username,
      isReply,
      imageCount: imageAttachments.length,
      loadContext,
    });
    return { target: decision.target === "channel" ? "channel" : "thread", reason: decision.reason };
  }

  /** Move an over-deep channel reply into a thread, carrying its conversation history. */
  async function escalateToThread({ message, content, session }) {
    if (typeof message.startThread !== "function") return;
    try {
      const thread = await message.startThread({ name: makeThreadName(message.author.username, content), autoArchiveDuration: 1440 });
      const registration = {
        parentChannelId: message.channelId,
        createdByUserId: message.author.id,
        createdAt: new Date().toISOString(),
      };
      threads.register(thread.id, registration);
      if (session?.sessionFile && existsSync(session.sessionFile)) {
        // The first thread turn forks the shared channel conversation, so the
        // agent keeps its context instead of restarting from scratch.
        sessions.seed(getThreadSessionKey(thread.id, registration), session.sessionFile);
      }
      log(`Escalated channel ${message.channelId} conversation into thread ${thread.id}`);
      await sendText(thread, `Continuing here so this work does not take over <#${message.channelId}>.`);
      await sendText(message.channel, `Moved this to <#${thread.id}>.`, message.id);
    } catch (error) {
      log(`Could not escalate to a thread: ${summarizeDiscordError(error)}`);
    }
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
    const contextBeforeId = isReply ? message.reference.messageId : message.id;
    if (!content && imageAttachments.length === 0 && !isReply) {
      const hasAttachments = (message.attachments?.size || 0) > 0;
      await sendText(message.channel, hasAttachments
        ? "I can read text and PNG, JPEG, GIF, or WebP image attachments. This message has no supported image or text."
        : "Please send a text message or attach an image.", message.id);
      return;
    }
    const embedContext = formatDiscordEmbedContext(message);
    // Lazily read only after authorization. Routing and the queued agent turn
    // share the same snapshot, but format independent windows/watermarks.
    let replyContextPromise;
    let recentMessagesPromise;
    const getReplyContext = () => replyContextPromise ??= loadDiscordReplyContext(message);
    const getRecentMessages = (routingCount = 0) => recentMessagesPromise ??= fetchRecentContextMessages(message.channel, {
      beforeId: contextBeforeId,
      limit: Math.max(contextMessageCount, routingCount),
    });
    const loadRoutingContext = async () => {
      const [replyContext, cachedMessages] = await Promise.all([
        getReplyContext(),
        routingContextMessageCount > 0 ? getRecentMessages(routingContextMessageCount) : [],
      ]);
      const recentContext = await loadRecentContext(message.channel, {
        beforeId: contextBeforeId,
        replyAnchored: isReply,
        limit: routingContextMessageCount,
        // The stateless router needs our replies to resolve follow-up references.
        // Omit botUserId here; the agent's context still filters our messages.
        cachedMessages,
      });
      return { replyContext, recentContext };
    };
    let target = message.channel;
    let sessionKey;
    let conversationLabel;
    let replyToMessageId = message.id;
    let channelConversation = false;
    if (route.kind === "dm") {
      sessionKey = `dm:${message.channelId}:${message.author.id}`;
      conversationLabel = `DM with ${message.author.username}`;
    } else if (route.kind === "thread") {
      sessionKey = route.sessionKey;
      conversationLabel = `Discord thread ${message.channelId}`;
    } else {
      const decision = await chooseConversationTarget({ message, content, embedContext, imageAttachments, isReply, loadContext: loadRoutingContext });
      if (decision.target === "channel" || typeof message.startThread !== "function") {
        if (decision.target !== "channel") log(`Cannot start a thread in channel ${message.channelId}; replying in the channel instead`);
        sessionKey = getChannelSessionKey(message.guildId, message.channelId);
        conversationLabel = `Discord channel ${message.channelId}`;
        channelConversation = true;
        log(`Replying in channel ${message.channelId} (${decision.reason})`);
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
          replyToMessageId = undefined;
          log(`Created thread ${thread.id} in allowlisted channel ${message.channelId} (${decision.reason})`);
        } catch (error) {
          log(`Could not create Discord thread: ${summarizeDiscordError(error)}`);
          await sendText(message.channel, "I couldn't start a conversation thread. Check that the bot can create public threads and send messages in threads.", message.id);
          return;
        }
      }
    }
    // The thread starter belongs to the parent channel, so it cannot be a reply target inside the new thread.
    // Explicit replies deliberately revisit the target's older context, even
    // if the agent has already seen newer messages in this conversation.
    const watermark = isReply ? { afterId: undefined, skip: false } : contextWatermark(sessionKey, message.channel.id);
    rememberDelivered(sessionKey, message.channel.id, message.id);
    const queuedRun = sessions.enqueue(sessionKey, async () => {
      const typing = startTyping(target);
      try {
        const result = await sessions.withRunSlot(async () => {
          const replyContext = await getReplyContext();
          const recentContext = contextMessageCount > 0 && !watermark.skip
            ? await loadRecentContext(message.channel, {
              beforeId: contextBeforeId,
              replyAnchored: isReply,
              afterId: watermark.afterId,
              limit: contextMessageCount,
              botUserId: client.user?.id,
              cachedMessages: await getRecentMessages(),
            })
            : "";
          const { images, skippedCount } = await loadDiscordImages(imageAttachments);
          if (!content && images.length === 0 && !isReply) {
            await sendText(target, "I couldn't load any attached images. Try PNG, JPEG, GIF, or WebP images under 10 MB each.", replyToMessageId);
            return undefined;
          }
          const messageContent = content || (isReply
            ? "Please respond to the message I am replying to."
            : "Please inspect the attached image(s) and describe what you see.");
          const imageNote = skippedCount > 0
            ? `\n\n[Gateway note: ${skippedCount} image attachment(s) could not be included. Analyze only the images attached to this prompt.]`
            : "";
          const prompt = `Discord message from ${message.author.username} (user ID ${message.author.id}) in ${conversationLabel}:\n\n${messageContent}${imageNote}${embedContext}${replyContext}${recentContext}`;
          const session = await sessions.get(sessionKey);
          // Observe background title generation during the run, not just after it.
          if (!channelConversation) threads.watchThreadTitle(target, session);
          const result = await session.promptAndWait(prompt, {
            channel: target, userId: message.author.id, channelId: target.id, replyToMessageId, typing,
            allowNoReply: route.kind === "thread",
            historyScope: route.kind === "dm" ? { kind: "dm", channelId: message.channelId, userId: message.author.id } : { kind: "thread", guildId: message.guildId, parentChannelId: route.kind === "thread" ? route.parentChannelId : message.channelId },
          }, images);
          if (!session.forceStopped && result?.disposition === "no_reply") return undefined;
          // Retry if the early watch expired before the title became available.
          if (!channelConversation) threads.watchThreadTitle(target, session);
          return {
            text: session.forceStopped ? "The agent run was cancelled." : result,
            escalate: channelConversation && decidePerMessage && escalateChannelReplies && usesEscalatingTool(session.lastRunTools),
            session,
          };
        });
        if (!result) return;
        if (result.text === undefined) return;
        if (result.text.trim()) await sendAgentReply(target, result.text, replyToMessageId, { tableRendering: config.tableRendering });
        else await sendText(target, "The agent finished without a text response.", replyToMessageId);
        if (channelConversation) rememberChannelReply(message.channelId, message.author.id);
        if (result.escalate) await escalateToThread({ message, content, session: result.session });
      } catch (error) {
        log(`Pi run failed: ${safeErrorName(error)}`);
        await sendText(target, "The agent couldn't complete that request. Check the gateway logs and your Pi model/provider configuration.", replyToMessageId);
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
