import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AccountBalancer, isAccountEligibleForModel } from "../../accounts/balancer.js";
import { DEFAULT_CACHE_TTL_MS, QuotaManager } from "../../accounts/quota.js";
import { AccountStore } from "../../accounts/store.js";
import { isProviderNetworkEnabled } from "../../providers/network.js";
import { GIT_COMMAND_FINISHED } from "../../tools/git/events.js";
import { fetchOllamaCloudUsage, getOllamaCredentialId, getOllamaFallbackAuth } from "./ollama-cloud.js";
import { getInferHubUsageFailure } from "./inferhub.js";
import { getOpenCodeGoEnvAccount, isOpenCodeGoEndpoint, OPENCODE_GO_ID } from "../../providers/opencode-go/credentials.js";
import { getOpenCodeGoUsageFailure } from "./opencode-go.js";
import { PlanModeManager } from "../plan/manager.js";
import { EnhancedSettingsStore } from "../settings/store.js";
import { makeProgressBar } from "./format.js";
import { FooterStatsCache, type FooterStats } from "./stats.js";
import { formatGitStatus, GitStatusMonitor, type GitStatus } from "./git-status.js";
import { balanceDisplayValue, bucketTimeElapsed, hasValidReset, isValueBucket } from "./buckets.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";
import { fallbackUsageIdentity, usageAccountIdentity } from "./identity.js";
import { normalizeWindowToken, quotaWindowSeconds as resolveWindowSeconds, quotaWindowShortLabel, QUOTA_WINDOW } from "./windows.js";

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
  return resolveWindowSeconds(bucket.window, bucket.windowSeconds);
}

function extractKeyBuckets(report: ProviderUsageReport, modelId?: string): KeyBuckets {
  const all = report.groups.flatMap((group) => group.buckets);
  const balances = all.filter((bucket) => isValueBucket(bucket) && (bucket.balanceAmount ?? bucket.balanceUsd) !== 0);
  let windows = all.filter((bucket) => !isValueBucket(bucket));

  if (report.providerId === "google-antigravity") {
    const model = (modelId || "").toLowerCase();
    const prefix = model.includes("claude") || model.includes("gpt") ? "3p" : "gemini";
    const filtered = windows.filter((bucket) => bucket.bucketId.toLowerCase().includes(prefix));
    windows = filtered;
  } else if (report.providerId === "openai-codex") {
    // Shared chat limits only, excluding feature-specific quotas.
    windows = windows.filter((bucket) => bucket.bucketId === "codex-primary" || bucket.bucketId === "codex-secondary");
  } else if (report.providerId === "tokenharbor") {
    // Account Pass usage is not evidence that a paid model is Pass-covered.
    // Keep free and Pass allowances distinct; never show a free budget for paid calls.
    const bucketId = modelId?.endsWith(":free") ? "tokenharbor-free" : "tokenharbor-pass";
    windows = windows.filter((bucket) => bucket.bucketId === bucketId);
  }

  windows.sort((a, b) => quotaWindowSeconds(b) - quotaWindowSeconds(a));
  return { primary: windows[0], secondary: windows.slice(1), balances };
}

/** Fit mode, directory, Git and (with quota enabled) model on one line. */
function renderFooterLine1(
  ctx: ExtensionContext,
  gitStatus: GitStatus | undefined,
  fallbackBranch: string | null,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  showModel: boolean,
): string {
  if (width <= 0) return "";
  const manager = PlanModeManager.getInstance();
  const level = ctx.thinkingLevel;
  const modeIcon = () => manager.getModeIndicator(theme, level, true);
  let mode = manager.getModeIndicator(theme, level);
  let cwd = formatCwd(
    ctx.sessionManager?.getCwd?.() || process.cwd(),
    process.env.HOME || process.env.USERPROFILE,
  );
  let separator = " • ";
  let gitDetails = formatGitStatus(gitStatus, fallbackBranch, theme);
  let model = showModel ? ctx.model?.id || "" : "";
  let reasoning = model && level && level !== "off" ? ` • ${level}` : "";
  const gap = 2;

  const directory = () => cwd ? `${separator}${cwd}` : "";
  const leftWidth = () => visibleWidth(mode) + visibleWidth(directory()) + visibleWidth(gitDetails);
  const fits = () => leftWidth() + (model ? gap + visibleWidth(model + reasoning) : 0) <= width;

  // Drop optional elements whole, in order, before shortening either side.
  if (!fits() && !manager.isEnabled()) mode = modeIcon();
  if (!fits()) gitDetails = formatGitStatus(undefined, gitStatus?.branch || fallbackBranch, theme);
  if (!fits()) gitDetails = "";
  if (!fits()) reasoning = "";
  if (!fits()) separator = " ";

  if (!fits()) {
    // Preserve the final path component; only replace the parent path.
    const folder = basename(cwd) || cwd;
    const abbreviated = `...${sep}${folder}`;
    cwd = visibleWidth(abbreviated) < visibleWidth(cwd) ? abbreviated : folder;
    if (leftWidth() > width) cwd = folder;
    if (leftWidth() > width) mode = modeIcon();
    if (leftWidth() > width) cwd = "";
    if (!fits()) {
      const available = width - leftWidth() - gap;
      model = truncateToWidth(model, available, available > 1 ? "…" : "");
    }
  }

  const left = mode + (cwd ? theme.fg("dim", directory()) : "") + gitDetails;
  const right = model + reasoning;
  return right
    ? left + " ".repeat(width - leftWidth() - visibleWidth(right)) + theme.fg("dim", right)
    : left;
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
  const window = normalizeWindowToken(bucket.window);
  if (window === QUOTA_WINDOW.default && !quotaWindowSeconds(bucket)) return bucket.displayName;
  const label = quotaWindowShortLabel(window, bucket.windowSeconds) || bucket.displayName;
  return bucket.bucketId === "tokenharbor-pass" ? `Pass ${label}`
    : bucket.bucketId === "tokenharbor-free" ? `Free ${label}` : label;
}

