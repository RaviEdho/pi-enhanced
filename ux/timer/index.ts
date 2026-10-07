import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Formats elapsed seconds into concise duration string:
 * - < 60s: "20s"
 * - >= 60s and < 3600s: "1m 23s"
 * - >= 3600s: "1h 23m 40s"
 */
export function formatWorkingDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/**
 * Formats a token count into compact `k`/`M` notation (e.g. `950`, `1.2k`, `45k`, `2.5M`).
 */
export function formatTokenCount(count: number): string {
  const safe = Math.max(0, count);
  if (safe < 1000) return Math.round(safe).toString();
  if (safe < 10000) return `${(safe / 1000).toFixed(1)}k`;
  if (safe < 1000000) return `${Math.round(safe / 1000)}k`;
  if (safe < 10000000) return `${(safe / 1000000).toFixed(1)}M`;
  return `${Math.round(safe / 1000000)}M`;
}

/**
 * Formats a latency in milliseconds (e.g. `850ms`, `1.2s`).
 */
export function formatLatency(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  return `${(safe / 1000).toFixed(1)}s`;
}

/**
 * Formats a tokens-per-second rate with adaptive precision (`9.4`, `38`, `250`).
 */
export function formatTokenRate(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0";
  if (tokensPerSecond < 10) return tokensPerSecond.toFixed(1);
  return `${Math.round(tokensPerSecond)}`;
}

/** Rough characters-per-token ratio used to estimate streaming output before usage arrives. */
const CHARS_PER_TOKEN = 4;

/** Stream events that mark the first output token of a turn (text, thinking, or tool-call tokens). */
const FIRST_TOKEN_EVENTS = new Set([
  "text_start",
  "text_delta",
  "thinking_start",
  "thinking_delta",
  "toolcall_start",
  "toolcall_delta",
]);

interface TurnMetrics {
  /** Timestamp of the provider request (refined by `before_provider_request`). */
  requestStartMs: number;
  /** When the first output token of this turn arrived. */
  firstTokenMs?: number;
  /** Streamed content characters, used to estimate output tokens live. */
  chars: number;
  /** Provider-reported prompt tokens for this turn (input + cacheRead + cacheWrite). */
  usageInput: number;
  /** Provider-reported output tokens for this turn. */
  usageOutput: number;
}

/** Telemetry accumulated across every turn/call of a single agent run. */
export interface RunMetrics {
  startedAtMs: number;
  /** Cumulative prompt tokens (input + cache reads + cache writes). */
  input: number;
  /** Cumulative output tokens. */
  output: number;
  /** Sum of per-turn decode windows (first token to message end), excluding tool time. */
  decodeMs: number;
  /** Sum of every per-call time-to-first-token measurement. */
  ttftSumMs: number;
  /** Number of calls that produced a first token (TTFT samples). */
  callCount: number;
  /** Most recently measured time-to-first-token. */
  ttftMs?: number;
  turn: TurnMetrics;
}

/** Aggregated telemetry captured for a settled agent run, rendered after the final turn. */
export interface TurnSummary {
  /** Wall-clock duration of the whole run in milliseconds. */
  elapsedMs: number;
  /** Total prompt tokens (input + cache reads + cache writes). */
  input: number;
  /** Total output tokens. */
  output: number;
  /** Mean time-to-first-token across every model call in the run. */
  avgTtftMs?: number;
  /** Mean output tokens per second across the run's decode windows. */
  avgTps?: number;
  /** Number of model calls observed during the run. */
  calls: number;
}

/** Custom entry type used to persist a settled run's telemetry in the transcript. */
export const TURN_SUMMARY_ENTRY_TYPE = "pi-enhanced-turn-summary";

function createTurnMetrics(now: number): TurnMetrics {
  return { requestStartMs: now, chars: 0, usageInput: 0, usageOutput: 0 };
}

function createRunMetrics(now: number): RunMetrics {
  return {
    startedAtMs: now,
    input: 0,
    output: 0,
    decodeMs: 0,
    ttftSumMs: 0,
    callCount: 0,
    turn: createTurnMetrics(now),
  };
}

