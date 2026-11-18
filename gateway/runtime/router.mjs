import { existsSync } from "node:fs";
import {
  fetchRecentContextMessages, formatDiscordEmbedContext, getDiscordImageAttachments, hasDiscordReply, loadDiscordImages, loadDiscordReplyContext, loadRecentContext,
  sendText, startTyping, stripBotMention,
} from "./messages.mjs";
import { sendAgentReply } from "./agent-replies.mjs";
import { getThreadSessionKey, makeThreadName } from "./threads.mjs";
import { log, safeErrorName, summarizeDiscordError } from "./logging.mjs";
import { getChannelSessionKey, trackChannelReplies } from "./channel-sessions.mjs";
import { DECISION_TIMEOUT_MS } from "./route-decider.mjs";
export { getChannelSessionKey } from "./channel-sessions.mjs";

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

export function usesEscalatingTool(toolNames) {
  if (!toolNames) return false;
  for (const name of toolNames) {
    if (ESCALATING_TOOLS.has(name)) return true;
  }
  return false;
}

function contextCount(setting) {
  return Number.isInteger(setting) ? Math.min(Math.max(setting, 0), CONTEXT_MESSAGE_LIMIT) : DEFAULT_CONTEXT_MESSAGES;
}

/** Authorization and Discord-to-Pi conversation routing. */
export function createMessageRouter({ client, config, allowedUsers, allowedChannels, threads, sessions, interactions, lifecycle, routeDecider, channelSessions }) {
  const seenMessages = new Set();
  const lastChannelReplyAt = new Map();
  const lastDeliveredMessage = new Map();

  function classifyMessage(message) {
    if (message.guildId == null) return config.allowDirectMessages !== false ? { kind: "dm" } : undefined;
    if (config.allowServerMessages === false) return undefined;
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

  function rememberChannelReply(sessionKey, userId) {
    const key = `${sessionKey}:${userId}`;
    lastChannelReplyAt.delete(key);
    lastChannelReplyAt.set(key, Date.now());
    while (lastChannelReplyAt.size > CHANNEL_REPLY_MEMORY) lastChannelReplyAt.delete(lastChannelReplyAt.keys().next().value);
  }

  /** Consume a pending follow-up so one topic escalates at most once. */
  function continuePreviousChannelReply(sessionKey, userId) {
    const key = `${sessionKey}:${userId}`;
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

  async function chooseConversationTarget({ message, content, embedContext, imageAttachments, isReply, loadContext, defaultSessionKey, startedAt, turnConfig, escalateFollowUps }) {
    const mode = turnConfig.channelReplies?.mode;
    if (mode !== "auto") {
      return { target: mode === "channel" ? "channel" : "thread", reason: "mode" };
    }
    if (escalateFollowUps && continuePreviousChannelReply(defaultSessionKey, message.author.id)) {
      return { target: "thread", reason: "follow-up" };
    }
    if (!routeDecider) return { target: "thread", reason: "router-unavailable" };
    const decision = await routeDecider.decide({
      content,
      embedContext,
      author: message.author.username,
      isReply,
      imageCount: imageAttachments.length,
      loadContext, startedAt, routingConfig: turnConfig,
    });
    return { target: decision.target === "channel" ? "channel" : "thread", reason: decision.reason };
  }

  /** Move an over-deep channel reply into a thread, carrying its conversation history. */
  async function escalateToThread({ message, content, session, titleStarter }) {
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
      // Queue initialization before yielding to Discord sends: an immediate
      // participant reply must not name the fork from inherited channel history.
      const key = getThreadSessionKey(thread.id, registration);
      await sessions.enqueue(key, () => sessions.withRunSlot(async () => {
        const threadSession = await sessions.get(key);
        await threads.initializeThreadTitle(thread, threadSession, titleStarter);
        threads.watchThreadTitle(thread, threadSession);
      }));
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
    // Keep pending answers usable during restart drain, but an old session's
    // prompt must not intercept mentions/replies belonging to another session.
    let answerScope;
    let answerKey;
    if (route.kind === "new-thread" && channelSessions) {
      const reply = hasDiscordReply(message);
      answerKey = reply
        ? channelSessions.replySession(message.guildId, message.channelId, message.reference.messageId)
        : channelSessions.peekCurrent(message.guildId, message.channelId);
      answerScope = {
        session: answerKey ? sessions.peek(answerKey) : undefined,
        ...(reply ? { replyToMessageId: message.reference.messageId } : {}),
      };
    }
    if (interactions.acceptReply(`${message.channelId}:${message.author.id}`, content, answerScope)) {
      if (answerKey) channelSessions.begin(message.guildId, message.channelId, answerKey)();
      return;
    }
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
    const acceptedAt = Date.now();
    // A save replaces nested settings rather than mutating them. Keep this
    // turn's routing/context/output choices together, even while queued.
    const turnConfig = { ...config };
    const run = () => prepareRun(message, route, content, imageAttachments, isReply, contextBeforeId, acceptedAt, turnConfig);
    // Serialize target selection, not agent execution. Concurrent classifier
    // reads must not assign later mentions before earlier activity is recorded.
    if (route.kind === "new-thread") {
      await sessions.enqueue(`${getChannelSessionKey(message.guildId, message.channelId)}:routing`, run);
    } else {
      await run();
    }
  }

  async function prepareRun(message, route, content, imageAttachments, isReply, contextBeforeId, acceptedAt, turnConfig) {
    const startedAt = Date.now();
    const channelReplies = turnConfig.channelReplies ?? {};
    const decidePerMessage = channelReplies.mode === "auto";
    const escalateChannelReplies = channelReplies.escalate !== false;
    // Separate switch: a repeated mention is a weaker signal than real tool work.
    const escalateFollowUps = escalateChannelReplies && channelReplies.followUp !== false;
    const contextMessageCount = contextCount(turnConfig.contextMessages);
    const routingContextMessageCount = contextCount(channelReplies.contextMessages);
    const embedContext = formatDiscordEmbedContext(message);
    // Lazily read only after authorization. Routing and the queued agent turn
    // share the same snapshot, but format independent windows/watermarks.
    let replyContextPromise;
    let repliedMessage;
    let recentMessagesPromise;
    const getReplyContext = () => replyContextPromise ??= loadDiscordReplyContext(message, {
      onResolved: (referenced) => { repliedMessage = referenced; },
    });
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
    const defaultSessionKey = route.kind === "new-thread"
      ? channelSessions?.current(message.guildId, message.channelId, acceptedAt, turnConfig.channelSessions) ?? getChannelSessionKey(message.guildId, message.channelId)
      : undefined;
    let linkedSessionKey;
    let missingSessionNotice;
    if (route.kind === "new-thread" && isReply && channelSessions) {
      linkedSessionKey = channelSessions.replySession(message.guildId, message.channelId, message.reference.messageId);
      if (linkedSessionKey && !sessions.canResume(linkedSessionKey)) {
        linkedSessionKey = channelSessions.standalone(message.guildId, message.channelId);
        missingSessionNotice = "The original conversation is unavailable. Starting a separate fresh session using the quoted message; the channel's default conversation is unchanged.";
      } else if (!linkedSessionKey) {
        // Discord usually supplies the reply author's identity in the event.
        // Fall back to the memoized quote read only when that metadata is absent;
        // session selection and classification still share the six-second budget.
        let authorId = message.mentions?.repliedUser?.id
          ?? message.channel.messages?.cache?.get(message.reference.messageId)?.author?.id;
        if (!authorId) {
          let timer;
          try {
            await Promise.race([getReplyContext(), new Promise((resolve) => {
              timer = setTimeout(resolve, Math.max(0, DECISION_TIMEOUT_MS - (Date.now() - startedAt)));
              timer.unref?.();
            })]);
          } finally { clearTimeout(timer); }
          authorId = repliedMessage?.author?.id;
        }
        if (authorId === client.user?.id) {
          linkedSessionKey = channelSessions.standalone(message.guildId, message.channelId);
          missingSessionNotice = "This bot message has no saved conversation link (it may predate reply tracking). Starting a separate fresh session using the quoted message; the channel's default conversation is unchanged.";
        }
      }
    }
    let target = message.channel;
    let sessionKey;
    let conversationLabel;
    let replyToMessageId = message.id;
    let channelConversation = false;
    let forkSourceKey;
    if (route.kind === "dm") {
      sessionKey = `dm:${message.channelId}:${message.author.id}`;
      conversationLabel = `DM with ${message.author.username}`;
    } else if (route.kind === "thread") {
      sessionKey = route.sessionKey;
      conversationLabel = `Discord thread ${message.channelId}`;
    } else {
      // An explicit bot reply has stronger affinity than classifier/follow-up
      // routing, including when the saved mode would normally start a thread.
      const decision = linkedSessionKey ? { target: "channel", reason: "reply-session" }
        : await chooseConversationTarget({ message, content, embedContext, imageAttachments, isReply, loadContext: loadRoutingContext, defaultSessionKey, startedAt, turnConfig, escalateFollowUps });
      if (decision.target === "channel" || typeof message.startThread !== "function") {
        if (decision.target !== "channel") log(`Cannot start a thread in channel ${message.channelId}; replying in the channel instead`);
        sessionKey = linkedSessionKey ?? defaultSessionKey;
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
          forkSourceKey = defaultSessionKey;
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
    const onMessageSent = channelConversation && channelSessions
      ? (sent) => {
        try { channelSessions.rememberReply(message.guildId, message.channelId, sessionKey, sent); }
        catch (error) { log(`Could not save channel reply affinity: ${safeErrorName(error)}`); }
      }
      : undefined;
    if (onMessageSent) target = trackChannelReplies(target, onMessageSent);
    const finishChannelRun = channelConversation
      ? channelSessions?.begin(message.guildId, message.channelId, sessionKey, acceptedAt) ?? (() => {})
      : () => {};
    // The thread starter belongs to the parent channel, so it cannot be a reply target inside the new thread.
    // Explicit replies deliberately revisit the target's older context, even
    // if the agent has already seen newer messages in this conversation.
    const watermark = isReply ? { afterId: undefined, skip: false } : contextWatermark(sessionKey, message.channel.id);
    rememberDelivered(sessionKey, message.channel.id, message.id);
    const queuedRun = sessions.enqueue(sessionKey, async () => {
      const typing = startTyping(target);
      try {
        if (missingSessionNotice) await sendText(target, missingSessionNotice, replyToMessageId);
        if (forkSourceKey) {
          // Wait for earlier channel turns, and hold its queue until Pi has
          // copied the source. Never hold a run slot while waiting on that queue.
          await sessions.enqueue(forkSourceKey, async () => {
            const source = sessions.getForkSource(forkSourceKey);
            if (!source) return;
            sessions.seed(sessionKey, source);
            await sessions.withRunSlot(() => sessions.get(sessionKey));
          });
        }
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
          // Initialize before the first user turn so inherited titles/old user
          // messages cannot win the automatic-title race in a forked session.
          if (route.kind === "new-thread" && !channelConversation) {
            await threads.initializeThreadTitle(target, session, `${messageContent}${embedContext}${replyContext}${recentContext}`);
          }
          // Observe background title generation during the run, not just after it.
          if (!channelConversation) threads.watchThreadTitle(target, session);
          const result = await session.promptAndWait(prompt, {
            channel: target, userId: message.author.id, channelId: target.id, replyToMessageId, typing, onMessageSent,
            allowNoReply: route.kind === "thread",
            historyScope: route.kind === "dm" ? { kind: "dm", channelId: message.channelId, userId: message.author.id } : { kind: "thread", guildId: message.guildId, parentChannelId: route.kind === "thread" ? route.parentChannelId : message.channelId },
          }, images, { turnConfig });
          if (!session.forceStopped && result?.disposition === "no_reply") return undefined;
          // Retry if the early watch expired before the title became available.
          if (!channelConversation) threads.watchThreadTitle(target, session);
          return {
            text: session.forceStopped ? "The agent run was cancelled." : result,
            escalate: channelConversation && decidePerMessage && escalateChannelReplies && usesEscalatingTool(session.lastRunTools),
            session,
            titleStarter: `${messageContent}${embedContext}${replyContext}${recentContext}`,
          };
        });
        if (!result) return;
        if (result.text === undefined) return;
        if (result.text.trim()) await sendAgentReply(target, result.text, replyToMessageId, { tableRendering: turnConfig.tableRendering });
        else await sendText(target, "The agent finished without a text response.", replyToMessageId);
        if (channelConversation && escalateFollowUps) rememberChannelReply(sessionKey, message.author.id);
        if (result.escalate) await escalateToThread({ message, content, session: result.session, titleStarter: result.titleStarter });
      } catch (error) {
        log(`Pi run failed: ${safeErrorName(error)}`);
        await sendText(target, "The agent couldn't complete that request. Check the gateway logs and your Pi model/provider configuration.", replyToMessageId);
      } finally {
        typing.stop();
      }
    }).finally(finishChannelRun);
    void lifecycle.trackTask(queuedRun.catch((error) => {
      log(`Queued Pi run failed: ${safeErrorName(error)}`);
    }));
  }

  return { handleMessage, classifyMessage };
}
