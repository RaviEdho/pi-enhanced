import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AccountBalancer, isAccountEligibleForModel } from "../accounts/balancer.js";
import { DEFAULT_CACHE_TTL_MS, QuotaManager } from "../accounts/quota.js";
import { AccountStore } from "../accounts/store.js";
import {
  computeTimeElapsedFraction,
  formatRelativeTime,
  makeProgressBar,
} from "./format.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCost(cost: number): string {
  if (cost <= 0) return "$0";
  if (cost >= 0.001) {
    return `$${cost.toFixed(3)}`;
  }
  // For small costs under 0.001 (e.g. 0.0004), dynamically determine decimal places to show significant digits
  const decimals = Math.min(6, Math.max(4, -Math.floor(Math.log10(cost))));
  return `$${cost.toFixed(decimals)}`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Extracts primary and secondary quota buckets for the active model.
 */
function extractKeyBuckets(
  report: ProviderUsageReport,
  modelId?: string
): { primary?: QuotaBucket; secondary?: QuotaBucket } {
  const cleanModel = (modelId || "").toLowerCase();
  const allBuckets = report.groups.flatMap((g) => g.buckets);
  if (allBuckets.length === 0) {
    return {};
  }

  let relevant = allBuckets;
  if (report.providerId === "hyper") {
    const hyperBucket = allBuckets.find((b) => b.bucketId === "hypercredits");
    if (hyperBucket) {
      return { primary: hyperBucket };
    }
  } else if (report.providerId === "google-antigravity") {
    const isClaudeOrGpt = cleanModel.includes("claude") || cleanModel.includes("gpt");
    const targetPrefix = isClaudeOrGpt ? "3p" : "gemini";
    const filtered = allBuckets.filter((b) =>
      b.bucketId.toLowerCase().includes(targetPrefix)
    );
    if (filtered.length > 0) {
      relevant = filtered;
    }
  }

  // Identify longest window (weekly) as primary, or fallback to first
  let primary = relevant.find(
    (b) =>
      b.bucketId.toLowerCase().includes("weekly") ||
      (b.windowSeconds && b.windowSeconds >= 6 * 86400)
  );
  if (!primary) {
    primary = relevant[0];
  }

  // Identify short-term burst window (e.g. 5h or daily) as secondary
  const secondary = relevant.find(
    (b) =>
      b !== primary &&
      (b.bucketId.toLowerCase().includes("5h") ||
        b.bucketId.toLowerCase().includes("short") ||
        b.bucketId.toLowerCase().includes("daily") ||
        (b.windowSeconds && b.windowSeconds <= 86400))
  );

  return { primary, secondary };
}

/**
 * Builds Line 1:
 * - Left: PWD (gitBranch) • sessionName
 * - Far Right: Model ID • thinking: level
 */
function renderFooterLine1(
  ctx: ExtensionContext,
  branch: string | null,
  theme: ExtensionContext["ui"]["theme"],
  width: number
): string {
  const cwd = formatCwd(
    ctx.sessionManager?.getCwd?.() || process.cwd(),
    process.env.HOME || process.env.USERPROFILE
  );
  const branchStr = branch ? ` (${branch})` : "";
  const sessionName = ctx.sessionManager?.getSessionName?.();
  const sessionStr = sessionName ? ` • ${sessionName}` : "";
  const leftText = `${cwd}${branchStr}${sessionStr}`;

  // Right-side: Model and thinking effort
  const model = ctx.model;
  let rightText = "";
  if (model) {
    const thinkingLevel = ctx.thinkingLevel;
    const hasThinking = thinkingLevel && thinkingLevel !== "off";

    const modelDisplay = model.id;
    const thinkingDisplay = hasThinking ? ` • ${thinkingLevel}` : "";

    rightText = `${modelDisplay}${thinkingDisplay}`;
  }

  const leftW = visibleWidth(leftText);
  const rightW = visibleWidth(rightText);
  const totalW = leftW + rightW;

  let line = "";
  if (totalW + 2 <= width) {
    const pad = " ".repeat(width - leftW - rightW);
    line = leftText + pad + rightText;
  } else {
    const availRight = width - leftW - 2;
    if (availRight > 8) {
      const truncatedRight = truncateToWidth(rightText, availRight, "");
      const pad = " ".repeat(Math.max(1, width - leftW - visibleWidth(truncatedRight)));
      line = leftText + pad + truncatedRight;
    } else {
      line = truncateToWidth(leftText, width);
    }
  }

  return theme.fg("dim", line);
}

/**
 * Builds Line 2 Right Side: Active account usage bar.
 */
