import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AccountBalancer, isAccountEligibleForModel } from "../../accounts/balancer.js";
import { DEFAULT_CACHE_TTL_MS, QuotaManager } from "../../accounts/quota.js";
import { AccountStore } from "../../accounts/store.js";
import { fetchOllamaCloudUsage, getOllamaCredentialId, getOllamaFallbackAuth } from "./ollama-cloud.js";
import { cloudflareCacheKey, fetchCloudflareUsage, getCloudflareConnection } from "./cloudflare.js";
import { PlanModeManager } from "../plan/manager.js";
import { EnhancedSettingsStore } from "../settings/store.js";
import {
  computeTimeElapsedFraction,
  makeProgressBar,
} from "./format.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";
import { normalizeWindowToken, quotaWindowShortLabel, QUOTA_WINDOW } from "./windows.js";

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

interface KeyBuckets {
  primary?: QuotaBucket;
  secondary: QuotaBucket[];
  balances: QuotaBucket[];
}

/** Resolve durations for ordering only; never invent a marker interval. */
function quotaWindowSeconds(bucket: QuotaBucket): number {
  if (bucket.windowSeconds && Number.isFinite(bucket.windowSeconds) && bucket.windowSeconds > 0) {
    return bucket.windowSeconds;
  }
  const window = normalizeWindowToken(bucket.window);
  if (window === QUOTA_WINDOW.monthly) return 30 * 86400;
  if (window === QUOTA_WINDOW.weekly) return 7 * 86400;
  if (window === QUOTA_WINDOW.daily) return 86400;
  const duration = window.match(/^(\d+)-(hour|day)$/);
  return duration ? Number(duration[1]) * (duration[2] === "hour" ? 3600 : 86400) : 0;
}

function extractKeyBuckets(report: ProviderUsageReport, modelId?: string): KeyBuckets {
  const all = report.groups.flatMap((group) => group.buckets).filter(
    (bucket) => report.providerId !== "ollama-cloud" || bucket.displayMode !== "value" || bucket.balanceUsd !== 0
  );
  const isBalance = (bucket: QuotaBucket): boolean => {
    const window = normalizeWindowToken(bucket.window);
    return bucket.displayMode === "value" ||
      [QUOTA_WINDOW.prepaid, QUOTA_WINDOW.balance, QUOTA_WINDOW.coupon, QUOTA_WINDOW.onDemand].some((value) => value === window);
  };
  const balances = all.filter(isBalance);
  let windows = all.filter((bucket) => !isBalance(bucket));

  if (report.providerId === "google-antigravity") {
    const model = (modelId || "").toLowerCase();
    const prefix = model.includes("claude") || model.includes("gpt") ? "3p" : "gemini";
    const filtered = windows.filter((bucket) => bucket.bucketId.toLowerCase().includes(prefix));
    windows = filtered;
  } else if (report.providerId === "openai-codex") {
    // Shared chat limits only, excluding feature-specific quotas.
    windows = windows.filter((bucket) => bucket.bucketId === "codex-primary" || bucket.bucketId === "codex-secondary");
  }

  windows.sort((a, b) => quotaWindowSeconds(b) - quotaWindowSeconds(a));
  return { primary: windows[0], secondary: windows.slice(1), balances };
}

/**
 * Builds Line 1:
 * - Left: PWD (gitBranch)
 * - Far Right: Model ID • thinking: level
 */
