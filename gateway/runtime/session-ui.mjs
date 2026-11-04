import { stripVTControlCharacters } from "node:util";
import { ASK_USER_CHOICES_GUIDE, ASK_USER_CUSTOM_GUIDE, ASK_USER_INPUT_GUIDE, buildCommitCardPayload, buildDiscordUiPayload } from "./components.mjs";
import { log, safeErrorName } from "./logging.mjs";
import { sendText, truncateDiscordText } from "./messages.mjs";
import { listChannels } from "./history.mjs";
import { safeChannelName, toolActivity, workspaceDetail } from "./tool-activity.mjs";

const UI_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMMIT_PROGRESS_INTERVAL_MS = 2000;
const TOOL_ACTIVITY_BATCH_MS = 5000;
const TOOL_ACTIVITY_PAGE_LIMIT = 1900;

export function queueAskUserMessageEdit(session, message, payload) {
  const edit = (session.askUserMessageEditPromise || Promise.resolve())
    .catch(() => undefined)
    .then(() => message.edit(payload));
  session.askUserMessageEditPromise = edit.catch(() => undefined);
  return edit;
}

/** Discord UI state belonging to a single Pi session, separate from RPC transport. */
export class SessionUi {
  constructor(session, { waitForDiscordAnswer, cancelSession, showCommitNotice }) {
    this.session = session;
    this.waitForDiscordAnswer = waitForDiscordAnswer;
    this.cancelSession = cancelSession;
    this.showCommitNotice = showCommitNotice;
    this.commitEditPromise = Promise.resolve();
    this.commitEpoch = 0;
    this.pendingAskUserCompletion = undefined;
    this.statusMessages = new Map();
    this.statusUpdatePromise = Promise.resolve();
    this.toolActivityPromise = Promise.resolve();
    this.toolActivityQueue = [];
    this.toolActivityPages = [];
    this.toolActivityTimer = undefined;
    this.statusEpoch = 0;
    this.closed = false;
    this.resetPrompt();
  }

  get interaction() { return this.session.interaction; }

  resetPrompt() {
    this.stopCommitProgress();
    this.lastCommitProgressAt = -Infinity;
    this.cancelCommitNotice?.();
    this.cancelCommitPrompt?.();
    this.commitEpoch += 1;
    this.commitView = 0;
    this.commitMessage = undefined;
    this.commitWarnings = [];
    this.notificationPromise = Promise.resolve();
    this.commitProposal = undefined;
    this.statusActive = !this.closed;
    this.askUserMessage = undefined;
    this.askUserMessageEditPromise = Promise.resolve();
  }

  beginCommitView() {
    this.stopCommitProgress();
    this.cancelCommitNotice?.();
    this.cancelCommitPrompt?.();
    this.commitView += 1;
    return this.commitView;
  }

  isCurrentCommitView(view, epoch) {
    return view === this.commitView && epoch === this.commitEpoch;
  }

  editCommitMessage(channel, payload, view, epoch = this.commitEpoch, shouldApply) {
    const update = this.commitEditPromise.then(async () => {
      if (!this.isCurrentCommitView(view, epoch) || (shouldApply && !shouldApply())) return undefined;
      const nextPayload = typeof payload === "function" ? payload() : payload;
      const existing = this.commitMessage;
      if (existing?.channelId === channel.id) {
        try {
          const message = await existing.edit(nextPayload) || existing;
          if (epoch === this.commitEpoch) this.commitMessage = message;
          return message;
        } catch (error) {
          // Only a deleted message warrants a replacement. Transient errors
          // must not turn every edit attempt into another chat message.
          if (Number(error?.code) !== 10008) throw error;
          if (this.commitMessage === existing) this.commitMessage = undefined;
        }
      }
      if (!this.isCurrentCommitView(view, epoch) || (shouldApply && !shouldApply())) return undefined;
      const message = await channel.send(nextPayload);
      // A newer screen may have been queued during this send; keep the same
      // message for it, but never attach an old run's send to a new run.
      if (epoch === this.commitEpoch) this.commitMessage = message;
      return message;
    });
    this.commitEditPromise = update.catch(() => undefined);
    return update;
  }

  stopCommitProgress() {
    if (this.commitProgress?.timer) clearTimeout(this.commitProgress.timer);
    this.commitProgress = undefined;
  }

