import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { AccountBalancer } from "../accounts/balancer.js";
import { QuotaManager } from "../accounts/quota.js";
import { AccountStore } from "../accounts/store.js";
import { fetchAntigravityUsage } from "./antigravity.js";
import { fetchCodexUsage } from "./codex.js";
import { buildUsageLines, formatUsageText } from "./format.js";
import { fetchHyperUsage } from "./hyper.js";
import type { ProviderUsageReport, SessionUsageInfo } from "./types.js";

interface StoredAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  projectId?: string;
  email?: string;
  accountId?: string;
}

export interface CollectUsageOptions {
  signal?: AbortSignal;
  sessionId?: string;
  currentProvider?: string;
  currentModelId?: string;
}

export interface CollectUsageResult {
  reports: ProviderUsageReport[];
  sessionInfo?: SessionUsageInfo;
}

/**
 * Loads all configured credentials from ~/.pi/agent/auth.json as fallback.
 */
function loadConfiguredAuth(): Record<string, StoredAuthEntry> {
  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(authPath)) return {};
  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredAuthEntry>;
    }
  } catch {
    // Ignore read errors
  }
  return {};
}

/**
 * Fetches usage reports for all active and standby accounts across providers,
 * identifying the account in use for the current session.
 */
export async function collectUsageReports(
  options?: CollectUsageOptions
): Promise<CollectUsageResult> {
  const store = AccountStore.getInstance();
  store.sync();
  const balancer = AccountBalancer.getInstance();
  const reports: ProviderUsageReport[] = [];
  const signal = options?.signal;

  const antigravityAccounts = store.list("google-antigravity");
  const codexAccounts = store.list("openai-codex");
  const hyperAccounts = store.list("hyper");

  // 1. Google Antigravity multi-account fetch in parallel
  const isAntigravityActive = options?.currentProvider === "google-antigravity";
  const antigravityPromises: Promise<ProviderUsageReport>[] = [];
  if (antigravityAccounts.length > 0) {
    const sessionAccount = isAntigravityActive
      ? balancer.getSessionAccount(
          "google-antigravity",
          options?.sessionId,
          options?.currentModelId
        )
      : undefined;
    for (const acc of antigravityAccounts) {
      if (signal?.aborted) break;
      const isSession = isAntigravityActive && sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const label = acc.email || acc.id;

      antigravityPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchAntigravityUsage(
              token,
              acc.projectId || "aicode-consumers",
              label,
              signal,
              acc.planType
            );
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            report.accountEmail = label;
            report.cooldownMinutes = isCooldown ? mins : undefined;
            if (report.planType && report.planType !== acc.planType) {
              acc.planType = report.planType;
              acc.updatedAt = Date.now();
              store.upsert(acc);
            }
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "google-antigravity",
              providerName: "Google Antigravity",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              cooldownMinutes: isCooldown ? mins : undefined,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const antigravity = authMap["google-antigravity"];
    if (antigravity?.access && antigravity.projectId) {
      antigravityPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchAntigravityUsage(
            antigravity.access!,
            antigravity.projectId!,
            antigravity.email,
            signal
          );
          report.isSessionAccount = isAntigravityActive;
          return report;
        })()
      );
    }
  }

  // 2. OpenAI Codex multi-account fetch in parallel
  const isCodexActive = options?.currentProvider === "openai-codex";
  const codexPromises: Promise<ProviderUsageReport>[] = [];
  if (codexAccounts.length > 0) {
    const sessionAccount = isCodexActive
      ? balancer.getSessionAccount(
          "openai-codex",
          options?.sessionId,
          options?.currentModelId
        )
      : undefined;
    for (const acc of codexAccounts) {
      if (signal?.aborted) break;
      const isSession = isCodexActive && sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const label = acc.email || acc.accountId || acc.id;

      codexPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchCodexUsage({
              accessToken: token,
              accountId: acc.accountId,
              email: label,
              refreshToken: acc.refresh,
              signal,
            });
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            report.accountEmail = label;
            report.cooldownMinutes = isCooldown ? mins : undefined;
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "openai-codex",
              providerName: "OpenAI Codex",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              cooldownMinutes: isCooldown ? mins : undefined,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const codex = authMap["openai-codex"];
    if (codex?.access) {
      codexPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchCodexUsage({
            accessToken: codex.access!,
            accountId: codex.accountId,
            email: codex.email,
            refreshToken: codex.refresh,
            signal,
          });
          report.isSessionAccount = isCodexActive;
          return report;
        })()
      );
    }
  }

  // 3. Charm Hyper multi-account fetch in parallel
  const isHyperActive = options?.currentProvider === "hyper";
  const hyperPromises: Promise<ProviderUsageReport>[] = [];
  if (hyperAccounts.length > 0) {
    const sessionAccount = isHyperActive
      ? balancer.getSessionAccount(
          "hyper",
          options?.sessionId,
          options?.currentModelId
        )
      : undefined;
    for (const acc of hyperAccounts) {
      if (signal?.aborted) break;
      const isSession = isHyperActive && sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const label = acc.email || acc.orgName || acc.id;

      hyperPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchHyperUsage(
              token,
              label,
              signal,
              acc.planType
            );
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            report.accountEmail = label;
            report.cooldownMinutes = isCooldown ? mins : undefined;
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "hyper",
              providerName: "Charm Hyper",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              cooldownMinutes: isCooldown ? mins : undefined,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json or HYPER_API_KEY
    const authMap = loadConfiguredAuth();
    const hyperAuth = authMap["hyper"];
    const fallbackToken = hyperAuth?.access || hyperAuth?.key || process.env.HYPER_API_KEY;
    if (fallbackToken) {
      hyperPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchHyperUsage(
            fallbackToken,
            hyperAuth?.email || "default",
            signal
          );
          report.isSessionAccount = isHyperActive;
          return report;
        })()
      );
    }
  }

  // Await all provider account queries concurrently
  const settled = await Promise.allSettled([
    ...antigravityPromises,
    ...codexPromises,
    ...hyperPromises,
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      reports.push(s.value);
    }
  }

  // Compute active session account info
  let sessionInfo: SessionUsageInfo | undefined;
  if (options?.currentProvider) {
    const account = balancer.getSessionAccount(
      options.currentProvider,
      options.sessionId,
      options.currentModelId
    );
    sessionInfo = {
      sessionId: options.sessionId,
      providerId: options.currentProvider,
      modelId: options.currentModelId,
      accountEmail: account?.email || account?.accountId || account?.id,
      accountId: account?.id,
    };
  }

  return { reports, sessionInfo };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatKeyHint(theme: any, key: string, label: string): string {
  const dim = theme?.fg ? theme.fg("dim", key) : `\x1b[2m${key}\x1b[22m`;
  const muted = theme?.fg ? theme.fg("muted", ` ${label}`) : `\x1b[90m ${label}\x1b[39m`;
  return `${dim}${muted}`;
}

