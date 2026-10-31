import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ProviderUsageReport, SessionUsageInfo } from "./types.js";

/**
 * Pluggable theme interface compatible with Pi's active theme or fallback ANSI formatting.
 */
export interface UsageTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
  dim?(text: string): string;
}

/**
 * Creates a default ANSI-based theme for non-TUI CLI environments.
 */
export function createDefaultCliTheme(colorize = true): UsageTheme {
  if (!colorize) {
    return {
      fg: (_name, text) => text,
      bold: (text) => text,
      dim: (text) => text,
    };
  }
  return {
    fg: (name, text) => {
      switch (name) {
        case "accent":
          return `\x1b[36m${text}\x1b[39m`;
        case "success":
        case "userMessageText":
          return `\x1b[32m${text}\x1b[39m`;
        case "customMessageLabel":
          return `\x1b[35m${text}\x1b[39m`;
        case "warning":
          return `\x1b[33m${text}\x1b[39m`;
        case "error":
          return `\x1b[31m${text}\x1b[39m`;
        case "dim":
          return `\x1b[2m${text}\x1b[22m`;
        case "muted":
          return `\x1b[90m${text}\x1b[39m`;
        case "border":
          return `\x1b[90m${text}\x1b[39m`;
        default:
          return text;
      }
    },
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    dim: (text) => `\x1b[2m${text}\x1b[22m`,
  };
}

/**
 * Formats an ISO 8601 timestamp into a compact relative string like "1d22h", "3h46m", or "12m".
 */
