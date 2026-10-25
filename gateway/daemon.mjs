import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const configPath = process.env.PI_ENHANCED_DISCORD_CONFIG_PATH;
const pidPath = process.env.PI_ENHANCED_DISCORD_PID_PATH;
const statusPath = process.env.PI_ENHANCED_DISCORD_STATUS_PATH;
const sessionRoot = process.env.PI_ENHANCED_DISCORD_SESSION_ROOT;
const threadsPath = process.env.PI_ENHANCED_DISCORD_THREADS_PATH;
const restartRequestPath = process.env.PI_ENHANCED_DISCORD_RESTART_REQUEST_PATH;
const logPath = process.env.PI_ENHANCED_DISCORD_LOG_PATH;
const piExecutable = process.env.PI_ENHANCED_DISCORD_PI_EXECUTABLE || "pi";
const piArgs = parseJsonArray(process.env.PI_ENHANCED_DISCORD_PI_ARGS);
let previousGatewayState;
try {
  previousGatewayState = JSON.parse(readFileSync(statusPath, "utf8"))?.state;
} catch {
  // No previous status is expected on a first start.
}
const startReason = previousGatewayState === "restarting"
  ? "restart"
  : process.env.PI_ENHANCED_DISCORD_START_REASON || "start";
const MAX_ACTIVE_RUNS = 3;
const MAX_OPEN_SESSIONS = 20;
const SESSION_IDLE_MS = 20 * 60 * 1000;
const UI_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const THREAD_TITLE_WAIT_MS = 25_000;
const THREAD_TITLE_POLL_MS = 500;
const DISCORD_TEXT_LIMIT = 1900;