export interface UsageViewerOptions {
  sessionId?: string;
  currentProvider?: string;
  currentModelId?: string;
}

/**
 * Interactive fullscreen/modal component rendering provider quotas and rate limits
 * with live in-place refresh, keyboard scrolling, and native Pi visual hierarchy.
 */
export class UsageViewerComponent implements Component {
  private tui: TUI;
  private theme: any;
  private keybindings?: any;
  private onDone: () => void;
  private options: UsageViewerOptions;

  private loading = true;
  private refreshing = false;
  private errorMsg?: string;
  private reports: ProviderUsageReport[] = [];
  private sessionInfo?: SessionUsageInfo;
  private fetchedAt = 0;
  private frameIndex = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private ageTimer?: NodeJS.Timeout;
  private abortController = new AbortController();
  private scrollTop = 0;

  constructor(
    tui: TUI,
    theme: any,
    keybindings: any,
    onDone: () => void,
    options: UsageViewerOptions
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
    this.options = options;

    this.startSpinner();
    this.fetchReports();
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, 80);
    this.spinnerTimer.unref?.();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private startAgeTimer(): void {
    if (this.ageTimer) return;
    this.ageTimer = setInterval(() => {
      this.tui.requestRender();
    }, 1000);
    this.ageTimer.unref?.();
  }

  private stopAgeTimer(): void {
    if (this.ageTimer) {
      clearInterval(this.ageTimer);
      this.ageTimer = undefined;
    }
  }

  private cleanup(): void {
    this.stopSpinner();
    this.stopAgeTimer();
  }

