export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
  windowSeconds?: number;
  remainingFraction: number;
  usedFraction: number;
  resetTime?: string;
  description?: string;
  /** Raw balance when this bucket represents monetary credits. */
  balanceUsd?: number;
  /**
   * How this bucket is rendered in `/usage`. Defaults to `"bar"`.
   * Use `"value"` for balances, credits and coupons: they have no meaningful
   * consumed fraction, so a progress bar would always read as an untouched
   * `100% · ready` window. Value buckets render their description as plain text.
   */
  displayMode?: "bar" | "value";
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface ProviderUsageReport {
  providerId: string;
  providerName: string;
  accountEmail?: string;
  accountId?: string;
  isSessionAccount?: boolean;
  isActiveAccount?: boolean;
  planType?: string;
  resetCredits?: number;
  cooldownMinutes?: number;
  fetchedAt: number;
  groups: QuotaGroup[];
  capacitySummary?: string;
  /**
   * Compact variant of `capacitySummary` using the footer vocabulary
   * (`5h`, `wk`, `mo`). Used by the single-line status footer so it
   * stays narrow; `/usage` keeps the descriptive `capacitySummary`.
   */
  capacitySummaryShort?: string;
  /** Informational limitation, not a credential failure or an empty quota. */
  quotaUnavailableReason?: string;
  usageUrl?: string;
  error?: string;
}

export interface SessionUsageInfo {
  sessionId?: string;
  modelId?: string;
  providerId?: string;
  accountEmail?: string;
  accountId?: string;
}