if (!configPath || !pidPath || !statusPath || !sessionRoot || !threadsPath) {
  throw new Error("Discord gateway paths are not configured");
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
if (
  typeof config.token !== "string" ||
  !config.token ||
  !isValidAllowlist(config.allowedUserIds) ||
  !isValidAllowlist(config.allowedChannelIds) ||
  (config.allowDirectMessages !== undefined && typeof config.allowDirectMessages !== "boolean") ||
  (config.allowServerMessages !== undefined && typeof config.allowServerMessages !== "boolean") ||
  (config.homeChannelId !== undefined && (typeof config.homeChannelId !== "string" || !/^\d{17,20}$/.test(config.homeChannelId))) ||
  typeof config.cwd !== "string"
) {
  throw new Error("Discord gateway configuration is invalid");
}

const allowedUsers = new Set(config.allowedUserIds);
const allowedChannels = new Set(config.allowedChannelIds);
const allowDirectMessages = config.allowDirectMessages !== false;
const allowServerMessages = config.allowServerMessages !== false;
const threadRegistry = readThreadRegistry();
const seenMessages = new Set();
const piSessions = new Map();
const sessionQueues = new Map();
const pendingUiAnswers = new Map();
const pendingDiscordUi = new Map();
const pendingThreadTitleRenames = new Set();
const runQueue = [];
let activeRuns = 0;
let activeMessageHandlers = 0;
let pendingMessageTasks = 0;
let restartRequested = false;
let restartStarted = false;
let shuttingDown = false;
let idleCleanupTimer;
let restartRequestPollTimer;

const startedAt = new Date().toISOString();
let gatewayStatus = {
  pid: process.pid,
  state: "starting",
  startedAt,
  updatedAt: startedAt,
};
writePrivateJson(pidPath, { pid: process.pid, startedAt });
writeStatus();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.on("clientReady", (readyClient) => {
  updateStatus("ready", { botTag: readyClient.user.tag, lastError: undefined });
  log(`Connected as ${readyClient.user.tag}`);
  void sendHomeNotification(startReason === "start" ? "Discord gateway started and is online." : "Discord gateway restarted and is online.");
});
client.on("shardDisconnect", (event) => {
  updateStatus("disconnected", {
    lastError: `Discord gateway disconnected (code ${Number(event?.code) || "unknown"}); reconnecting if possible.`,
  });
});
client.on("shardResume", () => updateStatus("ready", { lastError: undefined }));
client.on("error", (error) => {
  updateStatus("disconnected", { lastError: summarizeDiscordError(error) });
  log(`Discord client error: ${summarizeDiscordError(error)}`);
});
client.on("messageCreate", (message) => {
  activeMessageHandlers += 1;
  void handleMessage(message)
    .catch((error) => {
      log(`Message handling failed: ${safeErrorName(error)}`);
    })
    .finally(() => {
      activeMessageHandlers -= 1;
      maybeStartRequestedRestart();
    });
});

client.on("interactionCreate", (interaction) => {
  void handleGatewayUiInteraction(interaction).catch((error) => {
    log(`Discord UI interaction failed: ${safeErrorName(error)}`);
  });
});

idleCleanupTimer = setInterval(() => {
  void closeIdleSessions();
}, 60_000);
idleCleanupTimer.unref();
if (restartRequestPath) {
  restartRequestPollTimer = setInterval(checkRestartRequest, 250);
  restartRequestPollTimer.unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  const summary = `Uncaught error: ${safeErrorName(error)}`;
  updateStatus("failed", { lastError: summary });
  log(summary);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (error) => {
  log(`Unhandled rejection: ${safeErrorName(error)}`);
});

try {
  await client.login(config.token);
} catch (error) {
  const summary = summarizeDiscordError(error);
  updateStatus("failed", { lastError: summary });
  log(`Discord login failed: ${summary}`);
  await shutdown("login failure", 1);
}

async function handleMessage(message) {
  if (shuttingDown || message.author?.bot || !message.author?.id || (!allowedUsers.has("*") && !allowedUsers.has(message.author.id))) return;

  const route = classifyMessage(message);
  if (!route) return;
  updateStatus(gatewayStatus.state, { lastEventAt: new Date().toISOString() });

  const pendingKey = `${message.channelId}:${message.author.id}`;
  const pendingUi = pendingUiAnswers.get(pendingKey);
  if (pendingUi) {
    pendingUi.accept(stripBotMention(message.content || ""));
    return;
  }

  if (restartRequested) {
    await sendText(message.channel, "The gateway is restarting after the current work finishes. Please send this again once the bot reconnects.");
    return;
  }

  if (seenMessages.has(message.id)) return;
  seenMessages.add(message.id);
  if (seenMessages.size > 3000) seenMessages.delete(seenMessages.values().next().value);

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
    const content = stripBotMention(message.content || "");
    try {
      const thread = await message.startThread({
        name: makeThreadName(message.author.username, content),
        autoArchiveDuration: 1440,
      });
      threadRegistry[thread.id] = {
        parentChannelId: message.channelId,
        createdByUserId: message.author.id,
        createdAt: new Date().toISOString(),
      };
      pruneThreadRegistry();
      writeThreadRegistry();
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

  const content = stripBotMention(message.content || "");
  if (!content) {
    await sendText(target, "I can only process text messages right now. Please send your request as text.");
    return;
  }

  const prompt = `Discord message from ${message.author.username} (user ID ${message.author.id}) in ${conversationLabel}:\n\n${content}`;
  pendingMessageTasks += 1;
  const queuedRun = enqueueForSession(sessionKey, async () => {
    const typing = startTyping(target);
    try {
      const result = await withRunSlot(async () => {
        const session = await getPiSession(sessionKey);
        const result = await session.promptAndWait(prompt, {
          channel: target,
          userId: message.author.id,
          channelId: target.id,
          typing,
        });
        watchThreadTitle(target, session);
        return result;
      });
      if (result.trim()) await sendText(target, result);
      else await sendText(target, "The agent finished without a text response.");
    } catch (error) {
      log(`Pi run failed: ${safeErrorName(error)}`);
      await sendText(target, "The agent couldn't complete that request. Check the gateway logs and your Pi model/provider configuration.");
    } finally {
      typing.stop();
    }
  });
  void queuedRun
    .catch((error) => {
      log(`Queued Pi run failed: ${safeErrorName(error)}`);
    })
    .finally(() => {
      pendingMessageTasks -= 1;
      maybeStartRequestedRestart();
    });
}

function classifyMessage(message) {
  if (message.guildId == null) return allowDirectMessages ? { kind: "dm" } : undefined;
  if (!allowServerMessages) return undefined;
  const channel = message.channel;
  if (typeof channel?.isThread === "function" && channel.isThread()) {
    const registration = threadRegistry[message.channelId];
    if (!registration || (!allowedChannels.has("*") && !allowedChannels.has(registration.parentChannelId))) return undefined;
    return { kind: "thread", parentChannelId: registration.parentChannelId };
  }

  if (!allowedChannels.has("*") && !allowedChannels.has(message.channelId)) return undefined;
  if (!client.user || !message.mentions?.users?.has(client.user.id)) return undefined;
  if (typeof message.startThread !== "function") return undefined;
  return { kind: "new-thread" };
}

function enqueueForSession(key, task) {
  const previous = sessionQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  sessionQueues.set(key, current);
  const cleanup = () => {
    if (sessionQueues.get(key) === current) sessionQueues.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}

async function withRunSlot(task) {
  if (activeRuns >= MAX_ACTIVE_RUNS) {
    await new Promise((resolve) => runQueue.push(resolve));
  } else {
    activeRuns += 1;
  }
  try {
    return await task();
  } finally {
    activeRuns -= 1;
    const next = runQueue.shift();
    if (next) {
      activeRuns += 1;
      next();
    }
  }
}

async function getPiSession(key) {
  let session = piSessions.get(key);
  if (session && !session.closed) {
    session.lastUsedAt = Date.now();
    return session;
  }

  if (piSessions.size >= MAX_OPEN_SESSIONS) {
    await closeLeastRecentlyUsedIdleSession();
  }

  const hash = createHash("sha256").update(key).digest("hex");
  const sessionDirectory = join(sessionRoot, hash);
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  try { chmodSync(sessionDirectory, 0o700); } catch { /* best-effort on non-POSIX filesystems */ }
  const created = new PiRpcSession(sessionDirectory);
  piSessions.set(key, created);
  try {
    await created.start();
    return created;
  } catch (error) {
    piSessions.delete(key);
    await created.stop();
    throw error;
  }
}

class PiRpcSession {
  constructor(sessionDirectory) {
    this.sessionDirectory = sessionDirectory;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.counter = 0;
    this.pendingRequests = new Map();
    this.runWaiter = undefined;
    this.interaction = undefined;
    this.askUserMessage = undefined;
    this.askUserMessageEditPromise = Promise.resolve();
    this.statusMessages = new Map();
    this.closed = false;
    this.running = false;
    this.lastUsedAt = Date.now();
  }

  async start() {
    mkdirSync(this.sessionDirectory, { recursive: true, mode: 0o700 });
    const agentEnvironment = { ...process.env };
    delete agentEnvironment.PI_ENHANCED_DISCORD_BOT_TOKEN;
    delete agentEnvironment.DISCORD_BOT_TOKEN;
    delete agentEnvironment.PI_ENHANCED_DISCORD_CONFIG_PATH;
    delete agentEnvironment.PI_ENHANCED_DISCORD_PID_PATH;
    delete agentEnvironment.PI_ENHANCED_DISCORD_STATUS_PATH;
    delete agentEnvironment.PI_ENHANCED_DISCORD_LOG_PATH;
    delete agentEnvironment.PI_ENHANCED_DISCORD_SESSION_ROOT;
    delete agentEnvironment.PI_ENHANCED_DISCORD_THREADS_PATH;
    delete agentEnvironment.PI_ENHANCED_DISCORD_PI_EXECUTABLE;
    delete agentEnvironment.PI_ENHANCED_DISCORD_PI_ARGS;
    delete agentEnvironment.PI_ENHANCED_DISCORD_GATEWAY_CHILD;
    agentEnvironment.PI_ENHANCED_DISCORD_GATEWAY_CHILD = "1";

    const sessionArgs = [
      ...piArgs,
      "--mode", "rpc",
      "--session-dir", this.sessionDirectory,
      "--continue",
      "--approve",
    ];
    if (config.model?.provider && config.model?.id) {
      sessionArgs.push("--model", `${config.model.provider}/${config.model.id}`);
    }
    if (config.thinkingLevel) sessionArgs.push("--thinking", config.thinkingLevel);

    this.child = spawn(
      piExecutable,
      sessionArgs,
      {
        cwd: config.cwd,
        env: agentEnvironment,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      }
    );
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`Pi process exited (${signal || code || "unknown"})`);
      this.fail(error);
    });
    this.child.stdin.on("error", (error) => this.fail(error));

    const state = await this.request("get_state", {}, 120_000);
    if (!state.success) throw new Error("Pi RPC session failed to initialize");
  }

  consumeStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line.toString("utf8"));
      } catch {
        log("Ignored malformed record from Pi RPC process");
        continue;
      }
      this.handleRecord(record);
    }
  }

  handleRecord(record) {
    if (record?.type === "response" && typeof record.id === "string") {
      const pending = this.pendingRequests.get(record.id);
      if (pending) {
        this.pendingRequests.delete(record.id);
        clearTimeout(pending.timer);
        pending.resolve(record);
      }
      return;
    }

    if (record?.type === "agent_settled" && this.runWaiter) {
      const waiter = this.runWaiter;
      this.runWaiter = undefined;
      waiter.resolve(record);
      return;
    }

    if (record?.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(record).catch(() => {
        this.sendUiResponse(record.id, { cancelled: true });
      });
    }
  }

  async request(type, fields = {}, timeoutMs = 30_000) {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error("Pi RPC process is unavailable");
    const id = `discord-${process.pid}-${++this.counter}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Pi RPC ${type} command timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return response;
  }

  async promptAndWait(message, interaction) {
    if (this.running) throw new Error("Pi session received overlapping prompts");
    this.running = true;
    this.lastUsedAt = Date.now();
    this.interaction = interaction;
    this.askUserMessage = undefined;
    this.askUserMessageEditPromise = Promise.resolve();
    let settledPromise;
    try {
      settledPromise = new Promise((resolve, reject) => {
        this.runWaiter = { resolve, reject };
      });
      void settledPromise.catch(() => undefined);
      const accepted = await this.request("prompt", { message }, 30_000);
      if (!accepted.success) throw new Error("Pi rejected the Discord message");
      if (accepted.data?.disposition === "handled") return "";
      const settled = await settledPromise;
      if (settled.aborted) return "The agent run was cancelled.";
      const response = await this.request("get_last_assistant_text", {}, 30_000);
      if (!response.success) throw new Error("Could not retrieve the agent response");
      return typeof response.data?.text === "string" ? response.data.text : "";
    } finally {
      if (this.runWaiter) this.runWaiter = undefined;
      await this.clearStatusMessages();
      this.interaction = undefined;
      this.running = false;
      this.lastUsedAt = Date.now();
    }
  }

  async handleExtensionUiRequest(request) {
    const interaction = this.interaction;
    const method = request.method;
    if (method === "notify") {
      if (interaction?.channel && request.message) await sendText(interaction.channel, String(request.message));
      return;
    }
    if (method === "setStatus" && request.statusKey === "pi-enhanced-working") {
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
      this.statusMessages.set(key, statusMessage);
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
    if (!isAskUser) this.askUserMessage = undefined;
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

    interaction.typing?.pause?.();
    let answer;
    try {
      answer = await waitForDiscordAnswer(key, interaction.channel, promptText, parseAnswer, timeoutMs, this, {
        method,
        request,
        options,
        isAskUser,
        isAskUserReview,
        isAskUserQuestion,
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

  sendUiResponse(id, response) {
    if (!this.child?.stdin.writable || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
  }

  async clearStatusMessages() {
    const messages = [...this.statusMessages.values()];
    this.statusMessages.clear();
    await Promise.all(messages.map((message) => message.delete().catch(() => undefined)));
  }

  fail(error) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
    if (this.runWaiter) {
      this.runWaiter.reject(error);
      this.runWaiter = undefined;
    }
  }

  async stop() {
    if (this.closed && !this.child) return;
    this.closed = true;
    for (const pending of pendingUiAnswers.values()) {
      if (pending.session === this) pending.finish(undefined);
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi RPC session stopped"));
      this.pendingRequests.delete(id);
    }
    await this.clearStatusMessages();
    if (!this.child) return;
    try {
      this.child.stdin.end();
      await Promise.race([onceExit(this.child), delay(3000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    } catch {
      // The child may have already exited.
    }
    this.child = undefined;
  }
}

function waitForDiscordAnswer(key, channel, promptText, parseAnswer, timeoutMs, session, uiRequest) {
  return new Promise((resolve) => {
    const existing = pendingUiAnswers.get(key);
    if (existing) existing.finish(undefined);

    const token = randomUUID();
    let finished = false;
    const pending = {
      token,
      key,
      session,
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
        if (value === undefined && session.askUserMessage === pending.promptMessage) {
          session.askUserMessage = undefined;
        }
        resolve(value);
        if (updatePrompt && pending.promptMessage) {
          const payload = buildDiscordUiPayload(pending, pending.completionStatus);
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

    void postPrompt().then((message) => {
      pending.promptMessage = message;
      if (uiRequest.isAskUser && (!finished || pending.result !== undefined)) {
        session.askUserMessage = message;
      }
      if (finished) {
        if (pending.result === undefined && session.askUserMessage === message) {
          session.askUserMessage = undefined;
        }
        const completedPayload = buildDiscordUiPayload(pending, pending.completionStatus);
        const edit = pending.isAskUser
          ? queueAskUserMessageEdit(session, message, completedPayload)
          : message.edit(completedPayload);
        void edit.catch(() => undefined);
      }
    }).catch(() => pending.finish(undefined));
  });
}

function queueAskUserMessageEdit(session, message, payload) {
  const edit = (session.askUserMessageEditPromise || Promise.resolve())
    .catch(() => undefined)
    .then(() => message.edit(payload));
  session.askUserMessageEditPromise = edit.catch(() => undefined);
  return edit;
}

function buildDiscordUiPayload(pending, statusText, responseValue = pending.result) {
  const optionGuide = "Select an option below, or reply with its number or exact text.";
  const hasDropdownGuide =
    pending.isAskUser &&
    pending.method === "select" &&
    !pending.isAskUserReview &&
    pending.promptText.endsWith(`\n${optionGuide}`);
  const reviewInstruction = "\n\nSubmit or choose an answer to edit.";
  const hasReviewInstruction =
    pending.isAskUserReview && pending.promptText.endsWith(reviewInstruction);
  let promptContent = hasDropdownGuide
    ? pending.promptText.slice(0, -(optionGuide.length + 1))
    : statusText && hasReviewInstruction
      ? pending.promptText.slice(0, -reviewInstruction.length)
      : pending.promptText;
  if (statusText === "Response received." && pending.isAskUserReview) {
    const titleEnd = promptContent.indexOf("\n");
    const title = titleEnd < 0 ? promptContent : promptContent.slice(0, titleEnd);
    const body = titleEnd < 0 ? "" : promptContent.slice(titleEnd);
    promptContent = `${title.replace(/ — (?:Review your responses|Response):$/, "")}${body}`;
  }
  const responseText =
    statusText === "Response received." && pending.isAskUserQuestion && responseValue !== undefined
      ? `\n\n**Your answer:**\n> ${truncateDiscordText(String(responseValue), 500).replace(/\r?\n/g, "\n> ")}`
      : "";
  const content = statusText ? `${promptContent}${responseText}\n\n${statusText}` : pending.promptText;
  const controls = statusText ? [] : buildDiscordUiComponents(pending);
  if (!pending.isAskUser) {
    return {
      content,
      components: controls,
      allowedMentions: { parse: [] },
    };
  }

  const showDropdownGuide = !statusText && hasDropdownGuide;
  const cardContent = showDropdownGuide ? promptContent : content;
  const requestTitle = typeof pending.request?.title === "string" ? pending.request.title : "";
  const questionBreak = requestTitle.indexOf("\n");
  let cardText;
  if (pending.isAskUserReview) {
    const [reviewTitle, ...reviewLines] = cardContent.split("\n");
    const formattedReviewLines = reviewLines.map((line) => {
      const questionMatch = /^(\d+)\.\s+(.+)$/.exec(line);
      if (questionMatch) return `### ${questionMatch[1]}. ${questionMatch[2]}`;
      const answerMatch = /^\s+Answer:\s*(.*)$/.exec(line);
      if (answerMatch) return `> **Answer:** ${answerMatch[1]}`;
      if (line === "Submit or choose an answer to edit.") return `-# ${line}`;
      return line;
    });
    cardText = `## ${reviewTitle}${formattedReviewLines.length ? `\n${formattedReviewLines.join("\n")}` : ""}`;
  } else if (
    requestTitle.startsWith("Ask User") &&
    questionBreak >= 0 &&
    cardContent.startsWith(requestTitle)
  ) {
    const heading = requestTitle.slice(0, questionBreak);
    const question = requestTitle.slice(questionBreak + 1).trim();
    const remainingText = cardContent.slice(requestTitle.length);
    cardText = `## ${heading}${question ? `\n### ${question}` : ""}${remainingText}`;
  } else {
    const firstBreak = cardContent.indexOf("\n");
    const firstLine = firstBreak < 0 ? cardContent : cardContent.slice(0, firstBreak);
    const remainingText = firstBreak < 0 ? "" : cardContent.slice(firstBreak + 1);
    cardText = firstLine.startsWith("Ask User")
      ? `### ${firstLine}${remainingText ? `\n${remainingText}` : ""}`
      : cardContent;
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(cardText));

  if (controls.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
    if (showDropdownGuide) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(optionGuide));
    }
    for (const control of controls) container.addActionRowComponents(control);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

