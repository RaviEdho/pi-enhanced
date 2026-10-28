import { randomUUID } from "node:crypto";
import { buildDiscordUiPayload, buildDiscordUiModal } from "./components.mjs";
import { sendText, truncateDiscordText } from "./messages.mjs";
import { SessionUi, queueAskUserMessageEdit } from "./session-ui.mjs";

/** Owns pending prompts and their Discord interaction tokens. */
export function createInteractionManager() {
  const pendingUiAnswers = new Map();
  const pendingDiscordUi = new Map();

  function waitForDiscordAnswer(key, channel, promptText, parseAnswer, timeoutMs, session, uiRequest) {
    return new Promise((resolve) => {
      const existing = pendingUiAnswers.get(key);
      if (existing) existing.finish(undefined);
      const token = randomUUID();
      let finished = false;
      const pending = {
        token, key, session,
        method: uiRequest.method,
        request: uiRequest.request,
        options: uiRequest.options,
        isAskUser: uiRequest.isAskUser,
        isAskUserReview: uiRequest.isAskUserReview,
        isAskUserQuestion: uiRequest.isAskUserQuestion,
        userId: session.interaction?.userId,
        channelId: session.interaction?.channelId,
        promptText: truncateDiscordText(promptText, 1800),
        promptMessage: undefined,
        promptMessagePromise: undefined,
        completionStatus: undefined,
        result: undefined,
        page: 0,
        completing: false,
        parse(answer) {
          return finished || pending.completing ? { done: false } : parseAnswer(String(answer ?? ""));
        },
        claim() {
          if (finished || pending.completing) return false;
          pending.completing = true;
          clearTimeout(timer);
          return true;
        },
        accept(answer) {
          if (finished || pending.completing) return false;
          const parsed = parseAnswer(String(answer ?? ""));
          if (!parsed.done) {
            void sendText(channel, "That response wasn't recognized. Please use the controls or reply with a valid answer.");
            return false;
          }
          pending.finish(parsed.value ?? parsed.confirmed);
          return true;
        },
        finish(value, { updatePrompt = true, statusText } = {}) {
          if (finished) return;
          finished = true;
          pending.result = value;
          pending.completionStatus = statusText || (value === undefined ? "Prompt dismissed or expired." : "Response received.");
          clearTimeout(timer);
          if (pendingUiAnswers.get(key) === pending) pendingUiAnswers.delete(key);
          if (pendingDiscordUi.get(token) === pending) pendingDiscordUi.delete(token);
          const deferAskUserCompletion = pending.isAskUser && value !== undefined;
          if (deferAskUserCompletion) session.pendingAskUserCompletion = { pending, value };
          if (value === undefined && session.askUserMessage === pending.promptMessage) session.askUserMessage = undefined;
          resolve(value);
          if (updatePrompt && pending.promptMessage) {
            const payload = deferAskUserCompletion
              ? buildDiscordUiPayload(pending, undefined, undefined, true)
              : buildDiscordUiPayload(pending, pending.completionStatus);
            const edit = pending.isAskUser
              ? queueAskUserMessageEdit(session, pending.promptMessage, payload)
              : pending.promptMessage.edit(payload);
            void edit.catch(() => undefined);
          }
        },
      };
      const timer = setTimeout(() => pending.finish(undefined, { statusText: "This prompt expired." }), timeoutMs);
      timer.unref?.();
      pendingUiAnswers.set(key, pending);
      pendingDiscordUi.set(token, pending);

      const payload = buildDiscordUiPayload(pending);
      const reusableMessage = uiRequest.isAskUser ? session.askUserMessage : undefined;
      const postPrompt = async () => {
        if (reusableMessage && reusableMessage.channelId === channel.id) {
          try {
            return await queueAskUserMessageEdit(session, reusableMessage, payload);
          } catch {
            if (session.askUserMessage === reusableMessage) session.askUserMessage = undefined;
          }
        }
        return channel.send(payload);
      };
      const promptMessagePromise = postPrompt();
      pending.promptMessagePromise = promptMessagePromise;
      void promptMessagePromise.then((message) => {
        pending.promptMessage = message;
        if (uiRequest.isAskUser && (!finished || pending.result !== undefined)) session.askUserMessage = message;
        if (finished) {
          if (pending.result === undefined && session.askUserMessage === message) session.askUserMessage = undefined;
          const completedPayload = pending.isAskUser && pending.result !== undefined
            ? buildDiscordUiPayload(pending, undefined, undefined, true)
            : buildDiscordUiPayload(pending, pending.completionStatus);
          const edit = pending.isAskUser
            ? queueAskUserMessageEdit(session, message, completedPayload)
            : message.edit(completedPayload);
          void edit.catch(() => undefined);
        }
      }).catch(() => pending.finish(undefined));
    });
  }

  async function handleInteraction(interaction) {
    const customId = interaction?.customId;
    if (typeof customId !== "string" || !customId.startsWith("piui:")) return;
    const [, token, action] = customId.split(":");
    const pending = pendingDiscordUi.get(token);
    if (!pending || pending.completing) {
      await replyEphemeral(interaction, "This prompt is no longer active.");
      return;
    }
    if (interaction.user?.id !== pending.userId || interaction.channelId !== pending.channelId) {
      await replyEphemeral(interaction, "This prompt belongs to a different user or channel.");
      return;
    }
    if (interaction.isButton?.() && action === "open" && ["input", "editor"].includes(pending.method)) {
      await interaction.showModal(buildDiscordUiModal(pending));
      return;
    }
    if (interaction.isButton?.() && pending.isAskUserReview && ["review-submit", "review-edit"].includes(action)) {
      await completeDiscordUiInteraction(pending, interaction, action === "review-submit" ? "Submit response" : "Edit answer");
      return;
    }
    if (interaction.isButton?.() && ["prev", "next"].includes(action) && pending.method === "select") {
      const pageCount = Math.ceil(pending.options.length / 25);
      pending.page = action === "prev" ? Math.max(0, pending.page - 1) : Math.min(pageCount - 1, pending.page + 1);
      await interaction.update(buildDiscordUiPayload(pending));
      return;
    }
    if (interaction.isButton?.() && action === "cancel") {
      if (!pending.claim()) {
        await replyEphemeral(interaction, "This prompt is no longer active.");
        return;
      }
      try {
        await interaction.update(buildDiscordUiPayload(pending, "Prompt dismissed."));
        pending.finish(undefined, { updatePrompt: false });
      } catch {
        pending.finish(undefined);
      }
      return;
    }
    if (interaction.isButton?.() && pending.method === "confirm" && ["yes", "no"].includes(action)) {
      await completeDiscordUiInteraction(pending, interaction, action === "yes" ? "yes" : "no");
      return;
    }
    if (interaction.isStringSelectMenu?.() && action === "select" && pending.method === "select") {
      const selectedIndex = Number(interaction.values?.[0]);
      const selected = Number.isInteger(selectedIndex) ? pending.options[selectedIndex] : undefined;
      if (selected === undefined) {
        await replyEphemeral(interaction, "That option is no longer available.");
        return;
      }
      await completeDiscordUiInteraction(pending, interaction, selected);
      return;
    }
    if (interaction.isModalSubmit?.() && action === "submit" && ["input", "editor"].includes(pending.method)) {
      if (!pending.claim()) {
        await replyEphemeral(interaction, "This prompt is no longer active.");
        return;
      }
      let value;
      try {
        value = interaction.fields.getTextInputValue("answer");
        await interaction.reply({ content: "Response recorded.", ephemeral: true, allowedMentions: { parse: [] } });
      } catch {
        // The interaction may have expired; resolve the pending prompt below.
      }
      pending.finish(value);
      return;
    }
    await replyEphemeral(interaction, "That control doesn't match this prompt.");
  }

  function cancelSession(session) {
    for (const pending of pendingUiAnswers.values()) {
      if (pending.session === session) pending.finish(undefined);
    }
  }

  return {
    createSessionUi(session) { return new SessionUi(session, { waitForDiscordAnswer, cancelSession }); },
    handleInteraction,
    acceptReply(key, content) {
      const pending = pendingUiAnswers.get(key);
      if (!pending) return false;
      pending.accept(content);
      return true;
    },
    close() {
      for (const pending of pendingUiAnswers.values()) pending.finish(undefined);
    },
  };
}

async function completeDiscordUiInteraction(pending, interaction, answer) {
  const parsed = pending.parse(answer);
  if (!parsed.done) {
    await replyEphemeral(interaction, "That response wasn't recognized. Please try again.");
    return;
  }
  if (!pending.claim()) {
    await replyEphemeral(interaction, "This prompt is no longer active.");
    return;
  }
  const value = parsed.value ?? parsed.confirmed;
  try {
    const payload = pending.isAskUser
      ? buildDiscordUiPayload(pending, undefined, undefined, true)
      : buildDiscordUiPayload(pending, "Response received.", value);
    await interaction.update(payload);
    pending.finish(value, { updatePrompt: false });
  } catch {
    pending.finish(value);
  }
}

export async function replyEphemeral(interaction, content) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch {
    // The interaction may have expired or already been acknowledged.
  }
}
