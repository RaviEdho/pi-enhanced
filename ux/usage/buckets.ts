import type { QuotaBucket } from "./types.js";
import { normalizeWindowToken, quotaWindowSeconds, QUOTA_WINDOW } from "./windows.js";
import { computeTimeElapsedFraction } from "./timing.js";

export function isValueBucket(bucket: QuotaBucket): boolean {
  const window = normalizeWindowToken(bucket.window);
  return bucket.displayMode === "value" || [QUOTA_WINDOW.prepaid, QUOTA_WINDOW.balance, QUOTA_WINDOW.coupon, QUOTA_WINDOW.onDemand].some((value) => value === window);
}

export function balanceDisplayValue(bucket: QuotaBucket): string | undefined {
  const description = bucket.description?.trim();
  if (!description) return bucket.balanceUsd !== undefined ? `$${bucket.balanceUsd.toFixed(2)}` : undefined;
  const window = normalizeWindowToken(bucket.window);
  if ([QUOTA_WINDOW.balance, QUOTA_WINDOW.prepaid, QUOTA_WINDOW.onDemand].some((value) => value === window)) {
    const amount = description.match(/^((?:\$|Rp\s*)\s*[\d.,]+|[\d.,]+\s+[A-Z]{3})(?=\s|$)/);
    if (amount) return amount[1];
  }
  return description;
}

export function bucketDurationForOrdering(bucket: QuotaBucket): number {
  return isValueBucket(bucket) ? 0 : quotaWindowSeconds(bucket.window, bucket.windowSeconds);
}

export function bucketTimeElapsed(bucket: QuotaBucket, now: number): number | undefined {
  if (bucket.windowStartedAt) {
    const start = Date.parse(bucket.windowStartedAt);
    const end = Date.parse(bucket.resetTime ?? "");
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (now - start) / (end - start))) : undefined;
  }
  const fixed = bucket.bucketId === "ollama-cloud-included";
  return computeTimeElapsedFraction(bucket.resetTime, bucket.windowSeconds, now, fixed ? undefined : bucket.usedFraction);
}

export function hasValidReset(bucket: QuotaBucket): boolean {
  return !!bucket.resetTime && Number.isFinite(Date.parse(bucket.resetTime));
}