  private async fetchReports(isRefresh = false): Promise<void> {
    if (isRefresh) {
      this.stopAgeTimer();
      this.refreshing = true;
      this.startSpinner();
      this.tui.requestRender();
    } else {
      this.loading = true;
    }

    try {
      const res = await collectUsageReports({
        signal: this.abortController.signal,
        sessionId: this.options.sessionId,
        currentProvider: this.options.currentProvider,
        currentModelId: this.options.currentModelId,
      });

      if (!this.abortController.signal.aborted) {
        this.reports = res.reports;
        this.sessionInfo = res.sessionInfo;
        this.fetchedAt = Date.now();
        this.errorMsg = undefined;
        this.loading = false;
        this.refreshing = false;
        this.stopSpinner();
        this.startAgeTimer();
        this.tui.requestRender();
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.errorMsg = err instanceof Error ? err.message : String(err);
        this.loading = false;
        this.refreshing = false;
        this.stopSpinner();
        this.startAgeTimer();
        this.tui.requestRender();
      }
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTop += delta;
    this.tui.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "q" ||
      data === "\x1b" ||
      data === "\x03" ||
      (this.keybindings &&
        typeof this.keybindings.matches === "function" &&
        (this.keybindings.matches(data, "app.interrupt") ||
          this.keybindings.matches(data, "app.clear") ||
          this.keybindings.matches(data, "tui.select.cancel") ||
          this.keybindings.matches(data, "cancel")))
    ) {
      this.cleanup();
      this.abortController.abort();
      this.onDone();
      return true;
    }

    // Live refresh
    if (data.toLowerCase() === "r") {
      if (!this.loading && !this.refreshing) {
        this.fetchReports(true);
      }
      return true;
    }

    // Navigation & scrolling
    if (matchesKey(data, "up") || data.toLowerCase() === "k") {
      this.scrollBy(-1);
      return true;
    }

    if (matchesKey(data, "down") || data.toLowerCase() === "j") {
      this.scrollBy(1);
      return true;
    }

    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.scrollBy(-8);
      return true;
    }

    if (
      matchesKey(data, "pageDown") ||
      matchesKey(data, "ctrl+d") ||
      matchesKey(data, "space")
    ) {
      this.scrollBy(8);
      return true;
    }

