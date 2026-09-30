import type { ProviderUsageReport, SessionUsageInfo } from "./types.js";

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

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}

function truncateLabel(str: string, maxW: number): string {
  if (visibleWidth(str) <= maxW) return str;
  if (maxW <= 1) return "…";
  const s = stripAnsi(str);
  return s.slice(0, maxW - 1) + "…";
}

/**
 * Creates a block progress bar like ████████░░░░┃░░░░░░░░░░░░░
 * with a vertical bar ┃ indicating current time/reset cycle progress.
 */
export function makeProgressBar(
  usedFraction: number,
  width = 28,
  timeElapsedFraction?: number,
  colorize = false
): string {
  const clampedUsed = Math.max(0, Math.min(1, usedFraction));
  const usedSlots = Math.round(clampedUsed * width);

  let markerIndex: number | undefined;
  if (timeElapsedFraction !== undefined && !Number.isNaN(timeElapsedFraction)) {
    const clampedTime = Math.max(0, Math.min(1, timeElapsedFraction));
    markerIndex = Math.min(width - 1, Math.max(0, Math.floor(clampedTime * width)));
  }

  const color = !colorize
    ? ""
    : clampedUsed >= 0.95
      ? "\x1b[31m"
      : clampedUsed >= 0.8
        ? "\x1b[33m"
        : "\x1b[32m";
  const colorEnd = colorize ? "\x1b[39m" : "";

  let bar = "";
  for (let i = 0; i < width; i++) {
    if (markerIndex !== undefined && i === markerIndex) {
      bar += "┃";
    } else if (i < usedSlots) {
      bar += `${color}█${colorEnd}`;
    } else {
      bar += "░";
    }
  }

  return bar;
}

export interface FormatUsageOptions {
  now?: number;
  sessionInfo?: SessionUsageInfo;
  colorize?: boolean;
  availableWidth?: number;
}

/**
 * Formats usage reports into styled terminal text matching omp's layout,
 * displaying multiple accounts sideways in tightly aligned columns.
 */
