import type { CommitUsageCost } from "./types.js";

/**
 * Format token counts compactly (e.g. 850, 1.2k, 25k, 1.5M).
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Format cost in USD with high precision for micro-transactions.
 */
export function formatCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/**
 * Format duration in human-readable units (e.g. 450ms, 2.3s, 1m12s).
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = Math.round(seconds % 60);
  return `${minutes}m${remainingSec}s`;
}

/**
 * Generates a concise single-line cost and token summary badge.
 */
export function formatCostBadge(usage: CommitUsageCost): string {
  const costPart = usage.totalCost > 0
    ? formatCost(usage.totalCost)
    : (usage.isSubscription ? "subscription" : "$0.00");
  return `${costPart} (${formatTokens(usage.totalTokens)} tok)`;
}
