import type { GainRecord, GainSummary } from "./types.js";

export class GainTracker {
  private static instance: GainTracker;
  private readonly records: GainRecord[] = [];
  private totalCommands = 0;
  private originalBytes = 0;
  private filteredBytes = 0;

  public static getInstance(): GainTracker {
    if (!GainTracker.instance) {
      GainTracker.instance = new GainTracker();
    }
    return GainTracker.instance;
  }

  public record(command: string, filterName: string, original: number, filtered: number): void {
    const saved = Math.max(0, original - filtered);
    this.totalCommands++;
    this.originalBytes += original;
    this.filteredBytes += filtered;

    this.records.push({
      command,
      filterName,
      originalBytes: original,
      filteredBytes: filtered,
      savedBytes: saved,
      timestamp: Date.now(),
    });

    // Keep memory bounded to last 500 records
    if (this.records.length > 500) {
      this.records.shift();
    }
  }

  public getSummary(): GainSummary {
    const savedBytes = Math.max(0, this.originalBytes - this.filteredBytes);
    const savedTokensEst = Math.round(savedBytes / 4);
    const savingsPercentage =
      this.originalBytes > 0 ? (savedBytes / this.originalBytes) * 100 : 0;

    const breakdownByFilter: Record<
      string,
      { count: number; savedBytes: number; savedTokensEst: number }
    > = {};

    for (const r of this.records) {
      const entry = breakdownByFilter[r.filterName] ?? {
        count: 0,
        savedBytes: 0,
        savedTokensEst: 0,
      };
      entry.count++;
      entry.savedBytes += r.savedBytes;
      entry.savedTokensEst += Math.round(r.savedBytes / 4);
      breakdownByFilter[r.filterName] = entry;
    }

    return {
      totalCommands: this.totalCommands,
      originalBytes: this.originalBytes,
      filteredBytes: this.filteredBytes,
      savedBytes,
      savedTokensEst,
      savingsPercentage,
      breakdownByFilter,
    };
  }

  public formatSummary(): string {
    const summary = this.getSummary();
    if (summary.totalCommands === 0) {
      return "Native Output Filter: No bash commands have been filtered yet.";
    }

    const lines: string[] = [
      "=== Native Output Filter Gain ===",
      `Total commands filtered: ${summary.totalCommands}`,
      `Original output size:     ${formatBytes(summary.originalBytes)} (~${formatTokens(Math.round(summary.originalBytes / 4))} tokens)`,
      `Filtered output size:     ${formatBytes(summary.filteredBytes)} (~${formatTokens(Math.round(summary.filteredBytes / 4))} tokens)`,
      `Total reduction:          ${formatBytes(summary.savedBytes)} (~${formatTokens(summary.savedTokensEst)} tokens, ${summary.savingsPercentage.toFixed(1)}% saved)`,
      "",
      "--- Savings by Category ---",
    ];

    const sortedFilters = Object.entries(summary.breakdownByFilter).sort(
      (a, b) => b[1].savedBytes - a[1].savedBytes
    );

    for (const [name, stats] of sortedFilters) {
      lines.push(
        `• ${name.padEnd(16)}: ${String(stats.count).padStart(3)} cmds | ${formatBytes(stats.savedBytes).padStart(9)} saved (~${formatTokens(stats.savedTokensEst)} tokens)`
      );
    }

    return lines.join("\n");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}m`;
}