export function formatUsageText(
  reports: ProviderUsageReport[],
  options?: FormatUsageOptions
): string {
  const now = options?.now ?? Date.now();
  const colorize = options?.colorize !== false;
  const availableWidth =
    options?.availableWidth ??
    (typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 100);

  const lines: string[] = [];

  // Session context header if available
  if (options?.sessionInfo && (options.sessionInfo.accountEmail || options.sessionInfo.modelId)) {
    const sessionParts: string[] = [];
    if (options.sessionInfo.sessionId) {
      sessionParts.push(`session: ${options.sessionInfo.sessionId.slice(0, 8)}...`);
    }
    if (options.sessionInfo.modelId) {
      sessionParts.push(`model: ${options.sessionInfo.modelId}`);
    }
    if (options.sessionInfo.accountEmail) {
      sessionParts.push(`account: ${options.sessionInfo.accountEmail}`);
    }
    const sessionHeader = `Active Session · ${sessionParts.join(" · ")}`;
    lines.push(colorize ? `\x1b[1m${sessionHeader}\x1b[22m` : sessionHeader);
    lines.push("");
  }

  const earliestFetch = reports.reduce((acc, r) => Math.min(acc, r.fetchedAt), now);
  const ageMs = Math.max(0, now - earliestFetch);
  const ageText = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;

  const usageTitle = colorize
    ? `\x1b[1m\x1b[36mUsage\x1b[39m\x1b[22m \x1b[2m· fetched ${ageText} ago\x1b[22m`
    : `Usage · fetched ${ageText} ago`;
  lines.push(usageTitle);

  const byProvider = new Map<string, ProviderUsageReport[]>();
  for (const report of reports) {
    const list = byProvider.get(report.providerName) || [];
    list.push(report);
    byProvider.set(report.providerName, list);
  }

  for (const [providerName, providerReports] of byProvider.entries()) {
    lines.push("");
    const acctCount = providerReports.length;
    const providerHeader = colorize
      ? `\x1b[1m\x1b[36m${providerName}\x1b[39m\x1b[22m \x1b[2m— ${acctCount} ${acctCount === 1 ? "account" : "accounts"}\x1b[22m`
      : `${providerName} — ${acctCount} ${acctCount === 1 ? "account" : "accounts"}`;
    lines.push(providerHeader);

    // Show active session account if present for this provider
    const activeReport = providerReports.find((r) => r.isSessionAccount);
    if (activeReport) {
      const email = activeReport.accountEmail || activeReport.accountId || "active account";
      const planSuffix = activeReport.planType ? ` · plan: ${activeReport.planType}` : "";
      const inUseLine = colorize
        ? `  \x1b[36min use by this session:\x1b[39m \x1b[1m${email}\x1b[22m\x1b[2m${planSuffix}\x1b[22m`
        : `  in use by this session: ${email}${planSuffix}`;
      lines.push(inUseLine);
    }

    // Saved rate-limit resets if any
    const resetAccounts = providerReports.filter((r) => r.resetCredits && r.resetCredits > 0);
    for (const r of resetAccounts) {
      const resetLine = `  ✦ ${r.resetCredits} saved rate-limit reset${r.resetCredits === 1 ? "" : "s"} (${r.accountEmail})`;
      lines.push(colorize ? `\x1b[33m${resetLine}\x1b[39m` : resetLine);
    }

    // Collect all unique buckets across accounts for this provider in order
    const bucketMap = new Map<
      string,
      {
        displayName: string;
        window?: string;
        windowSeconds?: number;
        entries: { report: ProviderUsageReport; bucket: import("./types.js").QuotaBucket }[];
      }
    >();

    for (const report of providerReports) {
      const allBuckets = report.groups.flatMap((g) => g.buckets);
      for (const b of allBuckets) {
        if (!bucketMap.has(b.bucketId)) {
          bucketMap.set(b.bucketId, {
            displayName: b.displayName,
            window: b.window,
            windowSeconds: b.windowSeconds,
            entries: [],
          });
        }
        bucketMap.get(b.bucketId)!.entries.push({ report, bucket: b });
      }
    }

    if (bucketMap.size === 0) {
      const err = providerReports.find((r) => r.error)?.error;
      if (err) {
        lines.push(colorize ? `  \x1b[31mCould not fetch usage: ${err}\x1b[39m` : `  Could not fetch usage: ${err}`);
      } else {
        lines.push(colorize ? `  \x1b[2mNo active quota limits reported.\x1b[22m` : `  No active quota limits reported.`);
      }
      continue;
    }

    const maxAccounts = Math.max(...Array.from(bucketMap.values()).map((g) => g.entries.length));
    const gap = 3;
    const amountReserve = 13; // Space reserved for "   100.0% free"

    // Derive a fixed column width across ALL buckets of this provider so columns align perfectly
    const maxPossibleColWidth = Math.floor(
      (availableWidth - 2 - (maxAccounts - 1) * gap - amountReserve) / maxAccounts
    );
    const columnWidth = Math.max(18, Math.min(28, maxPossibleColWidth));
    const barWidth = columnWidth; // Bar width matches column width exactly (no empty gap within column)

    // Precalculate max suffix width for each account column position across all buckets of this provider
    const maxSuffixWidths: number[] = [];
    for (let col = 0; col < maxAccounts; col++) {
      let maxW = 0;
      for (const group of bucketMap.values()) {
        const entry = group.entries[col];
        if (entry) {
          // Unused buckets have not started their window yet, so show "ready" instead of a countdown
          const reset =
            entry.bucket.usedFraction <= 0
              ? "ready"
              : entry.bucket.resetTime
                ? formatRelativeTime(entry.bucket.resetTime, now)
                : "";
          const suffix = reset ? `(${reset})` : "";
          maxW = Math.max(maxW, suffix.length);
        }
      }
      maxSuffixWidths.push(maxW);
    }

    for (const [, group] of bucketMap) {
      const count = group.entries.length;
      const maxUsed = Math.max(...group.entries.map((e) => e.bucket.usedFraction));
      const statusIcon = !colorize
        ? "●"
        : maxUsed >= 1.0
          ? "\x1b[31m■\x1b[39m"
          : maxUsed >= 0.8
            ? "\x1b[33m▲\x1b[39m"
            : "\x1b[32m●\x1b[39m";

      const groupTitle = colorize
        ? `${statusIcon} \x1b[1m${group.displayName}\x1b[22m`
        : `${statusIcon} ${group.displayName}`;
      lines.push(groupTitle);

      if (count === 1) {
        // Single account presentation
        const { report, bucket } = group.entries[0];
        const active = report.isSessionAccount;
        const timeElapsed = computeTimeElapsedFraction(
          bucket.resetTime,
          bucket.windowSeconds,
          now,
          bucket.usedFraction
        );
        const singleBarWidth = Math.min(28, availableWidth - 26);
        const bar = makeProgressBar(bucket.usedFraction, singleBarWidth, timeElapsed, colorize);
        const freePct = Math.max(0, 100 - bucket.usedFraction * 100);
        const usedPct = (bucket.usedFraction * 100).toFixed(1);
        // Unused buckets have not started their window yet, so omit the countdown
        const resetStr =
          bucket.usedFraction <= 0
            ? " · ready"
            : bucket.resetTime
              ? ` · resets in ${formatRelativeTime(bucket.resetTime, now)}`
              : "";
        const label = report.accountEmail || report.accountId || "account";
        const styledLabel = active
          ? (colorize ? `\x1b[1m● ${label}\x1b[22m` : `● ${label}`)
          : label;

        lines.push(`  ${styledLabel}`);
        lines.push(`  ${bar}   ${freePct.toFixed(1)}% free (${usedPct}% used)${resetStr}`);
      } else {
        // Multi-account sideways (columnar) presentation matching omp
        const sumUsed = group.entries.reduce((sum, e) => sum + e.bucket.usedFraction, 0);
        const avgFree = Math.max(0, 100 - (sumUsed / count) * 100);
        const amountText = `${avgFree.toFixed(1)}% free`.padStart(10);

        // Row 1: Account headers side by side
        const headerCols = group.entries.map(({ report, bucket }, colIdx) => {
          // Unused buckets have not started their window yet, so show "ready" instead of a countdown
          const reset =
            bucket.usedFraction <= 0
              ? "ready"
              : bucket.resetTime
                ? formatRelativeTime(bucket.resetTime, now)
                : "";
          const suffix = reset ? `(${reset})` : "";
          const active = report.isSessionAccount;
          const label = (active ? "● " : "") + (report.accountEmail || report.accountId || "account");

          const maxSuffixW = maxSuffixWidths[colIdx] || suffix.length;
          const suffixSpace = maxSuffixW > 0 ? maxSuffixW + 1 : 0;
          const prefixBudget = columnWidth - suffixSpace;
          const prefix = truncateLabel(label, prefixBudget);
          const pad = " ".repeat(Math.max(0, prefixBudget - visibleWidth(prefix)));
          const styledPrefix = active
            ? (colorize ? `\x1b[1m\x1b[36m${prefix}\x1b[39m\x1b[22m` : prefix)
            : prefix;
          const suffixPad = " ".repeat(Math.max(0, maxSuffixW - suffix.length));
          const styledSuffix = suffix
            ? `${suffixPad}${colorize ? `\x1b[2m${suffix}\x1b[22m` : suffix}`
            : " ".repeat(maxSuffixW);
          return `${styledPrefix}${pad} ${styledSuffix}`;
        });

        lines.push(`  ${headerCols.join(" ".repeat(gap))}`);

        // Row 2: Progress bars side by side + aggregate percent free
        const barCols = group.entries.map(({ bucket }) => {
          const timeElapsed = computeTimeElapsedFraction(
            bucket.resetTime,
            bucket.windowSeconds,
            now,
            bucket.usedFraction
          );
          return makeProgressBar(bucket.usedFraction, barWidth, timeElapsed, colorize);
        });

        const trailingFormatted = colorize ? `\x1b[2m${amountText}\x1b[22m` : amountText;
        lines.push(`  ${barCols.join(" ".repeat(gap))}   ${trailingFormatted}`);
      }
    }
  }

  return lines.join("\n");
}