function quotaTimer(bucket: QuotaBucket, now: number): string {
  return bucket.resetTime && hasValidReset(bucket) ? ` (${formatFooterCountdown(bucket.resetTime, now)})` : "";
}

interface FooterUsage {
  account: string;
  primary?: QuotaBucket;
  secondary?: QuotaBucket[];
  details?: string[];
  message?: string;
}

/** Keep the account, windows and ancillary details separate for responsive layout. */
function describeUsageReport(report: ProviderUsageReport, account: string, modelId: string): FooterUsage {
  if (report.error && report.groups.length === 0) {
    return { account, message: report.providerId === "inferhub" ? "Balance unavailable" : "Quota unavailable" };
  }
  const { primary, secondary, balances } = extractKeyBuckets(report, modelId);
  const details: string[] = [];
  if (primary) {
    if (primary.enabled === false) details.push("disabled");
    else if (primary.exhausted === true) details.push("exhausted");
    else if (primary.exhausted === false && primary.usedFraction >= 1) details.push("not exhausted");
  }
  for (const balance of balances) {
    details.push(`${balance.displayName}: ${balanceDisplayValue(balance) || "unavailable"}`);
  }
  if (primary || details.length) {
    return { account, primary, secondary: secondary.filter((bucket) => bucket.usedFraction > 0), details };
  }
  const hasZeroBalance = report.groups.some((group) => group.buckets.some((bucket) =>
    isValueBucket(bucket) && (bucket.balanceAmount ?? bucket.balanceUsd) === 0
  ));
  if (hasZeroBalance || (report.providerId === "ollama-cloud" && report.groups.length > 0)) return { account };
  const summary = report.providerId === "ollama-cloud" ? undefined : report.capacitySummaryShort || report.capacitySummary;
  const message = summary || (report.error || report.quotaUnavailableReason ? "Quota unavailable" : "No quota limits reported");
  return { account, message };
}

/** Look up the active account's cached quota data; layout never triggers a refresh. */
function getFooterUsage(ctx: ExtensionContext, now: number): FooterUsage | undefined {
  const model = ctx.model;
  if (!model) return;

  const isGo = model.provider === OPENCODE_GO_ID;
  if (isGo && !isOpenCodeGoEndpoint(model.baseUrl)) return;
  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id)
    ?? (isGo ? getOpenCodeGoEnvAccount() : undefined);

  if (!account) {
    if (model.provider !== "ollama-cloud") return;
    const auth = getOllamaFallbackAuth(250);
    if (!auth) return;
    const key = `ollama-cloud-fallback:${getOllamaCredentialId(auth.token)}`;
    const report = QuotaManager.getInstance().getReport(key);
    const identity = fallbackUsageIdentity(auth.label, auth.token);
    return report ? describeUsageReport(report, identity, model.id)
      : { account: identity, message: isProviderNetworkEnabled() ? "···" : "offline" };
  }

  const prefix = usageAccountIdentity(account);
  // Check 429 cooldown
  if (account.blockedUntil && account.blockedUntil > now) {
    const remainingSec = Math.ceil((account.blockedUntil - now) / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const cooldownStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    return { account: prefix, message: `[COOLDOWN ~${cooldownStr}]` };
  }

  const report = QuotaManager.getInstance().getReport(account.id)
    ?? (account.provider === "inferhub" && account.apiKey ? getInferHubUsageFailure(account.apiKey) : undefined)
    ?? (isGo && account.apiKey ? getOpenCodeGoUsageFailure(account.apiKey) : undefined);
  return report ? describeUsageReport(report, prefix, model.id)
    : { account: prefix, message: isProviderNetworkEnabled() ? "···" : "offline" };
}