/**
 * Live output tokens for the active turn. Prefers provider usage once reported,
 * otherwise estimates from streamed characters.
 */
function liveTurnOutput(turn: TurnMetrics): number {
  return turn.usageOutput > 0 ? turn.usageOutput : Math.ceil(turn.chars / CHARS_PER_TOKEN);
}

/**
 * Builds the `Working (...)` status line with live turn telemetry appended:
 * elapsed time, cumulative tokens in/out, TTFT, and tokens per second.
 */
export function buildWorkingMessage(run: RunMetrics, now: number): string {
  const elapsedSeconds = Math.floor((now - run.startedAtMs) / 1000);
  const parts: string[] = [formatWorkingDuration(elapsedSeconds)];

  const totalInput = run.input + run.turn.usageInput;
  const totalOutput = run.output + liveTurnOutput(run.turn);

  const tokenParts: string[] = [];
  if (totalInput > 0) tokenParts.push(`↑${formatTokenCount(totalInput)}`);
  if (totalOutput > 0) tokenParts.push(`↓${formatTokenCount(totalOutput)}`);
  if (tokenParts.length > 0) parts.push(tokenParts.join(" "));

  if (run.ttftMs !== undefined) {
    parts.push(`TTFT ${formatLatency(run.ttftMs)}`);
  }

  const liveDecodeMs =
    run.turn.firstTokenMs !== undefined ? Math.max(0, now - run.turn.firstTokenMs) : 0;
  const totalDecodeMs = run.decodeMs + liveDecodeMs;
  if (totalDecodeMs > 0 && totalOutput > 0) {
    parts.push(`${formatTokenRate((totalOutput / totalDecodeMs) * 1000)} tok/s`);
  }

  return `Working (${parts.join(" · ")})`;
}

/**
 * Builds the settled-run telemetry summary from accumulated run metrics:
 * total elapsed time, total tokens in/out, average TTFT across every call, and
 * average decode throughput.
 */
export function buildTurnSummary(run: RunMetrics, now: number): TurnSummary {
  const elapsedMs = Math.max(0, now - run.startedAtMs);
  const avgTtftMs = run.callCount > 0 ? run.ttftSumMs / run.callCount : undefined;
  const avgTps = run.decodeMs > 0 && run.output > 0 ? (run.output / run.decodeMs) * 1000 : undefined;

  return {
    elapsedMs,
    input: run.input,
    output: run.output,
    avgTtftMs,
    avgTps,
    calls: run.callCount,
  };
}

/** Single-line, human-readable rendering of a settled-run telemetry summary. */
export function formatTurnSummary(summary: TurnSummary): string {
  const parts: string[] = [formatWorkingDuration(summary.elapsedMs / 1000)];

  const tokenParts: string[] = [];
  if (summary.input > 0) tokenParts.push(`↑${formatTokenCount(summary.input)}`);
  if (summary.output > 0) tokenParts.push(`↓${formatTokenCount(summary.output)}`);
  if (tokenParts.length > 0) parts.push(tokenParts.join(" "));

  if (summary.avgTtftMs !== undefined) {
    parts.push(`TTFT avg ${formatLatency(summary.avgTtftMs)}`);
  }
  if (summary.avgTps !== undefined) {
    parts.push(`${formatTokenRate(summary.avgTps)} tok/s avg`);
  }

  return parts.join(" · ");
}

/**
 * Registers a transcript renderer for settled-run telemetry. The summary is
 * stored as a session entry so it never enters the model's context. Rendered as
 * a dim, single-line status (matching Pi's `/reload` notice) rather than a boxed
 * card. The host adds the surrounding transcript spacing.
 */
export function registerTurnSummaryRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<TurnSummary>(TURN_SUMMARY_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const summary = entry.data;
    if (!summary) return undefined;

    const single = formatTurnSummary(summary);
    const lines = [theme.fg("dim", single)];

    if (expanded) {
      lines.push(theme.fg("dim", `${summary.calls} model call${summary.calls === 1 ? "" : "s"}`));
    }

    return new Text(lines.join("\n"), 1, 0);
  });
}

