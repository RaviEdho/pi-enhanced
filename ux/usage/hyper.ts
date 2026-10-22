import { CREDITS_FETCH_TIMEOUT_MS, CREDITS_URL, HYPER_USER_AGENT, PROVIDER_ID, PROVIDER_NAME } from "../../providers/hyper/constants.js";
import type { CreditsResponse } from "../../providers/hyper/types.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";
import { QUOTA_WINDOW } from "./windows.js";

/**
 * Calculates the next Sunday 00:00 UTC timestamp.
 * Subscriptions (Shred and Business) reset their weekly Hypercredit allowance
 * every Sunday at 00:00 UTC.
 */
export function getNextSundayMidnightUtc(now = new Date()): Date {
  const next = new Date(now.getTime());
  const day = next.getUTCDay(); // 0 is Sunday
  const daysUntilNextSunday = day === 0 ? 7 : (7 - day);
  next.setUTCDate(next.getUTCDate() + daysUntilNextSunday);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

/**
 * Fetches the remaining Hypercredit balance from Charm Hyper.
 *
 * Hyper retired its free monthly grant (previously 100 HC/month): Shred
 * subscriptions now provide weekly allowances resetting every Sunday 00:00 UTC,
 * Business subscriptions provide higher weekly allowances with ZDR, and
 * prepaid credits never expire.
 */
export async function fetchHyperUsage(
  token: string,
  label?: string,
  signal?: AbortSignal,
  planType?: string
): Promise<ProviderUsageReport> {
  const fetchedAt = Date.now();
  const displayPlan = planType && planType !== "free" ? planType : undefined;

  try {
    const timeoutSignal = AbortSignal.timeout(CREDITS_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": HYPER_USER_AGENT,
      },
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        accountEmail: label,
        planType: displayPlan,
        fetchedAt,
        groups: [],
        error: `Credits check failed (${res.status}): ${errorText}`,
      };
    }

    const data = (await res.json()) as CreditsResponse;
    let balance = data.balance;
    if (balance === undefined && typeof data.balance_usd === "number") {
      balance = data.balance_usd / 0.05;
    }

    if (balance === undefined || typeof balance !== "number") {
      return {
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        accountEmail: label,
        planType: displayPlan,
        fetchedAt,
        groups: [],
        error: "Invalid credits payload received from Hyper",
      };
    }

    // 1 Hypercredit = 5¢.
    const usdVal = (balance * 0.05).toFixed(2);
    const formattedBalance = Number.isInteger(balance) ? balance.toString() : balance.toFixed(2);

    const isSubscription =
      displayPlan?.toLowerCase() === "shred" || displayPlan?.toLowerCase() === "business";
    const nextSunday = getNextSundayMidnightUtc(new Date(fetchedAt));
    const window = isSubscription ? QUOTA_WINDOW.weekly : QUOTA_WINDOW.balance;
    const windowSeconds = isSubscription ? 7 * 24 * 3600 : undefined;
    const resetTime = isSubscription ? nextSunday.toISOString() : undefined;

    // A prepaid/plain balance carries no consumed fraction, so a progress bar
    // would always render as an untouched `100% · ready` window. Only the
    // weekly subscription allowance has a meaningful window to visualize.
    const isBalance = !isSubscription;

    const description = isSubscription
      ? `${formattedBalance} Hypercredits available ($${usdVal}) · Resets Sunday 00:00 UTC`
      : displayPlan?.toLowerCase() === "prepaid"
        ? `${formattedBalance} Hypercredits available ($${usdVal}) · Prepaid (never expires)`
        : `${formattedBalance} Hypercredits available ($${usdVal})`;

    const bucket: QuotaBucket = {
      bucketId: "hypercredits",
      displayName: "Credits",
      window,
      windowSeconds,
      usedFraction: 0,
      remainingFraction: 1,
      resetTime,
      displayMode: isBalance ? "value" : "bar",
      description,
    };

    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType: displayPlan,
      fetchedAt,
      groups: [
        {
          displayName: "Credits",
          buckets: [bucket],
        },
      ],
      capacitySummary: `${formattedBalance} HC ($${usdVal})`,
    };
  } catch (err) {
    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType: displayPlan,
      fetchedAt,
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