interface FooterStatParts {
  tokens: string;
  cache: string;
  hitRate: string;
  cost: string;
  context: string;
}

function formatStats({ tokens, cache, hitRate, cost, context }: FooterStatParts): string {
  return [tokens, cache, hitRate, cost, context].filter(Boolean).join(" ");
}

function buildStatsParts(stats: FooterStats, theme: ExtensionContext["ui"]["theme"]): FooterStatParts {
  const { input, output, cacheRead, cacheWrite, cost, latestCacheHitRate, contextUsage } = stats;
  const tokens = [input > 0 ? `↑${formatTokens(input)}` : "", output > 0 ? `↓${formatTokens(output)}` : ""];
  const cache = [cacheRead > 0 ? `R${formatTokens(cacheRead)}` : "", cacheWrite > 0 ? `W${formatTokens(cacheWrite)}` : ""];
  const parts: FooterStatParts = {
    tokens: tokens.filter(Boolean).join(" "),
    cache: cache.filter(Boolean).join(" "),
    hitRate: (cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined ? `CH${latestCacheHitRate.toFixed(1)}%` : "",
    cost: cost > 0 ? formatCost(cost) : "",
    context: "",
  };
  const contextFormat = EnhancedSettingsStore.getInstance().get("usage.contextFormat");
  if (contextFormat !== "off") {
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
        parts.context = theme.fg("error", displayStr);
      } else if (contextPercentValue > 70) {
        parts.context = theme.fg("warning", displayStr);
      } else {
        parts.context = displayStr;
      }
    }
  }

  return parts;
}

/**
 * Builds the standard single-line status footer (matching Pi native layout),
 * displaying statistics on the left and active model/reasoning on the right.
 */
