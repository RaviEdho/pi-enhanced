import { buildDiscordUiPayload } from "./components.mjs";
import { sendText, truncateDiscordText } from "./messages.mjs";

const UI_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function queueAskUserMessageEdit(session, message, payload) {
  const edit = (session.askUserMessageEditPromise || Promise.resolve())
    .catch(() => undefined)
    .then(() => message.edit(payload));
  session.askUserMessageEditPromise = edit.catch(() => undefined);
  return edit;
}

/** Discord UI state belonging to a single Pi session, separate from RPC transport. */
export class SessionUi {
  constructor(session, { waitForDiscordAnswer, cancelSession }) {
    this.session = session;
    this.waitForDiscordAnswer = waitForDiscordAnswer;
    this.cancelSession = cancelSession;
    this.pendingAskUserCompletion = undefined;
    this.statusMessages = new Map();
    this.statusUpdatePromise = Promise.resolve();
    this.statusEpoch = 0;
    this.closed = false;
    this.resetPrompt();
  }

  get interaction() { return this.session.interaction; }

  resetPrompt() {
    this.statusActive = !this.closed;
    this.askUserMessage = undefined;
    this.askUserMessageEditPromise = Promise.resolve();
  }

  sendUiResponse(id, response) {
    this.session.sendUiResponse(id, response);
  }

  async flushPendingAskUserCompletion() {
    const completion = this.pendingAskUserCompletion;
    if (!completion) return;
    this.pendingAskUserCompletion = undefined;
    let message = completion.pending.promptMessage || this.askUserMessage;
    if (!message && completion.pending.promptMessagePromise) {
      try {
        message = await completion.pending.promptMessagePromise;
      } catch {
        return;
      }
    }
    if (!message) return;
    const payload = buildDiscordUiPayload(completion.pending, completion.pending.completionStatus, completion.value);
    await queueAskUserMessageEdit(this, message, payload).catch(() => undefined);
  }

  async handleRequest(request) {
    if (this.closed) {
      this.sendUiResponse(request.id, { cancelled: true });
      return;
    }
    const interaction = this.interaction;
    const method = request.method;
    if (method === "notify") {
      if (interaction?.channel && request.message) await sendText(interaction.channel, String(request.message));
      return;
    }
    if (method === "setStatus" && request.statusKey === "pi-enhanced-working") {
      const epoch = this.statusEpoch;
      const update = this.statusUpdatePromise.then(() => this.updateStatusMessage(request, epoch));
      this.statusUpdatePromise = update.catch(() => undefined);
      await update;
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    if (!interaction?.channel || !interaction.userId) {
      this.sendUiResponse(request.id, { cancelled: true });
      return;
    }

    const key = `${interaction.channelId}:${interaction.userId}`;
    const isAskUser = typeof request.title === "string" && request.title.startsWith("Ask User");
    const isAskUserReview = isAskUser && request.title.startsWith("Ask User\n\n");
    const isAskUserQuestion = isAskUser && !isAskUserReview && request.title.includes("\n");
    if (isAskUser) {
      this.pendingAskUserCompletion = undefined;
    } else {
      await this.flushPendingAskUserCompletion();
      this.askUserMessage = undefined;
    }
    const timeoutMs = Number.isFinite(request.timeout) && request.timeout > 0
      ? Math.min(request.timeout, 60 * 60 * 1000)
      : UI_DEFAULT_TIMEOUT_MS;

    let promptText;
    let parseAnswer;
    let options = [];
    if (method === "select") {
      options = Array.isArray(request.options) ? request.options.map(String) : [];
      if (options.length === 0) {
        this.sendUiResponse(request.id, { cancelled: true });
        return;
      }
      promptText = isAskUserReview
        ? request.title || "Review your responses"
        : `${request.title || "Choose an option"}\nSelect an option below, or reply with its number or exact text.`;
      parseAnswer = (answer) => {
        const normalized = answer.trim();
        const selectedIndex = Number.parseInt(normalized, 10) - 1;
        if (/^[0-9]+$/.test(normalized) && selectedIndex >= 0 && selectedIndex < options.length) {
          return { done: true, value: options[selectedIndex] };
        }
        const exact = options.find((option) => option.toLowerCase() === normalized.toLowerCase());
        return exact ? { done: true, value: exact } : { done: false };
      };
    } else if (method === "confirm") {
      promptText = `${request.title || "Confirm"}\n${request.message || "Choose yes or no below."}`;
      parseAnswer = (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (["yes", "y", "true", "1"].includes(normalized)) return { done: true, confirmed: true };
        if (["no", "n", "false", "0"].includes(normalized)) return { done: true, confirmed: false };
        return { done: false };
      };
    } else {
      const title = request.title || (method === "editor" ? "Edit text" : "Your response");
      const prefill = method === "editor" && typeof request.prefill === "string" ? request.prefill : "";
      const placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
      promptText = `${title}${placeholder ? `\n${placeholder}` : ""}\n${method === "editor" ? "Open the editor below to enter your response." : "Open the input below to enter your response."}`;
      if (prefill) promptText += `\n\nCurrent text:\n${truncateDiscordText(prefill, 900)}`;
      parseAnswer = (answer) => ({ done: true, value: answer });
    }

    if (this.closed) {
      this.sendUiResponse(request.id, { cancelled: true });
      return;
    }
    interaction.typing?.pause?.();
    let answer;
    try {
      answer = await this.waitForDiscordAnswer(key, interaction.channel, promptText, parseAnswer, timeoutMs, this, {
        method, request, options, isAskUser, isAskUserReview, isAskUserQuestion,
      });
    } finally {
      interaction.typing?.resume?.();
    }
    if (answer === undefined) {
      this.sendUiResponse(request.id, { cancelled: true });
    } else if (method === "confirm") {
      this.sendUiResponse(request.id, { confirmed: answer });
    } else {
      this.sendUiResponse(request.id, { value: answer });
    }
  }

  async updateStatusMessage(request, epoch) {
    if (this.closed || !this.statusActive || epoch !== this.statusEpoch) return;
    const interaction = this.interaction;
    const key = request.statusKey;
    const text = typeof request.statusText === "string" ? request.statusText.trim() : "";
    const existing = this.statusMessages.get(key);
    if (!text) {
      this.statusMessages.delete(key);
      if (existing) await existing.delete().catch(() => undefined);
      return;
    }
    if (!interaction?.channel) return;
    if (existing && existing.channelId === interaction.channelId) {
      try {
        await existing.edit({ content: text, allowedMentions: { parse: [] } });
        return;
      } catch {
        this.statusMessages.delete(key);
      }
    }
    if (existing) await existing.delete().catch(() => undefined);
    const statusMessage = await interaction.channel.send({ content: text, allowedMentions: { parse: [] } });
    if (this.closed || !this.statusActive || epoch !== this.statusEpoch) {
      await statusMessage.delete().catch(() => undefined);
      return;
    }
    this.statusMessages.set(key, statusMessage);
  }

  async clearStatusMessages() {
    // Invalidate queued updates and wait for in-flight sends before deleting.
    this.statusActive = false;
    this.statusEpoch += 1;
    await this.statusUpdatePromise;
    const messages = [...this.statusMessages.values()];
    this.statusMessages.clear();
    await Promise.all(messages.map((message) => message.delete().catch(() => undefined)));
  }

  async close() {
    this.closed = true;
    this.cancelSession(this);
    this.pendingAskUserCompletion = undefined;
    await this.clearStatusMessages();
  }
}