export function formatRelativeTime(isoString?: string, now = Date.now()): string {
  if (!isoString) return "unknown";
  const target = new Date(isoString).getTime();
  const diffMs = Math.max(0, target - now);
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/**
 * Computes the fraction of time elapsed in the current rate limit window (0.0 to 1.0).
 * Returns undefined for unused buckets (usedFraction <= 0) since their timer has not
 * started ticking yet — this suppresses the reset-cycle marker (┃) in progress bars.
 */
export function computeTimeElapsedFraction(
  resetTimeIso?: string,
  windowSeconds?: number,
  now = Date.now(),
  usedFraction?: number
): number | undefined {
  if (!resetTimeIso || !windowSeconds || windowSeconds <= 0) return undefined;
  if (usedFraction !== undefined && usedFraction <= 0) return undefined;

  const resetMs = new Date(resetTimeIso).getTime();
  if (Number.isNaN(resetMs)) return undefined;
  const remainingMs = resetMs - now;
  const windowMs = windowSeconds * 1000;
  // Clamp remaining time to [0, windowMs] to protect against slight clock skews
  const clampedRemainingMs = Math.max(0, Math.min(windowMs, remainingMs));
  const elapsedMs = windowMs - clampedRemainingMs;
  return Math.max(0, Math.min(1, elapsedMs / windowMs));
}

/**
 * Creates a block progress bar like ████████░░░░┃░░░░░░░░░░░░░
 * with a vertical bar ┃ indicating current time/reset cycle progress.
 *
 * Fully supports Pi's native semantic theme or unstyled plain text.
 */
export function makeProgressBar(
  usedFraction: number,
  width = 25,
  timeElapsedFraction?: number,
  themeOrColorize: boolean | UsageTheme = false,
  allowHalfBlock = false
): string {
  const safeWidth = Math.max(4, width);
  const clampedUsed = Math.max(0, Math.min(1, usedFraction));

  let markerIndex: number | undefined;
  if (timeElapsedFraction !== undefined && !Number.isNaN(timeElapsedFraction)) {
    const clampedTime = Math.max(0, Math.min(1, timeElapsedFraction));
    markerIndex = Math.min(safeWidth - 1, Math.max(0, Math.floor(clampedTime * safeWidth)));
  }

  let theme: UsageTheme | undefined;
  if (typeof themeOrColorize === "object" && themeOrColorize !== null) {
    theme = themeOrColorize;
  } else if (themeOrColorize === true) {
    theme = createDefaultCliTheme(true);
  }

  const fillChar = "█";
  const emptyChar = "░";
  const markerChar = "┃";

  // Standard integer blocks without half-block subdividing (e.g. monochrome footer)
  if (!theme || !allowHalfBlock) {
    const usedSlots = Math.round(clampedUsed * safeWidth);
    let bar = "";
    for (let i = 0; i < safeWidth; i++) {
      if (markerIndex !== undefined && i === markerIndex) {
        bar += theme ? theme.fg("accent", markerChar) : markerChar;
      } else if (i < usedSlots) {
        bar += theme
          ? theme.fg(
              clampedUsed >= 0.95 ? "error" : clampedUsed >= 0.8 ? "warning" : "success",
              fillChar
            )
          : fillChar;
      } else {
        bar += theme ? theme.fg("dim", emptyChar) : emptyChar;
      }
    }
    return bar;
  }

  // Half-block resolution (reserved for /usage with theme)
  const totalHalfSlots = Math.round(clampedUsed * safeWidth * 2);
  const fullSlots = Math.floor(totalHalfSlots / 2);
  const hasHalf = totalHalfSlots % 2 === 1;

  const colorToken = clampedUsed >= 0.95 ? "error" : clampedUsed >= 0.8 ? "warning" : "success";

  let bar = "";
  for (let i = 0; i < safeWidth; i++) {
    if (markerIndex !== undefined && i === markerIndex) {
      bar += theme.fg("accent", markerChar);
    } else if (i < fullSlots) {
      bar += theme.fg(colorToken, fillChar);
    } else if (i === fullSlots && hasHalf) {
      bar += theme.fg(colorToken, emptyChar);
    } else {
      bar += theme.fg("dim", emptyChar);
    }
  }

  return bar;
}

export interface FormatUsageOptions {
  now?: number;
  sessionInfo?: SessionUsageInfo;
  colorize?: boolean;
  availableWidth?: number;
  /** Body rows available before providers flow into the next column. */
  availableHeight?: number;
  theme?: UsageTheme;
}

function formatAccountBadge(
  report: ProviderUsageReport,
  theme: UsageTheme,
  indentCount = 4
): string {
  const accent = (s: string) => theme.fg("accent", s);
  const dim = (s: string) => (theme.dim ? theme.dim(s) : theme.fg("dim", s));
  const bold = (s: string) => theme.bold(s);
  const warning = (s: string) => theme.fg("warning", s);

  const isSession = !!report.isSessionAccount;
  const bullet = isSession ? accent("●") : dim("○");

  const rawEmail = report.accountEmail || report.accountId || "account";
  const cleanEmail = rawEmail.replace(/\s*\[COOLDOWN[^\]]*\]/gi, "").trim();
  const emailStyled = isSession ? bold(accent(cleanEmail)) : cleanEmail;

  const badges: string[] = [];
  if (isSession) {
    badges.push(accent("[in use]"));
  }

  const cooldownMins =
    report.cooldownMinutes ??
    (rawEmail.match(/\[COOLDOWN\s*~?(\d+)m\]/i)?.[1]
      ? parseInt(rawEmail.match(/\[COOLDOWN\s*~?(\d+)m\]/i)![1], 10)
      : undefined);
  if (cooldownMins && cooldownMins > 0) {
    badges.push(warning(`[cooldown ~${cooldownMins}m]`));
  }

  if (report.planType) {
    badges.push(dim(`· ${report.planType}`));
  }

  if (report.resetCredits && report.resetCredits > 0) {
    badges.push(
      warning(`· ✦ ${report.resetCredits} reset${report.resetCredits === 1 ? "" : "s"}`)
    );
  }

  const badgeStr = badges.length > 0 ? " " + badges.join(" ") : "";
  const indent = indentCount > 0 ? " ".repeat(indentCount) : "";
  return `${indent}${bullet} ${emailStyled}${badgeStr}`;
}