function renderStandardFooterLine(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider | undefined,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  stats: FooterStats
): string {
  const statsLeft = formatStats(buildStatsParts(stats, theme));
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

/** Keep quota fields intact as the terminal narrows, then make room on the stats side. */
function renderFooterLine2(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  stats: FooterStats
): string {
  if (width <= 0) return "";
  const now = Date.now();
  const usage = getFooterUsage(ctx, now);
  const statParts = buildStatsParts(stats, theme);
  const primary = usage?.primary;
  let left = formatStats(statParts);
  let account = usage?.account ?? "";
  let details = usage?.details ?? [];
  let message = usage?.message ?? "";
  let primaryTimer = primary ? quotaTimer(primary, now) : "";
  const primaryLabel = primary ? bucketWindowLabel(primary) : "";
  const primaryPercent = primary ? `${Math.round(primary.usedFraction * 100)}%` : "";
  const elapsed = primary ? bucketTimeElapsed(primary, now) : undefined;
  let bar = primary ? makeProgressBar(primary.usedFraction, 10, elapsed) : "";
  let compact = false;
  let gap = 2;

  const secondary = (usage?.secondary ?? []).map((bucket) => ({
    text: `${bucketWindowLabel(bucket)}: ${Math.round(bucket.usedFraction * 100)}%`,
    timer: quotaTimer(bucket, now),
    color: bucket.usedFraction >= 0.95 ? "error" as const : bucket.usedFraction >= 0.8 ? "warning" as const : undefined,
  }));
  const renderRight = () => {
    const parts = primary ? [compact ? `${primaryLabel}${bar}${primaryPercent}`
      : `${primaryLabel} [${bar}] ${primaryPercent}${primaryTimer}`] : [];
    for (const { text, timer, color } of secondary) parts.push(color ? theme.fg(color, text + timer) : text + timer);
    if (message) parts.push(message);
    return [account, parts.concat(details).join(" · ")].filter(Boolean).join("  ");
  };
  let right = "";
  const fits = () => {
    right = renderRight();
    return visibleWidth(left) + (left && right ? gap : 0) + visibleWidth(right) <= width;
  };
  const shrinkStats = (fitsStats: () => boolean) => {
    for (const field of ["hitRate", "cache", "tokens", "cost"] as const) {
      if (fitsStats()) break;
      statParts[field] = "";
      left = formatStats(statParts);
    }
  };

  if (!fits()) account = "";
  if (!fits()) details = [];
  while (secondary.length && !fits()) {
    const shortest = secondary[secondary.length - 1];
    if (shortest.timer) shortest.timer = "";
    else secondary.pop();
  }
  if (primary && !fits()) primaryTimer = "";

  if (primary) {
    shrinkStats(fits);
    if (!fits()) {
      // First shrink the standard widget, then use an unbracketed widget on tiny
      // terminals. Keep the full label and percentage even on the compact bar.
      for (let size = 9; size >= 4 && !fits(); size--) bar = makeProgressBar(primary.usedFraction, size, elapsed);
      if (!fits()) {
        compact = true;
        gap = 1;
        for (let size = 4; size >= 1; size--) {
          bar = makeProgressBar(primary.usedFraction, size, elapsed);
          if (fits()) break;
        }
      }
    }
    if (!fits()) right = ""; // The terminal cannot fit both: keep context size.
  } else if (!fits()) {
    shrinkStats(() => visibleWidth(left) <= width);
    message = truncateToWidth(message, width - visibleWidth(left) - (left ? gap : 0));
    right = renderRight();
  }

  // Style the two sides separately so that a context warning's reset cannot
  // cancel the foreground style of the quota on the right.
  if (!right) return theme.fg("dim", truncateToWidth(left, width));
  const pad = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
  return (left ? theme.fg("dim", left) : "") + pad + theme.fg("dim", right);
}

const RUNNING_CACHE_TTL_MS = 15 * 1000; // 15 seconds cache TTL while model is active
const TOOL_CALL_THROTTLE_MS = 15 * 1000; // Throttle tool call quota checks to once every 15s
const IDLE_POLL_INTERVAL_MS = 2 * 60 * 1000; // Background idle quota poll every 2 minutes

async function refreshOllamaFallback(): Promise<void> {
  if (!isProviderNetworkEnabled()) return;
  const auth = getOllamaFallbackAuth();
  if (!auth) return;
  await QuotaManager.getInstance().refreshReport(
    `ollama-cloud-fallback:${getOllamaCredentialId(auth.token)}`,
    () => fetchOllamaCloudUsage(auth.token, fallbackUsageIdentity(auth.label, auth.token), AbortSignal.timeout(5000)), 60_000,
  );
}

/**
 * Triggers a non-blocking background quota refresh for all eligible candidate accounts
 * of the currently active model provider.
 */
async function refreshCandidateAccounts(
  ctx: ExtensionContext,
  force: boolean = false
): Promise<void> {
  if (!isProviderNetworkEnabled()) return;
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
  if (model.provider === OPENCODE_GO_ID) {
    if (!isOpenCodeGoEndpoint(model.baseUrl)) return;
    const envAccount = allAccounts.length === 0 ? getOpenCodeGoEnvAccount() : undefined;
    if (envAccount) allAccounts.push(envAccount);
  }
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
        const token = account.provider === "ollama-cloud" && account.apiKey ? account.apiKey : await balancer.ensureFreshToken(account);
        await quotaManager.ensureFreshQuota(
          account,
          token,
          account.provider === OPENCODE_GO_ID ? undefined : AbortSignal.timeout(5000),
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
  if (!isProviderNetworkEnabled()) return;
  let model;
  try {
    model = ctx.model;
  } catch {
    return;
  }
  if (!model) return;

  const balancer = AccountBalancer.getInstance();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const isGo = model.provider === OPENCODE_GO_ID;
  if (isGo && !isOpenCodeGoEndpoint(model.baseUrl)) return;
  const account = balancer.getSessionAccount(model.provider, sessionId, model.id)
    ?? (isGo ? getOpenCodeGoEnvAccount() : undefined);
  if (!account) {
    if (model.provider === "ollama-cloud") await refreshOllamaFallback();
    return;
  }

  const quotaManager = QuotaManager.getInstance();
  try {
    const token = account.provider === "ollama-cloud" && account.apiKey ? account.apiKey : await balancer.ensureFreshToken(account);
    await quotaManager.ensureFreshQuota(
      account,
      token,
      isGo ? undefined : AbortSignal.timeout(5000),
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
  let gitMonitor: GitStatusMonitor | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let currentCtx: ExtensionContext | undefined;
  let lastToolCheckAt = 0;
  const statsCache = new FooterStatsCache();
  pi.on("message_end", () => { statsCache.invalidate(); });
  // A virtual model can route to a different context limit without model_select.
  pi.on("before_provider_request", () => { statsCache.invalidate(); });
  pi.on("session_compact", () => { statsCache.invalidate(); });
  pi.on("session_tree", () => { statsCache.invalidate(); });

  // Re-render UI immediately whenever QuotaManager stores fresh quota reports or settings change
  const unsubscribeQuota = QuotaManager.getInstance().onQuotaUpdate(() => {
    if (EnhancedSettingsStore.getInstance().get("usage.showFooter")) {
      activeTui?.requestRender();
    }
  });

  const unsubscribeSettings = EnhancedSettingsStore.getInstance().onChange((_settings, changedKey) => {
    if (!changedKey || changedKey === "usage.showFooter" || changedKey === "usage.contextFormat") {
      activeTui?.requestRender();
    }
  });

  // Re-render UI immediately whenever Plan Mode / Implement Mode changes
  const unsubscribeMode = PlanModeManager.getInstance().onModeChange(() => {
    activeTui?.requestRender();
  });

  function refreshQuota(ctx: ExtensionContext, refresh: Promise<void>): void {
    void refresh.then(() => {
      // A failed first Go lookup doesn't publish a successful cache update.
      if (currentCtx === ctx && ctx.model?.provider === OPENCODE_GO_ID) activeTui?.requestRender();
    }).catch(() => {});
  }

  function applyFooter(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      gitMonitor?.dispose();
      const monitor = new GitStatusMonitor(ctx.sessionManager.getCwd(), () => tui.requestRender());
      gitMonitor = monitor;
      monitor.start();
      const unsub = footerData?.onBranchChange?.(() => {
        monitor.scheduleRefresh();
        tui.requestRender();
      });

      return {
        dispose() {
          statsCache.invalidate();
          unsub?.();
          monitor.dispose();
          if (gitMonitor === monitor) gitMonitor = undefined;
          if (activeTui === tui) {
            activeTui = undefined;
          }
        },
        invalidate() {
          tui.requestRender();
        },
        render(width: number): string[] {
          const settings = EnhancedSettingsStore.getInstance();
          const showQuotaFooter = settings.get("usage.showFooter");
          const stats = statsCache.read(ctx, settings.get("usage.contextFormat") !== "off");
          const line1 = renderFooterLine1(
            ctx, monitor.status, footerData?.getGitBranch?.() ?? null, theme, width, showQuotaFooter,
          );
          const line2 = showQuotaFooter
            ? renderFooterLine2(ctx, theme, width, stats)
            : renderStandardFooterLine(ctx, footerData, theme, width, stats);
          const lines = [line1, line2];

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
    statsCache.invalidate();
    currentCtx = ctx;
    applyFooter(ctx);

    // Non-blocking fresh parallel check for all candidate accounts on startup
    refreshQuota(ctx, refreshCandidateAccounts(ctx, true));

    // Periodic idle background check every 2 minutes
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (currentCtx && currentCtx.isIdle()) {
        refreshQuota(currentCtx, refreshCandidateAccounts(currentCtx, false));
      }
    }, IDLE_POLL_INTERVAL_MS);
    idleTimer.unref?.();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    statsCache.invalidate();
    currentCtx = ctx;
  });

  pi.on("tool_call", (_event, ctx) => {
    currentCtx = ctx;
    const now = Date.now();
    if (now - lastToolCheckAt >= TOOL_CALL_THROTTLE_MS) {
      lastToolCheckAt = now;
      refreshQuota(ctx, refreshSessionAccountQuota(ctx, RUNNING_CACHE_TTL_MS));
    }
    return undefined;
  });

  const unsubscribeGitCommand = pi.events.on(GIT_COMMAND_FINISHED, () => { gitMonitor?.scheduleRefresh(); });
  pi.on("tool_execution_end", () => { gitMonitor?.scheduleRefresh(); });

  pi.on("agent_settled", (_event, ctx) => {
    gitMonitor?.scheduleRefresh();
    statsCache.invalidate();
    currentCtx = ctx;
    // Turn completed: always trigger fresh quota fetch to capture latest token consumption
    refreshQuota(ctx, refreshSessionAccountQuota(ctx, 0));
  });

  pi.on("model_select", (_event, ctx) => {
    statsCache.invalidate();
    currentCtx = ctx;
    // Non-blocking fresh parallel check for new model's candidate accounts
    refreshQuota(ctx, refreshCandidateAccounts(ctx, true));
  });

  pi.on("session_shutdown", () => {
    gitMonitor?.dispose();
    gitMonitor = undefined;
    statsCache.invalidate();
    unsubscribeQuota();
    unsubscribeSettings();
    unsubscribeMode();
    unsubscribeGitCommand();
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    currentCtx = undefined;
    activeTui = undefined;
  });
}