function buildDiscordUiComponents(pending) {
  if (pending.isAskUserReview) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:review-submit`)
        .setLabel("Submit response")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:review-edit`)
        .setLabel("Edit answer")
        .setStyle(ButtonStyle.Secondary),
    )];
  }

  if (pending.method === "select") {
    const pageSize = 25;
    const pageCount = Math.ceil(pending.options.length / pageSize);
    const pageStart = pending.page * pageSize;
    const visibleOptions = pending.options.slice(pageStart, pageStart + pageSize);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`piui:${pending.token}:select`)
      .setPlaceholder(truncateDiscordText(pageCount > 1 ? `Choose an option (page ${pending.page + 1}/${pageCount})` : "Choose an option", 150))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(visibleOptions.map((option, index) => ({
        label: discordOptionLabel(option),
        value: String(pageStart + index),
      })));
    const rows = [new ActionRowBuilder().addComponents(menu)];
    const buttons = [];
    if (pageCount > 1) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:prev`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pending.page === 0));
      buttons.push(new ButtonBuilder()
        .setCustomId(`piui:${pending.token}:next`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pending.page >= pageCount - 1));
    }
    buttons.push(new ButtonBuilder()
      .setCustomId(`piui:${pending.token}:cancel`)
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary));
    rows.push(new ActionRowBuilder().addComponents(buttons));
    return rows;
  }

  if (pending.method === "confirm") {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`piui:${pending.token}:yes`).setLabel("Yes").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`piui:${pending.token}:no`).setLabel("No").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
    )];
  }

  const buttonLabel = pending.method === "editor" ? "Open editor" : "Enter response";
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`piui:${pending.token}:open`).setLabel(buttonLabel).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`piui:${pending.token}:cancel`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
  )];
}

function buildDiscordUiModal(pending) {
  const request = pending.request;
  const isEditor = pending.method === "editor";
  const textInput = new TextInputBuilder()
    .setCustomId("answer")
    .setLabel(isEditor ? "Your text" : "Your response")
    .setStyle(isEditor ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(4000);
  const placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
  if (placeholder) textInput.setPlaceholder(truncateDiscordText(placeholder, 100));
  const prefill = isEditor && typeof request.prefill === "string" ? truncateDiscordText(request.prefill, 4000) : "";
  if (prefill) textInput.setValue(prefill);

  const rawTitle = typeof request.title === "string" ? request.title.replace(/\s+/g, " ").trim() : "";
  const modalTitle = truncateDiscordText(rawTitle || (isEditor ? "Edit text" : "Your response"), 45);
  return new ModalBuilder()
    .setCustomId(`piui:${pending.token}:submit`)
    .setTitle(modalTitle)
    .addComponents(new ActionRowBuilder().addComponents(textInput));
}

async function handleGatewayUiInteraction(interaction) {
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
    const answer = action === "review-submit" ? "Submit response" : "Edit answer";
    await completeDiscordUiInteraction(pending, interaction, answer);
    return;
  }

  if (interaction.isButton?.() && ["prev", "next"].includes(action) && pending.method === "select") {
    const pageCount = Math.ceil(pending.options.length / 25);
    pending.page = action === "prev"
      ? Math.max(0, pending.page - 1)
      : Math.min(pageCount - 1, pending.page + 1);
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
      // The interaction may have expired; the pending prompt is still resolved below.
    }
    pending.finish(value);
    return;
  }

  await replyEphemeral(interaction, "That control doesn't match this prompt.");
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
    await interaction.update(buildDiscordUiPayload(pending, "Response received.", value));
    pending.finish(value, { updatePrompt: false });
  } catch {
    pending.finish(value);
  }
}

async function replyEphemeral(interaction, content) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch {
    // The interaction may have expired or already been acknowledged.
  }
}

function discordOptionLabel(value) {
  const label = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return truncateDiscordText(label || "(empty option)", 100);
}

function truncateDiscordText(value, maxLength) {
  let result = "";
  for (const character of String(value ?? "")) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

async function closeIdleSessions() {
  const now = Date.now();
  for (const [key, session] of piSessions) {
    if (!session.running && now - session.lastUsedAt >= SESSION_IDLE_MS) {
      piSessions.delete(key);
      await session.stop();
    }
  }
  while (piSessions.size > MAX_OPEN_SESSIONS) await closeLeastRecentlyUsedIdleSession();
}

async function closeLeastRecentlyUsedIdleSession() {
  let candidate;
  for (const [key, session] of piSessions) {
    if (!session.running && (!candidate || session.lastUsedAt < candidate.session.lastUsedAt)) {
      candidate = { key, session };
    }
  }
  if (!candidate) return;
  piSessions.delete(candidate.key);
  await candidate.session.stop();
}

function checkRestartRequest() {
  if (shuttingDown || restartRequested || !restartRequestPath || !existsSync(restartRequestPath)) return;

  let request;
  try {
    request = JSON.parse(readFileSync(restartRequestPath, "utf8"));
  } catch (error) {
    log(`Could not read gateway restart request: ${safeErrorName(error)}`);
    try { unlinkSync(restartRequestPath); } catch { /* best-effort cleanup */ }
    return;
  }
  if (request?.type !== "restart") {
    log("Ignored an invalid gateway control request");
    return;
  }

  restartRequested = true;
  updateStatus("restarting", { lastError: undefined });
  log(`Graceful restart requested${typeof request.reason === "string" && request.reason ? `: ${request.reason.slice(0, 200)}` : ""}; draining accepted messages`);
  maybeStartRequestedRestart();
}

function maybeStartRequestedRestart() {
  if (
    !restartRequested ||
    restartStarted ||
    shuttingDown ||
    activeMessageHandlers > 0 ||
    pendingMessageTasks > 0 ||
    activeRuns > 0 ||
    sessionQueues.size > 0
  ) {
    return;
  }

  restartStarted = true;
  void shutdown("Discord agent requested restart", 0, true).catch((error) => {
    const summary = `Gateway restart failed: ${safeErrorName(error)}`;
    log(summary);
    updateStatus("failed", { lastError: summary });
    removeOwnPid();
    process.exit(1);
  });
}

async function shutdown(reason, exitCode = 0, restart = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  const failureMessage = exitCode !== 0 ? gatewayStatus.lastError || "Gateway process terminated unexpectedly." : undefined;
  clearInterval(idleCleanupTimer);
  clearInterval(restartRequestPollTimer);
  if (!restart) updateStatus("stopping", { lastError: undefined });
  log(`Shutting down (${reason})`);
  for (const pending of pendingUiAnswers.values()) pending.finish(undefined);
  await Promise.all([...piSessions.values()].map((session) => session.stop()));
  piSessions.clear();

  if (restart && exitCode === 0) {
    try {
      const replacementPid = await spawnReplacementGateway();
      log(`Started replacement Discord gateway (PID ${replacementPid})`);
      await destroyDiscordClient();
      process.exit(0);
    } catch (error) {
      const summary = `Could not restart Discord gateway: ${error instanceof Error ? error.message : String(error)}`;
      log(summary);
      updateStatus("failed", { lastError: summary });
      await sendHomeNotification(`Discord gateway restart failed: ${summary}`);
      await destroyDiscordClient();
      removeOwnPid();
      process.exit(1);
    }
  }

  if (exitCode === 0) {
    updateStatus("stopped", { lastError: undefined });
    await sendHomeNotification("Discord gateway stopped.");
  } else {
    updateStatus("failed", { lastError: failureMessage });
    await sendHomeNotification(`Discord gateway failed: ${failureMessage}`);
  }
  await destroyDiscordClient();
  removeOwnPid();
  process.exit(exitCode);
}

async function destroyDiscordClient() {
  try {
    await client.destroy();
  } catch {
    // The Discord client may not have completed login.
  }
}

async function spawnReplacementGateway() {
  if (restartRequestPath && existsSync(restartRequestPath)) unlinkSync(restartRequestPath);
  const logFd = logPath ? openSync(logPath, "a", 0o600) : undefined;
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      detached: true,
      stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
      env: { ...process.env, PI_ENHANCED_DISCORD_START_REASON: "replacement" },
      windowsHide: true,
    });
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }

  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  if (!child.pid) throw new Error("replacement process did not receive a PID");
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("replacement process exited before initializing");
    }
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch {
      // The replacement has not written its startup status yet.
    }
    if (status?.pid === child.pid && status.state === "ready") return child.pid;
    if (status?.pid === child.pid && status.state === "failed") {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw new Error(status.lastError || "replacement process failed to initialize");
    }
    await delay(100);
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([onceExit(child), delay(3000)]);
  }
  throw new Error("replacement process did not initialize within 15 seconds");
}

function removeOwnPid() {
  try {
    const recordedPid = JSON.parse(readFileSync(pidPath, "utf8"))?.pid;
    if (recordedPid === process.pid) unlinkSync(pidPath);
  } catch {
    // The launcher or replacement process may have already changed the PID file.
  }
}

async function sendHomeNotification(text) {
  let homeChannelId = config.homeChannelId;
  try {
    const latestConfig = JSON.parse(readFileSync(configPath, "utf8"));
    homeChannelId = typeof latestConfig.homeChannelId === "string" && /^\d{17,20}$/.test(latestConfig.homeChannelId)
      ? latestConfig.homeChannelId
      : undefined;
  } catch {
    // Keep the in-memory destination when the config file is temporarily unavailable.
  }
  if (!homeChannelId) return;
  try {
    const channel = await client.channels.fetch(homeChannelId);
    if (!channel || typeof channel.send !== "function") {
      throw new Error("configured home channel is unavailable or cannot receive messages");
    }
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    log(`Sent home-channel notification: ${text}`);
  } catch (error) {
    log(`Could not send home-channel notification: ${safeErrorName(error)}`);
  }
}

function startTyping(channel) {
  let timer;
  let stopped = false;
  const send = () => channel.sendTyping?.().catch(() => undefined);
  const pause = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const resume = () => {
    if (stopped || timer) return;
    send();
    timer = setInterval(send, 8000);
    timer.unref?.();
  };
  resume();
  return {
    pause,
    resume,
    stop() {
      stopped = true;
      pause();
    },
  };
}

async function sendText(channel, text) {
  if (!channel?.send) return;
  for (const chunk of splitMessage(String(text || ""))) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

function splitMessage(text) {
  if (text.length <= DISCORD_TEXT_LIMIT) return [text || " "];
  const chunks = [];
  let remaining = text;
  while (remaining.length > DISCORD_TEXT_LIMIT) {
    let cut = remaining.lastIndexOf("\n", DISCORD_TEXT_LIMIT);
    if (cut < DISCORD_TEXT_LIMIT / 2) cut = DISCORD_TEXT_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function stripBotMention(content) {
  const botId = client.user?.id;
  if (!botId) return content.trim();
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function makeThreadName(username, prompt) {
  const summary = prompt.replace(/\s+/g, " ").trim();
  const name = summary ? `${username}: ${summary}` : `${username}: Pi conversation`;
  return name.slice(0, 95);
}

function watchThreadTitle(channel, session) {
  if (
    typeof channel?.isThread !== "function" ||
    !channel.isThread() ||
    typeof channel.setName !== "function" ||
    !threadRegistry[channel.id]?.createdAt ||
    threadRegistry[channel.id]?.generatedTitle ||
    pendingThreadTitleRenames.has(channel.id)
  ) {
    return;
  }

  pendingThreadTitleRenames.add(channel.id);
  void (async () => {
    const deadline = Date.now() + THREAD_TITLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (session.closed) return;
      try {
        const state = await session.request("get_state", {}, 5_000);
        const title = typeof state.data?.sessionName === "string" ? state.data.sessionName.trim() : "";
        if (title) {
          const threadName = Array.from(title).slice(0, 100).join("");
          if (channel.name !== threadName) await channel.setName(threadName);
          const registration = threadRegistry[channel.id];
          if (registration) {
            registration.generatedTitle = threadName;
            writeThreadRegistry();
          }
          log(`Renamed Discord thread ${channel.id} to generated session title`);
          return;
        }
      } catch {
        if (session.closed) return;
      }
      await delay(Math.min(THREAD_TITLE_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  })()
    .catch((error) => {
      log(`Could not rename Discord thread ${channel.id}: ${safeErrorName(error)}`);
    })
    .finally(() => pendingThreadTitleRenames.delete(channel.id));
}

function readThreadRegistry() {
  try {
    const value = JSON.parse(readFileSync(threadsPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeThreadRegistry() {
  writePrivateJson(threadsPath, threadRegistry);
}

function pruneThreadRegistry() {
  const entries = Object.entries(threadRegistry).sort((a, b) => String(b[1]?.createdAt).localeCompare(String(a[1]?.createdAt)));
  for (const [threadId] of entries.slice(5000)) delete threadRegistry[threadId];
}

function writeStatus() {
  gatewayStatus.updatedAt = new Date().toISOString();
  writePrivateJson(statusPath, gatewayStatus);
}

function updateStatus(state, fields = {}) {
  gatewayStatus = { ...gatewayStatus, ...fields, pid: process.pid, state, updatedAt: new Date().toISOString() };
  writeStatus();
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch {
    try { renameSync(tempPath, path); } catch { /* best-effort */ }
  }
}

function isValidAllowlist(value) {
  return Array.isArray(value) && value.length > 0 && (
    (value.length === 1 && value[0] === "*") ||
    value.every((entry) => typeof entry === "string" && /^\d{17,20}$/.test(entry))
  );
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeDiscordError(error) {
  const code = error && typeof error === "object" ? error.code || error.status : undefined;
  if (String(code) === "4014") return "Discord rejected a privileged Gateway Intent; enable Message Content Intent in the Developer Portal.";
  if (code) return `Discord error (code ${String(code).slice(0, 30)}). Check the bot token, intents, and permissions.`;
  return "Discord connection failed. Check the bot token, intents, and network connection.";
}

function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