function buildUsageBar(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "";

  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id);

  if (!account) {
    return "";
  }

  const prefix = account.email ? account.email : account.id;

  const now = Date.now();
  // Check 429 cooldown
  if (account.blockedUntil && account.blockedUntil > now) {
    const remainingSec = Math.ceil((account.blockedUntil - now) / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const cooldownStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    return `${prefix}  [COOLDOWN ~${cooldownStr}]`;
  }

  const report = QuotaManager.getInstance().getReport(account.id);
  if (!report || report.groups.length === 0) {
    return `${prefix}  ···`;
  }

  const { primary, secondary } = extractKeyBuckets(report, model.id);
  if (!primary) {
    return `${prefix}  No quota limits reported`;
  }

  const usedPct = Math.round(primary.usedFraction * 100);
  const timeElapsed = computeTimeElapsedFraction(
    primary.resetTime,
    primary.windowSeconds,
    now,
    primary.usedFraction
  );
  const progressBar = makeProgressBar(primary.usedFraction, 10, timeElapsed, false);

  const barSegment = `[${progressBar}] ${usedPct}%`;

  const resetSegment = primary.resetTime
    ? primary.usedFraction <= 0 && (timeElapsed === 0 || timeElapsed === undefined)
      ? " (ready)"
      : ` (${formatRelativeTime(primary.resetTime, now)})`
    : "";

  let secondarySegment = "";
  if (secondary) {
    const secPct = Math.round(secondary.usedFraction * 100);
    const secLabel = secondary.window || "5h";
    secondarySegment = ` · ${secLabel}: ${secPct}%`;
  }

  let summarySegment = "";
  if (report.providerId === "hyper" && report.capacitySummary) {
    summarySegment = ` · ${report.capacitySummary}`;
  }

  return `${prefix}  ${barSegment}${resetSegment}${secondarySegment}${summarySegment}`;
}

/**
 * Builds Line 2:
 * - Left: ↑input ↓output Rcache Wcache $cost context%/contextWindow
 * - Far Right (under model name): ⚡ account [████████░░░┃░░░] 52% (2d14h)
 */
function renderFooterLine2(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number
): string {
  // Compute session token usage, cache hit rate, and cost
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  const entries = ctx.sessionManager?.getBranch?.() || [];
  for (const e of entries) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      if (m.usage) {
        input += m.usage.input || 0;
        output += m.usage.output || 0;
        cacheRead += m.usage.cacheRead || 0;
        cacheWrite += m.usage.cacheWrite || 0;
        cost += m.usage.cost?.total || 0;
      }
    }
  }

  const statParts: string[] = [];
  if (input > 0) statParts.push(`↑${formatTokens(input)}`);
  if (output > 0) statParts.push(`↓${formatTokens(output)}`);
  if (cacheRead > 0) statParts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite > 0) statParts.push(`W${formatTokens(cacheWrite)}`);
  if (cacheRead > 0 || cacheWrite > 0) {
    const totalPrompt = input + cacheRead + cacheWrite;
    if (totalPrompt > 0) {
      const hitRate = ((cacheRead / totalPrompt) * 100).toFixed(0);
      statParts.push(`CH${hitRate}%`);
    }
  }
  if (cost > 0) {
    statParts.push(formatCost(cost));
  }

  const contextUsage = ctx.getContextUsage?.();
  if (contextUsage && contextUsage.contextWindow > 0) {
    const tokensStr =
      contextUsage.tokens != null ? formatTokens(contextUsage.tokens) : "?";
    statParts.push(`${tokensStr}/${formatTokens(contextUsage.contextWindow)}`);
  }

  const leftText = statParts.join(" ");
  const rightText = buildUsageBar(ctx);

  const leftW = visibleWidth(leftText);
  const rightW = visibleWidth(rightText);
  const totalW = leftW + rightW;

  let line = "";
  if (totalW + 2 <= width) {
    const pad = " ".repeat(width - leftW - rightW);
    line = leftText + pad + rightText;
  } else {
    const availRight = width - leftW - 2;
    if (availRight > 10) {
      const truncatedRight = truncateToWidth(rightText, availRight, "");
      const pad = " ".repeat(Math.max(1, width - leftW - visibleWidth(truncatedRight)));
      line = leftText + pad + truncatedRight;
    } else {
      line = truncateToWidth(leftText, width);
    }
  }

  return theme.fg("dim", line);
}

const RUNNING_CACHE_TTL_MS = 15 * 1000; // 15 seconds cache TTL while model is active
const TOOL_CALL_THROTTLE_MS = 15 * 1000; // Throttle tool call quota checks to once every 15s
const IDLE_POLL_INTERVAL_MS = 2 * 60 * 1000; // Background idle quota poll every 2 minutes

