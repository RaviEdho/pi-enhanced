import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

  const timeElapsed = computeTimeElapsedFraction(
    bucket.resetTime,
    bucket.windowSeconds,
    now,
    bucket.usedFraction
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
  if (report.providerId === "hyper" && report.capacitySummary) {
    detailStr = report.capacitySummary;
  } else if (bucket.usedFraction <= 0) {
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

/**
 * Builds formatted lines for provider quotas and accounts following native Pi UI conventions.
 */
export function buildUsageLines(
  reports: ProviderUsageReport[],
  options?: FormatUsageOptions
): string[] {
  const now = options?.now ?? Date.now();
  const theme: UsageTheme =
    options?.theme ?? createDefaultCliTheme(options?.colorize !== false);
  const availableWidth =
    options?.availableWidth ??
    (typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 120);

  const accent = (s: string) => theme.fg("accent", s);
  const dim = (s: string) => (theme.dim ? theme.dim(s) : theme.fg("dim", s));
  const bold = (s: string) => theme.bold(s);
  const error = (s: string) => theme.fg("error", s);

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
    lines.push(`  ${dim("Active Session:")} ${parts.join(dim(" → "))}`);
    lines.push("");
  }

  // Group reports by provider name
  const byProvider = new Map<string, ProviderUsageReport[]>();
  for (const report of reports) {
    const list = byProvider.get(report.providerName) || [];
    list.push(report);
    byProvider.set(report.providerName, list);
  }

  // Calculate max bucket label width across all reports for consistent column alignment
  const allReportBuckets = reports.flatMap((r) => r.groups.flatMap((g) => g.buckets));
  const maxLabelLen =
    allReportBuckets.length > 0
      ? Math.max(...allReportBuckets.map((b) => visibleWidth(b.displayName)))
      : 16;
  const labelWidth = Math.max(16, Math.min(26, maxLabelLen));

  let isFirstProvider = true;
  for (const [providerName, providerReports] of byProvider.entries()) {
    if (!isFirstProvider) {
      lines.push("");
    }
    isFirstProvider = false;

    const acctCount = providerReports.length;
    const countTag = acctCount > 1 ? dim(` (${acctCount} accounts)`) : "";
    lines.push(`  ${bold(accent(providerName))}${countTag}`);

    const canFitTwoColumns =
      availableWidth >= 100 &&
      providerReports.length === 2 &&
      !providerReports.some((r) => r.error);

    if (canFitTwoColumns) {
      // 2-Account Side-by-Side Presentation
      const acc1 = providerReports[0];
      const acc2 = providerReports[1];

      // Calculate bar width and column 2 start position
      const leftPrefixW = 6 + labelWidth + 2;
      const col1MetricWidth = 14;
      const colGap = 8;
      const availableForBars =
        availableWidth - leftPrefixW - colGap - 2 * (3 + col1MetricWidth);
      const barWidth = Math.max(15, Math.min(25, Math.floor(availableForBars / 2)));
      const col1Width = barWidth + 3 + col1MetricWidth;
      const col2Start = leftPrefixW + col1Width + colGap;

      const leftHeader = formatAccountBadge(acc1, theme, 4);
      const rightHeader = formatAccountBadge(acc2, theme, 0);
      const padHeaders = " ".repeat(Math.max(2, col2Start - visibleWidth(leftHeader)));
      lines.push(`${leftHeader}${padHeaders}${rightHeader}`);

      const buckets1 = acc1.groups.flatMap((g) => g.buckets);
      const buckets2 = acc2.groups.flatMap((g) => g.buckets);
      const seenIds = new Set<string>();
      const allBuckets: { id: string; name: string }[] = [];
      for (const b of [...buckets1, ...buckets2]) {
        if (!seenIds.has(b.bucketId)) {
          seenIds.add(b.bucketId);
          allBuckets.push({ id: b.bucketId, name: b.displayName });
        }
      }

      for (const { id, name } of allBuckets) {
        const b1 = buckets1.find((b) => b.bucketId === id);
        const b2 = buckets2.find((b) => b.bucketId === id);

        const rawLabel = truncateToWidth(name, labelWidth, "…");
        const labelPad = " ".repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));
        const labelPrefix = `      ${rawLabel}${labelPad}  `;

        const entry1 = formatBucketEntry(acc1, b1, barWidth, now, theme);
        const entry2 = formatBucketEntry(acc2, b2, barWidth, now, theme);

        const col1Vis = entry1.visibleLen;
        const padToCol2 = " ".repeat(Math.max(2, col2Start - (leftPrefixW + col1Vis)));

        lines.push(`${labelPrefix}${entry1.full}${padToCol2}${entry2.full}`);
      }
    } else {
      // Single-Column / Stacked Presentation
      const barBudget = Math.max(
        15,
        Math.min(25, availableWidth - (6 + labelWidth + 2 + 3 + 16))
      );

      for (let aIdx = 0; aIdx < providerReports.length; aIdx++) {
        const report = providerReports[aIdx];
        const header = formatAccountBadge(report, theme, 4);
        lines.push(header);

        if (report.error) {
          const isAuth =
            /401|revoked|expired|unauthorized|invalidated|authentication failed|invalid_grant|invalid token|credits check failed/i.test(
              report.error
            );
          const cleanErr = isAuth
            ? `Session expired or revoked (run /login ${report.providerId.replace("openai-", "").replace("google-", "")})`
            : (report.error.startsWith("Session") || report.error.startsWith("Token") || report.error.includes("/login")
                ? report.error
                : `Could not fetch usage: ${report.error}`);
          lines.push(`      ${error(`⚠️  ${cleanErr}`)}`);
        } else {
          const allBuckets = report.groups.flatMap((g) => g.buckets);
          if (allBuckets.length === 0) {
            if (report.capacitySummary) {
              lines.push(`      ${dim(report.capacitySummary)}`);
            } else {
              lines.push(`      ${dim("No active quota limits reported.")}`);
            }
          } else {
            for (const bucket of allBuckets) {
              const rawLabel = truncateToWidth(bucket.displayName, labelWidth, "…");
              const labelPad = " ".repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));
              const labelStr = `${rawLabel}${labelPad}`;

              const entry = formatBucketEntry(report, bucket, barBudget, now, theme);
              lines.push(`      ${labelStr}  ${entry.full}`);
            }
          }
        }

        if (aIdx < providerReports.length - 1) {
          lines.push("");
        }
      }
    }
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
