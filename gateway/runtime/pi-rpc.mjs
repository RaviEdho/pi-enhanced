import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "./logging.mjs";

/** One Pi child process and its newline-delimited RPC transport. */
export class PiRpcSession {
  constructor(sessionDirectory, { config, piExecutable, piArgs, interactions }) {
    this.sessionDirectory = sessionDirectory;
    this.config = config;
    this.piExecutable = piExecutable;
    this.piArgs = piArgs;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.counter = 0;
    this.pendingRequests = new Map();
    this.runWaiter = undefined;
    this.interaction = undefined;
    this.closed = false;
    this.running = false;
    this.lastUsedAt = Date.now();
    this.ui = interactions.createSessionUi(this);
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
      ...this.piArgs,
      "--mode", "rpc",
      "--session-dir", this.sessionDirectory,
      "--continue",
      "--approve",
    ];
    if (this.config.model?.provider && this.config.model?.id) {
      sessionArgs.push("--model", `${this.config.model.provider}/${this.config.model.id}`);
    }
    if (this.config.thinkingLevel) sessionArgs.push("--thinking", this.config.thinkingLevel);

    this.child = spawn(this.piExecutable, sessionArgs, {
      cwd: this.config.cwd,
      env: agentEnvironment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Pi process exited (${signal || code || "unknown"})`));
      void this.ui.close();
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
      void this.ui.handleRequest(record).catch(() => {
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

  async promptAndWait(message, interaction, images = []) {
    if (this.running) throw new Error("Pi session received overlapping prompts");
    await this.ui.flushPendingAskUserCompletion();
    this.running = true;
    this.lastUsedAt = Date.now();
    this.interaction = interaction;
    this.ui.resetPrompt();
    try {
      const settledPromise = new Promise((resolve, reject) => {
        this.runWaiter = { resolve, reject };
      });
      void settledPromise.catch(() => undefined);
      const accepted = await this.request("prompt", { message, ...(images.length > 0 ? { images } : {}) }, 30_000);
      if (!accepted.success) throw new Error("Pi rejected the Discord message");
      if (accepted.data?.disposition === "handled") return "";
      const settled = await settledPromise;
      if (settled.aborted) return "The agent run was cancelled.";
      const response = await this.request("get_last_assistant_text", {}, 30_000);
      if (!response.success) throw new Error("Could not retrieve the agent response");
      return typeof response.data?.text === "string" ? response.data.text : "";
    } finally {
      if (this.runWaiter) this.runWaiter = undefined;
      await this.ui.flushPendingAskUserCompletion();
      await this.ui.clearStatusMessages();
      this.interaction = undefined;
      this.running = false;
      this.lastUsedAt = Date.now();
    }
  }

  sendUiResponse(id, response) {
    if (!this.child?.stdin.writable || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
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
    this.fail(new Error("Pi RPC session stopped"));
    await this.ui.close();
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

export function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