/**
 * Triggers a non-blocking background quota refresh for all eligible candidate accounts
 * of the currently active model provider.
 */
async function refreshCandidateAccounts(
  ctx: ExtensionContext,
  force: boolean = false
): Promise<void> {
  let model;
  try {
    model = ctx.model;
  } catch {
    return;
  }
  if (!model) return;

  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();
  const allAccounts = store.list(model.provider);
  const candidates = allAccounts.filter(
    (acc) => !acc.disabledCause && isAccountEligibleForModel(acc, model.id)
  );
  if (candidates.length === 0) return;

  const quotaManager = QuotaManager.getInstance();
  const maxAgeMs = force ? 0 : DEFAULT_CACHE_TTL_MS;

  await Promise.allSettled(
    candidates.map(async (account) => {
      try {
        const token = await balancer.ensureFreshToken(account);
        await quotaManager.ensureFreshQuota(
          account,
          token,
          AbortSignal.timeout(5000),
          maxAgeMs
        );
      } catch {
        // Non-fatal background refresh error
      }
    })
  );
}

/**
 * Triggers a non-blocking background quota refresh for the currently active session account.
 */
async function refreshSessionAccountQuota(
  ctx: ExtensionContext,
  maxAgeMs: number = 0
): Promise<void> {
  let model;
  try {
    model = ctx.model;
  } catch {
    return;
  }
  if (!model) return;

  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id);
  if (!account) return;

  const quotaManager = QuotaManager.getInstance();
  try {
    const token = await balancer.ensureFreshToken(account);
    await quotaManager.ensureFreshQuota(
      account,
      token,
      AbortSignal.timeout(5000),
      maxAgeMs
    );
  } catch {
    // Non-fatal background refresh
  }
}

/**
 * Registers the custom footer displaying:
 * - Line 1: Directory & session on left, Model ID & thinking level on far right.
 * - Line 2: Token stats on left, Active account usage bar on far right (under model).
 * Also registers automated background quota monitoring (idle polling, tool_call throttled checks,
 * turn settlement refreshes, and model selection updates).
 */
export function registerUsageFooter(pi: ExtensionAPI): void {
  let activeTui: { requestRender: () => void } | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let currentCtx: ExtensionContext | undefined;
  let lastToolCheckAt = 0;

  // Re-render UI immediately whenever QuotaManager stores fresh quota reports
  QuotaManager.getInstance().onQuotaUpdate(() => {
    activeTui?.requestRender();
  });

  function applyFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsub = footerData?.onBranchChange?.(() => tui.requestRender());

      return {
        dispose() {
          unsub?.();
          if (activeTui === tui) {
            activeTui = undefined;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const branch = footerData?.getGitBranch?.() ?? null;
          const line1 = renderFooterLine1(ctx, branch, theme, width);
          const line2 = renderFooterLine2(ctx, theme, width);

          const lines: string[] = [line1, line2];

          // Include other extension statuses on Line 3 if present
          const extensionStatuses = footerData?.getExtensionStatuses?.();
          if (extensionStatuses && extensionStatuses.size > 0) {
            const sorted = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text);
            lines.push(theme.fg("dim", truncateToWidth(sorted.join(" "), width)));
          }

          return lines;
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    applyFooter(ctx);

    // Non-blocking fresh parallel check for all candidate accounts on startup
    void refreshCandidateAccounts(ctx, true);

    // Periodic idle background check every 2 minutes
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (currentCtx && currentCtx.isIdle()) {
        void refreshCandidateAccounts(currentCtx, false);
      }
    }, IDLE_POLL_INTERVAL_MS);
    idleTimer.unref?.();
  });

  pi.on("tool_call", (_event, ctx) => {
    currentCtx = ctx;
    const now = Date.now();
    if (now - lastToolCheckAt >= TOOL_CALL_THROTTLE_MS) {
      lastToolCheckAt = now;
      void refreshSessionAccountQuota(ctx, RUNNING_CACHE_TTL_MS);
    }
    return undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentCtx = ctx;
    // Turn completed: always trigger fresh quota fetch to capture latest token consumption
    void refreshSessionAccountQuota(ctx, 0);
  });

  pi.on("model_select", (_event, ctx) => {
    currentCtx = ctx;
    // Non-blocking fresh parallel check for new model's candidate accounts
    void refreshCandidateAccounts(ctx, true);
  });

  pi.on("session_shutdown", () => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    currentCtx = undefined;
    activeTui = undefined;
  });
}