  queueCommitProgress(lines) {
    const interaction = this.interaction;
    if (this.closed || interaction?.workflow !== "commit" || !interaction.channel?.send || this.cancelCommitPrompt) return;
    const text = truncateDiscordText(stripVTControlCharacters(lines.join("\n")).trim(), 1900);
    if (!text) { this.stopCommitProgress(); return; }
    if (!this.commitProgress) {
      const view = this.beginCommitView();
      this.commitProgress = { channel: interaction.channel, view, epoch: this.commitEpoch, text, dirty: true, inFlight: false };
    } else {
      this.commitProgress.text = text;
      this.commitProgress.dirty = true;
    }
    this.scheduleCommitProgress(this.commitProgress);
  }

  scheduleCommitProgress(progress) {
    if (this.closed || progress !== this.commitProgress || progress.inFlight || progress.timer || !progress.dirty) return;
    const delay = Math.max(0, COMMIT_PROGRESS_INTERVAL_MS - (Date.now() - this.lastCommitProgressAt));
    if (delay === 0) {
      void this.flushCommitProgress(progress);
    } else {
      progress.timer = setTimeout(() => {
        progress.timer = undefined;
        void this.flushCommitProgress(progress);
      }, delay);
      progress.timer.unref?.();
    }
  }

  async flushCommitProgress(progress) {
    if (this.closed || progress !== this.commitProgress || progress.inFlight || !progress.dirty) return;
    progress.inFlight = true;
    let started = false;
    try {
      await this.editCommitMessage(progress.channel, () => {
        started = true;
        // Build from the latest snapshot when this edit actually starts, not
        // when it was queued behind other Discord work.
        this.lastCommitProgressAt = Date.now();
        progress.dirty = false;
        return buildCommitCardPayload(progress.text, { title: "Commit agent working", workspace: this.session.cwd });
      }, progress.view, progress.epoch, () => !this.closed && progress === this.commitProgress
        && (started || Date.now() - this.lastCommitProgressAt >= COMMIT_PROGRESS_INTERVAL_MS));
    } catch (error) {
      log(`Could not update commit progress: ${safeErrorName(error)}`);
    } finally {
      progress.inFlight = false;
      this.scheduleCommitProgress(progress);
    }
  }

