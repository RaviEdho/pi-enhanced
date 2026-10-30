import { randomUUID } from "node:crypto";
import { buildDiscordUiPayload, buildDiscordUiModal } from "./components.mjs";
import { sendText, splitMessage, truncateDiscordText } from "./messages.mjs";
import { SessionUi, queueAskUserMessageEdit } from "./session-ui.mjs";

const UI_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Owns pending prompts and their Discord interaction tokens. */
export function createInteractionManager() {
  const pendingUiAnswers = new Map();
  const pendingDiscordUi = new Map();

  function waitForDiscordAnswer(key, channel, promptText, parseAnswer, timeoutMs, session, uiRequest) {
    return new Promise((resolve) => {
      const existing = pendingUiAnswers.get(key);
      if (existing) existing.finish(undefined);
      const token = randomUUID();
      const commitView = uiRequest.isCommit ? session.beginCommitView() : undefined;
      let finished = false;
      const pending = {
        token, key, session, channel,
        commitView,
        commitEpoch: session.commitEpoch,
        method: uiRequest.method,
        request: uiRequest.request,
        options: uiRequest.options,
        isAskUser: uiRequest.isAskUser,
        isAskUserReview: uiRequest.isAskUserReview,
        isAskUserQuestion: uiRequest.isAskUserQuestion,
        isCommit: uiRequest.isCommit,
        commitProposal: uiRequest.commitProposal,
        workspace: uiRequest.workspace,
        cardPages: uiRequest.isCommit ? splitMessage(uiRequest.commitProposal || promptText) : undefined,
        cardPage: 0,
        userId: session.interaction?.userId,
        channelId: session.interaction?.channelId,
        promptText: uiRequest.isCommit ? promptText : truncateDiscordText(promptText, 1800),
        promptMessage: undefined,
        promptMessagePromise: undefined,
        completionStatus: undefined,
        result: undefined,
        page: 0,
        completing: false,
        isActive() { return !finished && !pending.completing; },
        parse(answer) {
          return finished || pending.completing || (pending.isCommit && !session.isCurrentCommitView(pending.commitView, pending.commitEpoch))
            ? { done: false } : parseAnswer(String(answer ?? ""));
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
          if (session.cancelCommitPrompt === pending.cancel) session.cancelCommitPrompt = undefined;
          const deferAskUserCompletion = pending.isAskUser && value !== undefined;
          if (deferAskUserCompletion) session.pendingAskUserCompletion = { pending, value };
          if (value === undefined && session.askUserMessage === pending.promptMessage) session.askUserMessage = undefined;
          resolve(value);
          if (updatePrompt && pending.promptMessage) {
            const payload = deferAskUserCompletion
              ? buildDiscordUiPayload(pending, undefined, undefined, true)
              : buildDiscordUiPayload(pending, pending.completionStatus);
            const edit = editPendingMessage(pending, payload);
            void edit.catch(() => undefined);
          }
        },
      };
      const timer = setTimeout(() => pending.finish(undefined, { statusText: "This prompt expired." }), timeoutMs);
      timer.unref?.();
      pendingUiAnswers.set(key, pending);
      pendingDiscordUi.set(token, pending);
      if (pending.isCommit) {
        pending.cancel = () => pending.finish(undefined, { updatePrompt: false });
        session.cancelCommitPrompt = pending.cancel;
      }

      const payload = buildDiscordUiPayload(pending);
      const reusableMessage = uiRequest.isAskUser ? session.askUserMessage : undefined;
      const postPrompt = async () => {
        if (pending.isCommit) return session.editCommitMessage(channel, payload, pending.commitView, pending.commitEpoch);
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
        if (!message) {
          pending.finish(undefined, { updatePrompt: false });
          return;
        }
        pending.promptMessage = message;
        if (uiRequest.isAskUser && (!finished || pending.result !== undefined)) session.askUserMessage = message;
        if (finished) {
          if (pending.result === undefined && session.askUserMessage === message) session.askUserMessage = undefined;
          const completedPayload = pending.isAskUser && pending.result !== undefined
            ? buildDiscordUiPayload(pending, undefined, undefined, true)
            : buildDiscordUiPayload(pending, pending.completionStatus);
          const edit = editPendingMessage(pending, completedPayload);
          void edit.catch(() => undefined);
        }
      }).catch(() => pending.finish(undefined));
    });
  }

  async function showCommitNotice(session, channel, text, notifyType) {
    let active = true;
    const pending = {
      token: randomUUID(), session, channel,
      isCommit: true, readOnly: true, method: "notice", options: [],
      isActive: () => active,
      commitView: session.beginCommitView(), commitEpoch: session.commitEpoch,
      cardPages: splitMessage(text), cardPage: 0,
      workspace: session.session.cwd, notifyType,
      userId: session.interaction?.userId, channelId: channel.id,
      request: { title: "Git commit" },
    };
    let timer;
    const dispose = () => {
      active = false;
      clearTimeout(timer);
      pendingDiscordUi.delete(pending.token);
      if (session.cancelCommitNotice === dispose) session.cancelCommitNotice = undefined;
    };
    pending.finish = () => {
      if (!active) return;
      dispose();
      void editPendingMessage(pending, buildDiscordUiPayload(pending, "Page controls expired or closed.")).catch(() => undefined);
    };
    if (pending.cardPages.length > 1) {
      pendingDiscordUi.set(pending.token, pending);
      session.cancelCommitNotice = dispose;
      timer = setTimeout(pending.finish, UI_DEFAULT_TIMEOUT_MS);
      timer.unref?.();
    }
    try {
      return await editPendingMessage(pending, buildDiscordUiPayload(pending));
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async function handleInteraction(interaction) {
    const customId = interaction?.customId;
    if (typeof customId !== "string" || !customId.startsWith("piui:")) return;
    const [, token, action] = customId.split(":");
    const pending = pendingDiscordUi.get(token);
    if (!pending || pending.completing || (pending.isCommit && !pending.session.isCurrentCommitView(pending.commitView, pending.commitEpoch))) {
      await replyEphemeral(interaction, "This prompt is no longer active.");
      return;
    }
    if (interaction.user?.id !== pending.userId || interaction.channelId !== pending.channelId) {
      await replyEphemeral(interaction, "This prompt belongs to a different user or channel.");
      return;
    }
    if (interaction.isButton?.() && action === "open" && ["input", "editor"].includes(pending.method)) {
      if (pending.isCommit && (pending.request.prefill?.length || 0) > 4000) {
        await replyEphemeral(interaction, "This plan is too long for Discord's editor. Dismiss and rerun /commit with a narrower scope.");
        return;
      }
      await interaction.showModal(buildDiscordUiModal(pending));
      return;
    }
    if (interaction.isButton?.() && pending.isCommit && ["card-prev", "card-next"].includes(action)) {
      pending.cardPage = action === "card-prev"
        ? Math.max(0, pending.cardPage - 1)
        : Math.min(pending.cardPages.length - 1, pending.cardPage + 1);
      await updatePendingInteraction(pending, interaction, buildDiscordUiPayload(pending), true);
      return;
    }
    if (pending.readOnly) {
      await replyEphemeral(interaction, "This is a read-only commit status card.");
      return;
    }
    if (interaction.isButton?.() && pending.isCommit && pending.method === "select" && /^choose-\d+$/.test(action)) {
      const selected = pending.options[Number(action.slice(7))];
      if (selected === undefined) {
        await replyEphemeral(interaction, "That action is no longer available.");
        return;
      }
      await completeDiscordUiInteraction(pending, interaction, selected);
      return;
    }
    if (interaction.isButton?.() && pending.isAskUserReview && ["review-submit", "review-edit"].includes(action)) {
      await completeDiscordUiInteraction(pending, interaction, action === "review-submit" ? "Submit response" : "Edit answer");
      return;
    }
    if (interaction.isButton?.() && ["prev", "next"].includes(action) && pending.method === "select") {
      const pageCount = Math.ceil(pending.options.length / 25);
      pending.page = action === "prev" ? Math.max(0, pending.page - 1) : Math.min(pageCount - 1, pending.page + 1);
      await updatePendingInteraction(pending, interaction, buildDiscordUiPayload(pending), true);
      return;
    }
    if (interaction.isButton?.() && action === "cancel") {
      if (!pending.claim()) {
        await replyEphemeral(interaction, "This prompt is no longer active.");
        return;
      }
      try {
        await updatePendingInteraction(pending, interaction, buildDiscordUiPayload(pending, "Prompt dismissed."));
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
    for (const pending of [...pendingDiscordUi.values()]) {
      if (pending.session === session) pending.finish(undefined);
    }
  }

  return {
    createSessionUi(session) { return new SessionUi(session, { waitForDiscordAnswer, cancelSession, showCommitNotice }); },
    handleInteraction,
    acceptReply(key, content) {
      const pending = pendingUiAnswers.get(key);
      if (!pending) return false;
      pending.accept(content);
      return true;
    },
    close() {
      for (const pending of [...pendingDiscordUi.values()]) pending.finish(undefined);
    },
  };
}

function editPendingMessage(pending, payload, activeOnly = false) {
  if (pending.isCommit) {
    return pending.session.editCommitMessage(pending.channel, payload, pending.commitView, pending.commitEpoch,
      activeOnly ? () => pending.isActive() : undefined);
  }
  return pending.isAskUser
    ? queueAskUserMessageEdit(pending.session, pending.promptMessage, payload)
    : pending.promptMessage.edit(payload);
}

async function updatePendingInteraction(pending, interaction, payload, activeOnly = false) {
  if (pending.isCommit) {
    // Reserve edit order before Discord's acknowledgement can resolve out of
    // order. Pagination also rechecks activity inside the queue so expiry or
    // completion cannot be followed by stale controls being restored.
    const update = editPendingMessage(pending, payload, activeOnly);
    void update.catch(() => undefined);
    await interaction.deferUpdate();
    return update;
  }
  return interaction.update(payload);
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
    await updatePendingInteraction(pending, interaction, payload);
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
