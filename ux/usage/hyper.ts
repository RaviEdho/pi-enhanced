import { CREDITS_FETCH_TIMEOUT_MS, CREDITS_URL, HYPER_USER_AGENT, PROVIDER_ID, PROVIDER_NAME } from "../../providers/hyper/constants.js";
import type { CreditsResponse } from "../../providers/hyper/types.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";

/**
 * Fetches the remaining Hypercredit balance from Charm Hyper.
 *
 * Hyper retired its free monthly grant (previously 100 HC/month): Shred
 * subscriptions now provide weekly allowances resetting every Sunday 00:00 UTC,
 * and prepaid credits never expire. The credits endpoint only exposes the
 * current balance — no allowance or reset timestamps — so this report is a
 * plain balance view without a depletable window. Legacy accounts created
 * before the change may still carry a "free" planType; it is no longer echoed
 * since that plan no longer exists.
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

    // 1 Hypercredit = 5¢. The API exposes no allowance, consumption, or reset
    // metadata, so usage fractions cannot be derived honestly — surface the
    // remaining balance as-is instead of fabricating a window.
    const usdVal = (balance * 0.05).toFixed(2);
    const formattedBalance = Number.isInteger(balance) ? balance.toString() : balance.toFixed(2);

    const bucket: QuotaBucket = {
      bucketId: "hypercredits",
      displayName: "Credits",
      window: "balance",
      usedFraction: 0,
      remainingFraction: 1,
      description: `${formattedBalance} Hypercredits available ($${usdVal})`,
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