  async flushCommitMessageEdits() {
    await this.commitEditPromise;
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

  async flushNotifications() {
    await this.notificationPromise;
    // Normally the proposal is consumed by the next review dialog. If the
    // command exits early, still deliver it rather than losing review details.
    if (this.commitProposal) {
      const proposal = this.commitProposal;
      this.commitProposal = undefined;
      await this.sendCommitNotice(this.interaction?.channel, proposal);
    }
  }

  async sendCommitNotice(channel, text, notifyType = "info") {
    if (this.closed || !channel?.send) return;
    if (["warning", "error"].includes(notifyType) && !this.commitWarnings.some((notice) => notice.text === text)) {
      this.commitWarnings.push({ text, notifyType });
    }
    const earlier = this.commitWarnings.filter((notice) => notice.text !== text);
    const body = earlier.length > 0 ? `${text}\n\n### Earlier warnings\n${earlier.map((notice) => notice.text).join("\n\n")}` : text;
    const severity = this.commitWarnings.some((notice) => notice.notifyType === "error") ? "error"
      : this.commitWarnings.length > 0 ? "warning" : notifyType;
    await this.showCommitNotice(this, channel, body, severity);
  }

  async notifyWorkspaceChanged(previousCwd, cwd) {
    if (this.closed || previousCwd === cwd || !this.interaction?.channel) return;
    await sendText(this.interaction.channel, `-# Workspace changed: ${workspaceDetail(previousCwd)} → ${workspaceDetail(cwd)}`);
  }

  queueAssistantNarration(message) {
    const interaction = this.interaction;
    if (this.closed || (this.session.config?.toolCallVerbosity ?? "full") !== "full" ||
        !interaction?.channel || ["commit", "usage"].includes(interaction.workflow) ||
        message?.role !== "assistant" || ["error", "aborted"].includes(message.stopReason) ||
        !Array.isArray(message.content) || !message.content.some((block) => block?.type === "toolCall")) return undefined;
    // Only normal assistant text is public narration; never forward thinking blocks.
    const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("").trim();
    if (!text) return undefined;
    // Preserve the ordering of already buffered activity and narration.
    this.sendToolActivityBatch();
    const delivery = this.toolActivityPromise.then(async () => {
      await sendText(interaction.channel, text);
      return true;
    }).catch((error) => {
      log(`Could not send assistant narration: ${safeErrorName(error)}`);
      return false;
    });
    this.toolActivityPromise = delivery.then(() => undefined);
    return { text, delivery };
  }

  queueToolActivity(record) {
    const interaction = this.interaction;
    if (this.closed || this.session.config?.toolCallVerbosity === "none" || !interaction?.channel || ["commit", "usage"].includes(interaction.workflow)) return;
    if (record.toolName === "set_working_directory" && record.type !== "tool_execution_end") return;
    if (record.type === "tool_execution_end" && !record.isError) return;
    this.toolActivityQueue.push({ record, interaction });
    if (!this.toolActivityTimer) {
      this.toolActivityTimer = setTimeout(() => {
        this.toolActivityTimer = undefined;
        this.sendToolActivityBatch();
      }, TOOL_ACTIVITY_BATCH_MS);
      this.toolActivityTimer.unref?.();
    }
  }

  resetToolActivity() {
    // The previous run has been flushed before its interaction is released.
    this.toolActivityPages = [];
  }

  sendToolActivityBatch() {
    if (this.toolActivityTimer) clearTimeout(this.toolActivityTimer);
    this.toolActivityTimer = undefined;
    const batch = this.toolActivityQueue.splice(0);
    const operation = this.toolActivityPromise.then(async () => {
      const lines = [];
      for (const { record, interaction } of batch) {
        let text;
        if (record.type === "tool_execution_end") {
          text = record.toolName === "set_working_directory" ? "Workspace switch failed" : "Tool call failed";
          const label = toolActivity(record.toolName);
          if (label) text = `${label} — failed`;
        } else {
          let channelName;
          if (record.toolName === "discord_channel_history" && interaction.historyScope?.kind === "thread") {
            try {
              // Reuse discovery's authorization checks rather than revealing names
              // from the bot's wider channel cache to a shared thread.
              const channels = await listChannels({ ...this.session.historyOptions, session: this.session });
              channelName = safeChannelName(channels.channels.find((channel) => channel.id === record.args?.channelId)?.name);
            } catch { /* Fall back to a generic label. */ }
          }
          text = toolActivity(record.toolName, record.args, channelName);
        }
        if (text) lines.push(`-# ${text}`);
      }
      for (const line of lines) {
        let page = this.toolActivityPages.at(-1);
        if (!page || page.text.length + 1 + line.length > TOOL_ACTIVITY_PAGE_LIMIT) {
          page = { channel: batch[0].interaction.channel, text: "", message: undefined, dirty: false };
          this.toolActivityPages.push(page);
        }
        page.text += `${page.text ? "\n" : ""}${line}`;
        page.dirty = true;
      }
      for (const page of this.toolActivityPages) {
        if (!page.dirty) continue;
        const payload = { content: page.text, allowedMentions: { parse: [], repliedUser: false } };
        if (page.message) {
          try {
            page.message = await page.message.edit(payload) || page.message;
          } catch (error) {
            // Do not create duplicates on a temporary Discord error.
            if (Number(error?.code) !== 10008) throw error;
            page.message = undefined;
          }
        }
        if (!page.message) page.message = await page.channel.send(payload);
        page.dirty = false;
      }
    });
    this.toolActivityPromise = operation.catch((error) => {
      log(`Could not send tool activity: ${safeErrorName(error)}`);
    });
  }

  async flushToolActivity() {
    this.sendToolActivityBatch();
    await this.toolActivityPromise;
  }

  async handleRequest(request) {
    if (this.closed) {
      this.sendUiResponse(request.id, { cancelled: true });
      return;
    }
    const interaction = this.interaction;
    const method = request.method;
    if (method === "setWidget" && request.widgetKey === "commit") {
      const lines = Array.isArray(request.widgetLines) ? request.widgetLines.filter((line) => typeof line === "string") : [];
      if (lines.length === 0) this.stopCommitProgress();
      else this.queueCommitProgress(lines);
      return;
    }
    if (method === "notify") {
      // Usage reports contain account details and must never reach the channel.
      if (interaction?.workflow === "usage") {
        if (request.message) interaction.privateNotifications.push(String(request.message));
        return;
      }
      if (interaction?.channel && request.message) {
        const notification = this.notificationPromise.then(async () => {
          const text = String(request.message);
          if (interaction.workflow === "commit") {
            if (/^Commit proposal \(/.test(text)) this.commitProposal = text;
            else await this.sendCommitNotice(interaction.channel, text, request.notifyType);
          } else {
            await sendText(interaction.channel, text, interaction.replyToMessageId);
          }
        });
        this.notificationPromise = notification;
        await notification;
      }
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

    const isCommit = interaction.workflow === "commit";
    await this.flushToolActivity();
    await this.notificationPromise;
    const isCommitReview = isCommit && method === "select" && /^Commit Proposal \(/.test(request.title || "");
    let commitProposal = isCommitReview ? this.commitProposal : undefined;
    if (isCommitReview && !commitProposal) {
      await this.sendCommitNotice(interaction.channel, "Commit review cancelled: the full proposal was not received. Update the Pi session's pi-enhanced extension before retrying.", "error");
      this.sendUiResponse(request.id, { cancelled: true });
      return;
    }
    if (commitProposal) {
      this.commitProposal = undefined;
      if (this.commitWarnings.length > 0) {
        commitProposal = `### Earlier warnings\n${this.commitWarnings.map((notice) => notice.text).join("\n\n")}\n\n${commitProposal}`;
      }
    }
    // Other notifications must finish before approval; proposals are rendered
    // in full with their controls, paginated rather than silently truncated.
    await this.flushNotifications();
    const key = `${interaction.channelId}:${interaction.userId}`;
    const isAskUser = typeof request.title === "string" && request.title.startsWith("Ask User");
    let askUserNavigation;
    if (isAskUser) {
      const match = /\n\u2063pi-ask-user:([A-Za-z0-9_-]+)$/.exec(request.title);
      if (match) {
        try {
          const data = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
          if (data && typeof data === "object") askUserNavigation = data;
          request = { ...request, title: request.title.slice(0, match.index) };
        } catch { /* Leave an invalid title unchanged. */ }
      }
    }
    const isAskUserQuestion = isAskUser && request.title.includes("\n");
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
    let allowCustomAnswer = false;
    if (method === "select") {
      options = Array.isArray(request.options) ? request.options.map(String) : [];
      const customChoiceLabel = "✎ Type custom answer...";
      allowCustomAnswer = isAskUserQuestion && options.includes(customChoiceLabel);
      if (allowCustomAnswer) options = options.filter((option) => option !== customChoiceLabel);
      if (options.length === 0) {
        this.sendUiResponse(request.id, { cancelled: true });
        return;
      }
      promptText = `${request.title || "Choose an option"}\n${isAskUser ? (allowCustomAnswer ? ASK_USER_CUSTOM_GUIDE : ASK_USER_CHOICES_GUIDE) : isCommit ? "Choose an action below, or reply with its number or exact text." : "Select an option below, or reply with its number or exact text."}`;
      parseAnswer = (answer) => {
        const normalized = answer.trim();
        const selectedIndex = Number.parseInt(normalized, 10) - 1;
        if (/^[0-9]+$/.test(normalized) && selectedIndex >= 0 && selectedIndex < options.length) {
          return { done: true, value: options[selectedIndex] };
        }
        const exact = options.find((option) => option.toLowerCase() === normalized.toLowerCase());
        if (exact) return { done: true, value: exact };
        return allowCustomAnswer && normalized ? { done: true, value: normalized } : { done: false };
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
      promptText = `${title}${placeholder ? `\n${placeholder}` : ""}\n${isAskUser && method === "input" ? ASK_USER_INPUT_GUIDE : method === "editor" ? "Open the editor below to enter your response." : "Open the input below to enter your response."}`;
      if (prefill) promptText += `\n\nCurrent text:\n${isCommit ? prefill : truncateDiscordText(prefill, 900)}`;
      if (isCommit && prefill.length > 4000) {
        promptText += "\n\nThis plan exceeds Discord's 4000-character editor limit. Editing is disabled to avoid losing commits. Dismiss and rerun /commit with a narrower scope.";
      }
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
        method, request, options, isAskUser, isAskUserQuestion, allowCustomAnswer, askUserNavigation,
        isCommit, commitProposal, workspace: this.session.cwd,
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
    this.stopCommitProgress();
    this.closed = true;
    this.cancelSession(this);
    this.pendingAskUserCompletion = undefined;
    await this.flushCommitMessageEdits();
    await this.flushToolActivity();
    this.commitEpoch += 1;
    await this.clearStatusMessages();
  }
}