function formatBucketEntry(
  report: ProviderUsageReport,
  bucket: import("./types.js").QuotaBucket | undefined,
  barWidth: number,
  now: number,
  theme: UsageTheme
): { bar: string; metric: string; full: string; visibleLen: number } {
  if (!bucket) {
    return { bar: "", metric: "", full: "", visibleLen: 0 };
  }

  const dim = (s: string) => (theme.dim ? theme.dim(s) : theme.fg("dim", s));
  const warning = (s: string) => theme.fg("warning", s);
  const error = (s: string) => theme.fg("error", s);

  // Value buckets (balances, credits, coupons) carry no consumed fraction, so a
  // progress bar would always render as an untouched `100% · ready` window.
  // Show the amount as plain text instead.
  if (bucket.displayMode === "value") {
    const valueText = bucket.description || "—";
    const resetSuffix =
      bucket.resetTime && !valueText.includes("expires")
        ? ` · ${formatRelativeTime(bucket.resetTime, now)}`
        : "";
    const metric = dim(`${valueText}${resetSuffix}`);
    return { bar: "", metric, full: metric, visibleLen: visibleWidth(metric) };
  }

  const timeElapsed = computeTimeElapsedFraction(
    bucket.resetTime,
    bucket.windowSeconds,
    now,
    // Fixed-period allocations advance even when no usage has occurred.
    bucket.bucketId === "cloudflare-neurons" || bucket.bucketId === "ollama-cloud-included" ? undefined : bucket.usedFraction
  );
  const bar = makeProgressBar(bucket.usedFraction, barWidth, timeElapsed, theme, true);

  const freePct = Math.max(0, 100 - bucket.usedFraction * 100);
  const pctStr = `${freePct.toFixed(1)}%`.padStart(6);
  const pctColored =
    bucket.usedFraction >= 0.95
      ? error(pctStr)
      : bucket.usedFraction >= 0.8
        ? warning(pctStr)
        : dim(pctStr);

  let detailStr = "";
  if (bucket.usedFraction <= 0 && bucket.bucketId !== "cloudflare-neurons" && bucket.bucketId !== "ollama-cloud-included") {
    detailStr = "ready";
  } else if (bucket.resetTime) {
    detailStr = formatRelativeTime(bucket.resetTime, now);
  } else if (report.capacitySummary) {
    detailStr = report.capacitySummary;
  }

  const metric = detailStr
    ? `${pctColored} ${dim("·")} ${dim(detailStr)}`
    : pctColored;

  const full = `${bar}   ${metric}`;
  const visibleLen = barWidth + 3 + visibleWidth(metric);

  return { bar, metric, full, visibleLen };
}

const MIN_PROVIDER_COLUMN_WIDTH = 52;
const PROVIDER_COLUMN_GAP = 4;

/** Wrap within one provider column without losing account identities or error text. */
function appendUsageLine(lines: string[], text: string, width: number): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const leading = rawLine.match(/^ */)?.[0].length ?? 0;
    const indent = " ".repeat(Math.min(leading, Math.max(0, width - 4)));
    for (const line of wrapTextWithAnsi(rawLine.slice(leading), Math.max(1, width - indent.length))) {
      lines.push(truncateToWidth(indent + line, width));
    }
  }
}

/** One indivisible provider block: its accounts always run down the same column. */
function buildProviderLines(
  reports: ProviderUsageReport[],
  width: number,
  now: number,
  theme: UsageTheme
): string[] {
  const lines: string[] = [];
  const dim = (text: string) => theme.dim ? theme.dim(text) : theme.fg("dim", text);
  const append = (text: string) => appendUsageLine(lines, text, width);
  const countTag = reports.length > 1 ? dim(` (${reports.length} accounts)`) : "";
  append(`  ${theme.bold(theme.fg("accent", reports[0].providerName))}${countTag}`);

  const buckets = reports.flatMap((report) => report.groups.flatMap((group) => group.buckets));
  const maxLabel = buckets.reduce((max, bucket) => Math.max(max, visibleWidth(bucket.displayName)), 16);
  const labelWidth = Math.max(4, Math.min(26, maxLabel, width - 33));
  const barWidth = Math.max(4, Math.min(25, width - (6 + labelWidth + 2 + 3 + 16)));

  for (let index = 0; index < reports.length; index++) {
    const report = reports[index];
    if (index > 0) lines.push("");
    append(formatAccountBadge(report, theme, 4));
    if (report.error) {
      const isAuth = /401|revoked|expired|unauthorized|invalidated|authentication failed|invalid_grant|invalid token|credits check failed/i.test(report.error);
      const message = isAuth
        ? `Session expired or revoked (run /login ${report.providerId.replace("openai-", "").replace("google-", "")})`
        : report.error.startsWith("Session") || report.error.startsWith("Token") || report.error.includes("/login")
          ? report.error
          : `Could not fetch usage: ${report.error}`;
      append(`      ${theme.fg("error", `⚠️  ${message}`)}`);
    } else if (report.quotaUnavailableReason) {
      append(`      ${dim(report.quotaUnavailableReason)}`);
      if (report.usageUrl) append(`      ${dim(`View usage: ${report.usageUrl}`)}`);
    } else {
      const accountBuckets = report.groups.flatMap((group) => group.buckets);
      if (accountBuckets.length === 0) {
        append(`      ${dim(report.capacitySummary || "No active quota limits reported.")}`);
      } else {
        for (const bucket of accountBuckets) {
          const label = truncateToWidth(bucket.displayName, labelWidth, "…");
          const padding = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
          const entry = formatBucketEntry(report, bucket, barWidth, now, theme);
          append(`      ${label}${padding}  ${entry.full}`);
        }
      }
    }
  }
  return lines;
}