    if (matchesKey(data, "home") || data === "g") {
      this.scrollTop = 0;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "end") || data === "G") {
      this.scrollTop = 9999;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollBy(event.wheelDelta > 0 ? 3 : -3);
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const accentFn = (s: string) => (this.theme?.fg ? this.theme.fg("accent", s) : s);
    const borderFn = (s: string) => (this.theme?.fg ? this.theme.fg("border", s) : s);
    const boldFn = (s: string) => (this.theme?.bold ? this.theme.bold(s) : s);
    const dimFn = (s: string) => (this.theme?.fg ? this.theme.fg("dim", s) : s);

    const titleText = "Provider Quotas & Rate Limits";
    let rightBadge = "";
    if (this.loading) {
      const spinner = accentFn(SPINNER_FRAMES[this.frameIndex]);
      rightBadge = `${spinner} fetching...`;
    } else if (this.refreshing) {
      const spinner = accentFn(SPINNER_FRAMES[this.frameIndex]);
      rightBadge = `${spinner} refreshing...`;
    } else if (this.fetchedAt > 0) {
      const ageMs = Math.max(0, Date.now() - this.fetchedAt);
      const ageSec = Math.floor(ageMs / 1000);
      let ageStr: string;
      if (ageSec < 1) {
        ageStr = "just now";
      } else if (ageSec < 60) {
        ageStr = `${ageSec}s ago`;
      } else {
        const mins = Math.floor(ageSec / 60);
        const secs = ageSec % 60;
        ageStr = secs > 0 ? `${mins}m ${secs}s ago` : `${mins}m ago`;
      }
      rightBadge = `fetched ${ageStr}`;
    }

    const leftText = `── ${titleText} `;
    const leftPart = `${borderFn("── ")}${boldFn(accentFn(titleText))} `;
    const leftVisible = visibleWidth(leftText);

    const rightText = rightBadge ? ` ${rightBadge} ──` : " ──";
    const rightPart = rightBadge ? ` ${dimFn(rightBadge)}${borderFn(" ──")}` : borderFn(" ──");
    const rightVisible = visibleWidth(rightText);

    let topBorder: string;
    if (leftVisible + rightVisible + 2 <= width) {
      const fillCount = Math.max(1, width - leftVisible - rightVisible);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${rightPart}`;
    } else {
      const fillCount = Math.max(1, width - leftVisible - 2);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${borderFn("──")}`;
    }

    const lines: string[] = [topBorder];

    if (this.loading && this.reports.length === 0) {
      const spinner = accentFn(SPINNER_FRAMES[this.frameIndex]);
      lines.push("");
      lines.push(`  ${spinner} ${dimFn("Fetching provider quotas across configured accounts...")}`);
      lines.push("");
    } else if (this.errorMsg && this.reports.length === 0) {
      lines.push("");
      lines.push(
        `  ${this.theme?.fg ? this.theme.fg("error", `Failed to load usage: ${this.errorMsg}`) : `Failed to load usage: ${this.errorMsg}`}`
      );
      lines.push("");
    } else if (this.reports.length === 0) {
      lines.push("");
      lines.push(
        `  ${this.theme?.fg ? this.theme.fg("warning", "No active provider accounts found to report usage for.") : "No active provider accounts found to report usage for."}`
      );
      lines.push("");
    } else {
      const allContentLines = buildUsageLines(this.reports, {
        sessionInfo: this.sessionInfo,
        availableWidth: width,
        theme: this.theme,
        now: Date.now(),
      });

      const termRows =
        this.tui.terminal?.rows ||
        (typeof process !== "undefined" && process.stdout?.rows) ||
        24;
      // Overhead: topBorder (1) + blank (1) + blank (1) + hints (1) + blank (1) + bottomBorder (1) = 6
      const viewportHeight = Math.max(5, termRows - 6);
      const canScroll = allContentLines.length > viewportHeight;
      const maxScroll = Math.max(0, allContentLines.length - viewportHeight);
      this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop));

      const visibleLines = canScroll
        ? allContentLines.slice(this.scrollTop, this.scrollTop + viewportHeight)
        : allContentLines;

      lines.push("");
      lines.push(...visibleLines);
      lines.push("");

      // Footer hints inside the box
      const hints: string[] = [];
      hints.push(formatKeyHint(this.theme, "r", "refresh"));
      if (canScroll) {
        const scrollInfo = `${this.scrollTop + 1}-${Math.min(allContentLines.length, this.scrollTop + viewportHeight)}/${allContentLines.length}`;
        hints.push(formatKeyHint(this.theme, "↑↓", `scroll (${scrollInfo})`));
      }
      hints.push(formatKeyHint(this.theme, "Esc", "close"));

      lines.push(`  ${hints.join("  ·  ")}`);
      lines.push("");

      // Bottom border
      lines.push(borderFn("─".repeat(Math.max(1, width))));
      return lines;
    }

    // Inside box hints for loading / empty / error state
    const simpleHints = [formatKeyHint(this.theme, "Esc", "close")];
    if (this.errorMsg) {
      simpleHints.unshift(formatKeyHint(this.theme, "r", "retry"));
    }
    lines.push(`  ${simpleHints.join("  ·  ")}`);
    lines.push("");

    // Bottom border closes the box
    lines.push(borderFn("─".repeat(Math.max(1, width))));
    return lines;
  }
}

/**
 * Renders the usage breakdown in a full TUI dialog, displaying in-modal loading state without polluting scrollback.
 */
async function showUsageTui(ctx: ExtensionCommandContext): Promise<void> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const currentModel = ctx.model;
  const currentProvider = currentModel?.provider;
  const currentModelId = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;

  await ctx.ui.custom<void>((tui, theme, kb, done) => {
    return new UsageViewerComponent(tui, theme, kb, () => done(undefined), {
      sessionId,
      currentProvider,
      currentModelId,
    });
  });
}

/**
 * Registers the /usage command with Pi.
 */
export { registerUsageFooter } from "./footer.js";
export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Display provider quota and rate limit status across all configured accounts",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.mode === "tui") {
        await showUsageTui(ctx);
      } else {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        const currentModel = ctx.model;
        const currentProvider = currentModel?.provider;
        const currentModelId = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;

        try {
          const result = await collectUsageReports({
            signal: ctx.signal,
            sessionId,
            currentProvider,
            currentModelId,
          });
          if (result.reports.length === 0) {
            console.log("No active provider accounts found to report usage for.");
            return;
          }
          const text = formatUsageText(result.reports, {
            sessionInfo: result.sessionInfo,
            availableWidth: process.stdout.columns || 100,
          });
          console.log(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch usage reports: ${msg}`);
        }
      }
    },
  });
}