/**
 * Registers an agent timer hook that updates the working status text above the
 * input box with elapsed time and live turn telemetry, e.g.
 * `Working (20s · ↑15.2k ↓3.1k · TTFT 0.9s · 38 tok/s)`.
 *
 * Token totals sum across every turn and call of the current agent run and are
 * shown while the model is still working. Metrics reset once the run settles.
 */
export function registerWorkingTimer(pi: ExtensionAPI): void {
  registerTurnSummaryRenderer(pi);

  let timer: NodeJS.Timeout | undefined;
  let run: RunMetrics | undefined;
  let turnActive = false;

  const updateMessage = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !run) return;
    ctx.ui.setWorkingMessage(buildWorkingMessage(run, Date.now()));
  };

  const startTimer = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    updateMessage(ctx);
    if (!timer) {
      timer = setInterval(() => {
        updateMessage(ctx);
      }, 1000);
      timer.unref?.();
    }
  };

  const pauseTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const endRun = (ctx: ExtensionContext) => {
    pauseTimer();
    run = undefined;
    turnActive = false;
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  };

  pi.on("agent_start", async (_event, ctx) => {
    if (!run) {
      run = createRunMetrics(Date.now());
    }
    startTimer(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const now = Date.now();
    if (!run) {
      run = createRunMetrics(now);
    }
    run.turn = createTurnMetrics(now);
    turnActive = true;
    startTimer(ctx);
  });

  // Refine the request start time as close to dispatch as possible for TTFT.
  pi.on("before_provider_request", async () => {
    if (!run || !turnActive) return;
    run.turn.requestStartMs = Date.now();
  });

  pi.on("message_update", async (event, ctx) => {
    if (!run) return;
    const message = event.message;
    if (message.role !== "assistant") return;

    const turn = run.turn;
    const streamEvent = event.assistantMessageEvent;

    if (turn.firstTokenMs === undefined && FIRST_TOKEN_EVENTS.has(streamEvent.type)) {
      const now = Date.now();
      turn.firstTokenMs = now;
      run.ttftMs = Math.max(0, now - turn.requestStartMs);
      run.ttftSumMs += run.ttftMs;
      run.callCount += 1;
      updateMessage(ctx);
    }

    if (
      streamEvent.type === "text_delta" ||
      streamEvent.type === "thinking_delta" ||
      streamEvent.type === "toolcall_delta"
    ) {
      turn.chars += streamEvent.delta.length;
    }

    const usage = message.usage;
    if (usage) {
      const promptTokens =
        (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      if (promptTokens > 0) turn.usageInput = promptTokens;
      if (usage.output > 0) turn.usageOutput = usage.output;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!run) return;
    const message = event.message;
    if (message.role !== "assistant") return;

    const turn = run.turn;
    const usage = message.usage;

    run.input += (usage?.input || 0) + (usage?.cacheRead || 0) + (usage?.cacheWrite || 0);
    // Fall back to the streamed-character estimate when the provider omits usage.
    run.output += usage?.output && usage.output > 0 ? usage.output : liveTurnOutput(turn);

    if (turn.firstTokenMs !== undefined) {
      run.decodeMs += Math.max(0, Date.now() - turn.firstTokenMs);
      run.ttftMs = Math.max(0, turn.firstTokenMs - turn.requestStartMs);
    }

    // Finalize this turn; the next `turn_start` begins a fresh live window.
    run.turn = createTurnMetrics(Date.now());
    turnActive = false;
    updateMessage(ctx);
  });

  pi.on("turn_end", async () => {
    turnActive = false;
  });

  // `agent_end` may be followed by a retry or continuation within the same run,
  // so keep accumulated metrics and only stop the refresh interval here.
  pi.on("agent_end", async () => {
    pauseTimer();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (run) {
      const summary = buildTurnSummary(run, Date.now());
      // Only report runs that actually produced model output.
      if (summary.calls > 0 || summary.output > 0 || summary.input > 0) {
        pi.appendEntry<TurnSummary>(TURN_SUMMARY_ENTRY_TYPE, summary);
      }
    }
    endRun(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    endRun(ctx);
  });
}
