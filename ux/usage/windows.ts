/**
 * Canonical quota window vocabulary shared by every provider scraper.
 *
 * Providers describe the same quota concepts with different wording
 * (`"5h"`, `"5-hour"`, `"5 Hour"`, `"N-Hour Limit"`). To keep `/usage` and the
 * status footer consistent, every scraper normalizes its windows to the tokens
 * below and renders them with the canonical labels.
 */

/** Canonical machine-readable window tokens. */
export const QUOTA_WINDOW = {
  fiveHour: "5-hour",
  weekly: "weekly",
  monthly: "monthly",
  daily: "daily",
  balance: "balance",
  prepaid: "prepaid",
  coupon: "coupon",
  onDemand: "on-demand",
  default: "default",
} as const;

export type QuotaWindowToken = (typeof QUOTA_WINDOW)[keyof typeof QUOTA_WINDOW];

/**
 * Canonical user-facing labels for the shared window concepts.
 *
 * Provider-specific buckets (e.g. Command Code's "Extra Credits" or
 * Antigravity's "Gemini (Weekly)") keep their own `displayName` and are
 * deliberately absent from this map.
 */
export const QUOTA_WINDOW_LABEL: Record<string, string> = {
  [QUOTA_WINDOW.fiveHour]: "5 Hour",
  [QUOTA_WINDOW.weekly]: "Weekly",
  [QUOTA_WINDOW.monthly]: "Monthly",
  [QUOTA_WINDOW.daily]: "Daily",
};

/**
 * Resolves the canonical label for a window token, falling back to the raw
 * token when the provider reports a non-standard duration.
 */
export function quotaWindowLabel(token: string | undefined): string {
  if (!token) return "";
  return QUOTA_WINDOW_LABEL[token] || token;
}

const DAY_SECONDS = 86_400;

/**
 * Normalizes a provider-reported window string into a canonical token.
 *
 * Accepts the shapes providers actually emit (`"5h"`, `"5-hour"`, `"weekly"`,
 * `"7d"`, `"30d"`, `"daily"`) and leaves non-duration tokens such as
 * `"prepaid"`, `"coupon"` or `"on-demand"` untouched.
 */
export function normalizeWindowToken(raw: string | undefined | null): string {
  const value = (raw ?? "").toLowerCase().trim();
  if (!value) return QUOTA_WINDOW.default;
  if (value.includes("week")) return QUOTA_WINDOW.weekly;
  if (value.includes("month")) return QUOTA_WINDOW.monthly;
  if (value === "daily" || value === "1d" || value === "1day" || value === "1-day") {
    return QUOTA_WINDOW.daily;
  }
  const hourMatch = value.match(/^(\d+)\s*-?\s*h(?:our)?s?$/);
  if (hourMatch) return `${hourMatch[1]}-hour`;
  if (value.includes("day")) return value;
  return value;
}

/**
 * Maps a window duration to a canonical window token.
 */
export function windowTokenForSeconds(seconds: number): string {
  if (seconds >= 28 * DAY_SECONDS && seconds <= 31 * DAY_SECONDS) {
    return QUOTA_WINDOW.monthly;
  }
  if (seconds >= 6 * DAY_SECONDS && seconds <= 8 * DAY_SECONDS) {
    return QUOTA_WINDOW.weekly;
  }
  if (seconds >= 0.9 * DAY_SECONDS && seconds <= 1.1 * DAY_SECONDS) {
    return QUOTA_WINDOW.daily;
  }
  return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
}

/**
 * Maps a window duration to a canonical user-facing label.
 */
export function windowLabelForSeconds(seconds: number): string {
  if (seconds >= 28 * DAY_SECONDS && seconds <= 31 * DAY_SECONDS) {
    return QUOTA_WINDOW_LABEL[QUOTA_WINDOW.monthly];
  }
  if (seconds >= 6 * DAY_SECONDS && seconds <= 8 * DAY_SECONDS) {
    return QUOTA_WINDOW_LABEL[QUOTA_WINDOW.weekly];
  }
  if (seconds >= 0.9 * DAY_SECONDS && seconds <= 1.1 * DAY_SECONDS) {
    return QUOTA_WINDOW_LABEL[QUOTA_WINDOW.daily];
  }
  return `${Math.max(1, Math.round(seconds / 3600))} Hour`;
}