function renderFooterLine1(
  ctx: ExtensionContext,
  branch: string | null,
  theme: ExtensionContext["ui"]["theme"],
  width: number
): string {
  const modeIndicator = PlanModeManager.getInstance().getModeIndicator(theme, ctx.thinkingLevel);
  const cwd = formatCwd(
    ctx.sessionManager?.getCwd?.() || process.cwd(),
    process.env.HOME || process.env.USERPROFILE
  );
  const branchStr = branch ? ` (${branch})` : "";
  const leftDetails = theme.fg("dim", ` • ${cwd}${branchStr}`);
  const leftText = `${modeIndicator}${leftDetails}`;

  // Right-side: Model and thinking effort
  const model = ctx.model;
  let rightText = "";
  if (model) {
    const thinkingLevel = ctx.thinkingLevel;
    const hasThinking = thinkingLevel && thinkingLevel !== "off";

    const modelDisplay = model.id;
    const thinkingDisplay = hasThinking ? ` • ${thinkingLevel}` : "";

    rightText = theme.fg("dim", `${modelDisplay}${thinkingDisplay}`);
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

  return line;
}

function formatFooterCountdown(resetTime: string, now: number): string {
  const totalMinutes = Math.floor(Math.max(0, Date.parse(resetTime) - now) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d${String(hours).padStart(2, "0")}h`;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function bucketWindowLabel(bucket: QuotaBucket): string {
  if (bucket.bucketId === "cloudflare-neurons") return "free";
  const window = normalizeWindowToken(bucket.window);
  if (window === QUOTA_WINDOW.default && !quotaWindowSeconds(bucket)) return bucket.displayName;
  return quotaWindowShortLabel(window, bucket.windowSeconds) || bucket.displayName;
}

/**
 * Renders the stable budget bar and secondary countdowns for windows with usage.
 */
function renderProgressBar(
  primary: QuotaBucket,
  secondaries: QuotaBucket[] | undefined,
  now: number,
  theme: ExtensionContext["ui"]["theme"]
): string {
  const usedPct = Math.round(primary.usedFraction * 100);
  const timeElapsed = computeTimeElapsedFraction(
    primary.resetTime,
    primary.windowSeconds,
    now,
    primary.bucketId === "cloudflare-neurons" || primary.bucketId === "ollama-cloud-included" ? undefined : primary.usedFraction
  );
  const progressBar = makeProgressBar(primary.usedFraction, 10, timeElapsed, false);
  const resetSegment = primary.resetTime && Number.isFinite(Date.parse(primary.resetTime))
    ? ` (${formatFooterCountdown(primary.resetTime, now)})`
    : "";

  let secondarySegment = "";
  const sortedSecondaries = [...(secondaries ?? [])].sort(
    (a, b) => quotaWindowSeconds(b) - quotaWindowSeconds(a)
  );
  for (const secondary of sortedSecondaries) {
    if (secondary.usedFraction <= 0) continue;
    const secPct = Math.round(secondary.usedFraction * 100);
    const secLabel = bucketWindowLabel(secondary);
    const countdown =
      secondary.usedFraction > 0 &&
      secondary.resetTime &&
      Number.isFinite(Date.parse(secondary.resetTime))
        ? ` (${formatFooterCountdown(secondary.resetTime, now)})`
        : "";
    const text = `${secLabel}: ${secPct}%${countdown}`;
    const color = secondary.usedFraction >= 0.95 ? "error" :
      secondary.usedFraction >= 0.8 ? "warning" : undefined;
    secondarySegment += ` · ${color ? theme.fg(color, text) : text}`;
  }

  const primaryLabel = bucketWindowLabel(primary);
  return `${primaryLabel} [${progressBar}] ${usedPct}%${resetSegment}${secondarySegment}`;
}

/** Render quota and named value balances together for every provider. */
function renderUsageReport(
  report: ProviderUsageReport,
  prefix: string,
  modelId: string,
  now: number,
  theme: ExtensionContext["ui"]["theme"]
): string {
  if (report.error && report.groups.length === 0) return `${prefix}  Quota unavailable`;
  const { primary, secondary, balances } = extractKeyBuckets(report, modelId);
  const parts: string[] = [];
  if (primary) parts.push(renderProgressBar(primary, secondary, now, theme));
  for (const balance of balances) {
    const value = balance.description || (balance.balanceUsd !== undefined ? `$${balance.balanceUsd.toFixed(2)}` : "unavailable");
    parts.push(`${balance.displayName}: ${value}`);
  }
  if (!parts.length && report.providerId !== "ollama-cloud") {
    const summary = report.capacitySummaryShort || report.capacitySummary;
    if (summary) parts.push(summary);
  }
  if (parts.length) return `${prefix}  ${parts.join(" · ")}`;
  if (report.providerId === "ollama-cloud" && report.groups.length > 0) return prefix;
  return `${prefix}  ${report.error || report.quotaUnavailableReason ? "Quota unavailable" : "No quota limits reported"}`;
}

/**
 * Builds Line 2 Right Side: Active account usage bar.
 */
function buildUsageBar(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "";

  if (model.provider === "cloudflare-workers-ai") {
    const connection = getCloudflareConnection();
    if (!connection) return "";
    const report = QuotaManager.getInstance().getReport(cloudflareCacheKey(connection));
    return report ? renderUsageReport(report, "Cloudflare", model.id, Date.now(), ctx.ui.theme) : "Cloudflare  ···";
  }
  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id);

  if (!account) {
    if (model.provider !== "ollama-cloud") return "";
    const auth = getOllamaFallbackAuth();
    if (!auth) return "";
    const report = QuotaManager.getInstance().getReport(`ollama-cloud-fallback:${getOllamaCredentialId(auth.token)}`);
    return report ? renderUsageReport(report, auth.label, model.id, Date.now(), ctx.ui.theme) : `${auth.label}  ···`;
  }

  const prefix = account.provider === "ollama-cloud" ? (account.email || account.label || "Ollama Cloud") : (account.email || account.id);

  const now = Date.now();
  // Check 429 cooldown
  if (account.blockedUntil && account.blockedUntil > now) {
    const remainingSec = Math.ceil((account.blockedUntil - now) / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const cooldownStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    return `${prefix}  [COOLDOWN ~${cooldownStr}]`;
  }

  if (account.provider === "openai" && account.type === "oauth") {
    return `${prefix}  Quota unavailable (/usage)`;
  }

  const report = QuotaManager.getInstance().getReport(account.id);
  if (!report) {
    return `${prefix}  ···`;
  }

  return renderUsageReport(report, prefix, model.id, now, ctx.ui.theme);
}

/**
 * Builds the left statistics string (tokens, cache hits, cost, context window)
 * respecting the configured usage.contextFormat ("pi", "pi-enhanced", or "off").
 */
function buildStatsLeft(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"]
): string {
  // Compute session token usage, cache hit rate, and cost
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestCacheHitRate: number | undefined;

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

        const latestPromptTokens = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
        latestCacheHitRate =
          latestPromptTokens > 0 ? ((m.usage.cacheRead || 0) / latestPromptTokens) * 100 : undefined;
      }
    }
  }

  const statParts: string[] = [];
  if (input > 0) statParts.push(`↑${formatTokens(input)}`);
  if (output > 0) statParts.push(`↓${formatTokens(output)}`);
  if (cacheRead > 0) statParts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite > 0) statParts.push(`W${formatTokens(cacheWrite)}`);
  if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
    statParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (cost > 0) {
    statParts.push(formatCost(cost));
  }

  const contextFormat = EnhancedSettingsStore.getInstance().get("usage.contextFormat");
  if (contextFormat !== "off") {
    const contextUsage = ctx.getContextUsage?.();
    if (contextUsage && contextUsage.contextWindow > 0) {
      const contextPercentValue = contextUsage.percent ?? 0;
      let displayStr: string;

      if (contextFormat === "pi") {
        // Native Pi format: percentage / capacity (e.g. 23.5%/200k)
        const pct =
          contextUsage.percent != null ? contextPercentValue.toFixed(1) : "?";
        displayStr = `${pct}%/${formatTokens(contextUsage.contextWindow)}`;
      } else {
        // pi-enhanced format: raw token count / capacity (e.g. 45k/200k)
        const tokensStr =
          contextUsage.tokens != null ? formatTokens(contextUsage.tokens) : "?";
        displayStr = `${tokensStr}/${formatTokens(contextUsage.contextWindow)}`;
      }

      // Colorize based on usage threshold (matching Pi native conventions)
      if (contextPercentValue > 90) {
        statParts.push(theme.fg("error", displayStr));
      } else if (contextPercentValue > 70) {
        statParts.push(theme.fg("warning", displayStr));
      } else {
        statParts.push(displayStr);
      }
    }
  }

  return statParts.join(" ");
}

/**
 * Builds the standard directory line (matching Pi native layout Line 1):
 * - pwd (branch)
 */
function renderStandardPwdLine(
  ctx: ExtensionContext,
  branch: string | null,
  theme: ExtensionContext["ui"]["theme"],
  width: number
): string {
  const modeIndicator = PlanModeManager.getInstance().getModeIndicator(theme, ctx.thinkingLevel);
  const cwd = formatCwd(
    ctx.sessionManager?.getCwd?.() || process.cwd(),
    process.env.HOME || process.env.USERPROFILE
  );
  const branchStr = branch ? ` (${branch})` : "";
  const leftDetails = theme.fg("dim", ` • ${cwd}${branchStr}`);
  const pwd = `${modeIndicator}${leftDetails}`;
  return truncateToWidth(pwd, width, theme.fg("dim", "..."));
}

/**
 * Builds the standard single-line status footer (matching Pi native layout),
 * displaying statistics on the left and active model/reasoning on the right.
 */
function renderStandardFooterLine(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider | undefined,
  theme: ExtensionContext["ui"]["theme"],
  width: number
): string {
  const statsLeft = buildStatsLeft(ctx, theme);
  const statsLeftWidth = visibleWidth(statsLeft);

  const model = ctx.model;
  const modelName = model?.id || "no-model";
  let rightSideWithoutProvider = modelName;

  if (model?.reasoning) {
    const thinkingLevel = ctx.thinkingLevel || "off";
    rightSideWithoutProvider =
      thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
  }

  let rightSide = rightSideWithoutProvider;
  if (footerData && footerData.getAvailableProviderCount() > 1 && model) {
    const candidate = `(${model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + 2 + visibleWidth(candidate) <= width) {
      rightSide = candidate;
    }
  }

  const rightSideWidth = visibleWidth(rightSide);
  const minPadding = 2;

  if (statsLeftWidth + minPadding + rightSideWidth <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
    return theme.fg("dim", statsLeft) + padding + theme.fg("dim", rightSide);
  }

  const availRight = width - statsLeftWidth - minPadding;
  if (availRight > 10) {
    const truncatedRight = truncateToWidth(rightSide, availRight, "");
    const padding = " ".repeat(Math.max(1, width - statsLeftWidth - visibleWidth(truncatedRight)));
    return theme.fg("dim", statsLeft) + padding + theme.fg("dim", truncatedRight);
  }

  return theme.fg("dim", truncateToWidth(statsLeft, width));
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
  const leftText = buildStatsLeft(ctx, theme);
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

async function refreshCloudflare(): Promise<void> {
  const connection = getCloudflareConnection();
  if (!connection) return;
  const report = await fetchCloudflareUsage(connection);
  QuotaManager.getInstance().setReport(cloudflareCacheKey(connection), report);
}

async function refreshOllamaFallback(): Promise<void> {
  const auth = getOllamaFallbackAuth();
  if (!auth) return;
  const report = await fetchOllamaCloudUsage(auth.token, auth.label, AbortSignal.timeout(5000));
  QuotaManager.getInstance().setReport(`ollama-cloud-fallback:${getOllamaCredentialId(auth.token)}`, report);
}

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
  if (model.provider === "cloudflare-workers-ai") return refreshCloudflare();

  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();
  const allAccounts = store.list(model.provider);
  const candidates = allAccounts.filter(
    (acc) => !acc.disabledCause && isAccountEligibleForModel(acc, model.id)
  );
  if (candidates.length === 0) {
    if (model.provider === "ollama-cloud") await refreshOllamaFallback();
    return;
  }

  const quotaManager = QuotaManager.getInstance();
  const maxAgeMs = force ? 0 : DEFAULT_CACHE_TTL_MS;

  await Promise.allSettled(
    candidates.map(async (account) => {
      try {
        const token = account.provider === "openai" && account.type === "oauth"
          ? account.access || ""
          : account.provider === "ollama-cloud" && account.apiKey ? account.apiKey : await balancer.ensureFreshToken(account);
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
  if (model.provider === "cloudflare-workers-ai") return refreshCloudflare();

  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id);
  if (!account) {
    if (model.provider === "ollama-cloud") await refreshOllamaFallback();
    return;
  }

  const quotaManager = QuotaManager.getInstance();
  try {
    const token = account.provider === "openai" && account.type === "oauth"
      ? account.access || ""
      : account.provider === "ollama-cloud" && account.apiKey ? account.apiKey : await balancer.ensureFreshToken(account);
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
 * - Line 1: Directory on left, Model ID & thinking level on far right.
 * - Line 2: Token stats on left, Active account usage bar on far right (under model).
 * Also registers automated background quota monitoring (idle polling, tool_call throttled checks,
 * turn settlement refreshes, and model selection updates).
 */
export function registerUsageFooter(pi: ExtensionAPI): void {
  let activeTui: { requestRender: () => void } | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let currentCtx: ExtensionContext | undefined;
  let lastToolCheckAt = 0;

  // Re-render UI immediately whenever QuotaManager stores fresh quota reports or settings change
  QuotaManager.getInstance().onQuotaUpdate(() => {
    if (EnhancedSettingsStore.getInstance().get("usage.showFooter")) {
      activeTui?.requestRender();
    }
  });

  EnhancedSettingsStore.getInstance().onChange((_settings, changedKey) => {
    if (!changedKey || changedKey === "usage.showFooter" || changedKey === "usage.contextFormat") {
      activeTui?.requestRender();
    }
  });

  // Re-render UI immediately whenever Plan Mode / Implement Mode changes
  PlanModeManager.getInstance().onModeChange(() => {
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
        invalidate() {
          tui.requestRender();
        },
        render(width: number): string[] {
          const showQuotaFooter = EnhancedSettingsStore.getInstance().get("usage.showFooter");
          const branch = footerData?.getGitBranch?.() ?? null;
          const lines: string[] = [];

          if (showQuotaFooter) {
            const line1 = renderFooterLine1(ctx, branch, theme, width);
            const line2 = renderFooterLine2(ctx, theme, width);
            lines.push(line1, line2);
          } else {
            const line1 = renderStandardPwdLine(ctx, branch, theme, width);
            const line2 = renderStandardFooterLine(ctx, footerData, theme, width);
            lines.push(line1, line2);
          }

          // Include other extension statuses if present
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

  pi.on("before_agent_start", (_event, ctx) => {
    currentCtx = ctx;
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