/**
 * Fill columns top-to-bottom in provider order, keeping each provider's accounts together.
 */
export function buildUsageLines(
  reports: ProviderUsageReport[],
  options?: FormatUsageOptions
): string[] {
  const now = options?.now ?? Date.now();
  const theme: UsageTheme =
    options?.theme ?? createDefaultCliTheme(options?.colorize !== false);
  const availableWidth = Math.max(1, Math.floor(
    options?.availableWidth ??
    (typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 120)
  ));

  const accent = (s: string) => theme.fg("accent", s);
  const dim = (s: string) => (theme.dim ? theme.dim(s) : theme.fg("dim", s));
  const bold = (s: string) => theme.bold(s);
  const lines: string[] = [];

  // Active Session context header if available
  if (options?.sessionInfo && (options.sessionInfo.accountEmail || options.sessionInfo.modelId)) {
    const parts: string[] = [];
    if (options.sessionInfo.modelId) {
      parts.push(bold(accent(options.sessionInfo.modelId)));
    }
    if (options.sessionInfo.accountEmail) {
      parts.push(options.sessionInfo.accountEmail);
    }
    appendUsageLine(lines, `  ${dim("Active Session:")} ${parts.join(dim(" → "))}`, availableWidth);
    lines.push("");
  }

  const byProvider = new Map<string, ProviderUsageReport[]>();
  for (const report of reports) {
    const accounts = byProvider.get(report.providerId) ?? [];
    accounts.push(report);
    byProvider.set(report.providerId, accounts);
  }
  if (byProvider.size === 0) return lines;

  const maxColumns = Math.min(byProvider.size, Math.max(1,
    Math.floor((availableWidth + PROVIDER_COLUMN_GAP) / (MIN_PROVIDER_COLUMN_WIDTH + PROVIDER_COLUMN_GAP))));
  const heightBudget = Math.max(1, Math.floor(options?.availableHeight ?? Infinity) - lines.length);
  const buildColumns = (count: number) => {
    const usableWidth = availableWidth - PROVIDER_COLUMN_GAP * (count - 1);
    const baseWidth = Math.floor(usableWidth / count);
    const widths = Array.from({ length: count }, (_, index) =>
      baseWidth + (index < usableWidth % count ? 1 : 0));
    const columns: string[][] = Array.from({ length: count }, () => []);
    let target = 0;
    let fits = true;

    for (const accounts of byProvider.values()) {
      let block = buildProviderLines(accounts, widths[target], now, theme);
      const occupied = columns[target].length;
      if (occupied > 0 && occupied + 1 + block.length > heightBudget) {
        if (target < count - 1) {
          target++;
          block = buildProviderLines(accounts, widths[target], now, theme);
        } else {
          // No horizontal room remains: retain overflow for vertical scrolling.
          fits = false;
        }
      }
      if (columns[target].length > 0) columns[target].push("");
      // Oversized providers stay intact in their own column and remain scrollable.
      columns[target].push(...block);
    }
    return { columns, widths, fits };
  };

  // Use another column only when the preceding columns run out of body rows.
  // Re-render at each width because wrapping changes the height of a provider.
  let layout = buildColumns(1);
  for (let count = 2; !layout.fits && count <= maxColumns; count++) layout = buildColumns(count);
  const { columns, widths } = layout;
  const columnCount = columns.length;
  const rowCount = Math.max(...columns.map((column) => column.length));
  for (let row = 0; row < rowCount; row++) {
    let lastColumn = columnCount - 1;
    while (lastColumn >= 0 && visibleWidth(columns[lastColumn][row] ?? "") === 0) lastColumn--;
    let line = "";
    for (let column = 0; column <= lastColumn; column++) {
      const cell = columns[column][row] ?? "";
      line += cell;
      if (column < lastColumn) {
        line += " ".repeat(Math.max(0, widths[column] - visibleWidth(cell)) + PROVIDER_COLUMN_GAP);
      }
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Formats usage reports into styled terminal text matching Pi's visual hierarchy.
 */
export function formatUsageText(
  reports: ProviderUsageReport[],
  options?: FormatUsageOptions
): string {
  const lines = buildUsageLines(reports, options);
  return lines.join("\n");
}
