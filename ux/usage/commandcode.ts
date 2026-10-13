import {
  API_TIMEOUT_MS,
  COMMANDCODE_USER_AGENT,
  CREDITS_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  SUBSCRIPTIONS_URL,
  USAGE_SUMMARY_URL,
} from "../../providers/commandcode/constants.js";
import { getPlanDisplayName } from "../../providers/commandcode/plan.js";
import type {
  CommandCodeCreditsResponse,
  CommandCodeSubscriptionsResponse,
  CommandCodeUsageSummaryResponse,
} from "../../providers/commandcode/types.js";
import type { ProviderUsageReport, QuotaBucket, QuotaGroup } from "./types.js";

/**
 * Fetches the credit balance, subscription plan, and rolling window rate limits from Command Code.
 */
export async function fetchCommandCodeUsage(
  apiKey: string,
  label?: string,
  signal?: AbortSignal,
  existingPlanType?: string
): Promise<ProviderUsageReport> {
  const fetchedAt = Date.now();

  try {
    const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": COMMANDCODE_USER_AGENT,
      Accept: "application/json",
    };

    const [subRes, credRes, summaryRes] = await Promise.all([
      fetch(SUBSCRIPTIONS_URL, { headers, signal: combinedSignal }),
      fetch(CREDITS_URL, { headers, signal: combinedSignal }),
      fetch(USAGE_SUMMARY_URL, { headers, signal: combinedSignal }),
    ]);

    if (!credRes.ok && !subRes.ok) {
      const errorText = await (credRes.ok ? subRes.text() : credRes.text());
      return {
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        accountEmail: label,
        planType: existingPlanType,
        fetchedAt,
        groups: [],
        error: `Usage check failed: ${errorText}`,
      };
    }

    const subData = subRes.ok ? ((await subRes.json()) as CommandCodeSubscriptionsResponse) : null;
    const credData = credRes.ok ? ((await credRes.json()) as CommandCodeCreditsResponse) : null;
    const summaryData = summaryRes.ok ? ((await summaryRes.json()) as CommandCodeUsageSummaryResponse) : null;

    const rawPlan = subData?.data?.planId || credData?.credits?.planId || existingPlanType;
    const planType = getPlanDisplayName(rawPlan);

    const monthlyRemaining = Math.max(0, credData?.credits?.monthlyCredits ?? 0);
    const purchasedRemaining = Math.max(0, credData?.credits?.purchasedCredits ?? 0);
    const freeRemaining = Math.max(0, credData?.credits?.freeCredits ?? 0);
    const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
    const totalSpent = Math.max(0, summaryData?.totalCost ?? 0);

    const totalPool = monthlyRemaining + totalSpent;
    const usedFraction = totalPool > 0 ? Math.min(1, Math.max(0, totalSpent / totalPool)) : 0;
    const remainingFraction = Math.max(0, 1 - usedFraction);

    const creditBuckets: QuotaBucket[] = [];

    creditBuckets.push({
      bucketId: "commandcode-credits",
      displayName: "Monthly Pool",
      window: "monthly",
      windowSeconds: 30 * 86400,
      usedFraction,
      remainingFraction,
      resetTime: subData?.data?.currentPeriodEnd,
      description: `$${monthlyRemaining.toFixed(2)} remaining ($${totalPool.toFixed(2)} monthly)`,
    });

    if (purchasedRemaining > 0) {
      creditBuckets.push({
        bucketId: "commandcode-extra",
        displayName: "Extra Credits",
        window: "on-demand",
        usedFraction: 0,
        remainingFraction: 1,
        description: `$${purchasedRemaining.toFixed(2)} on-demand (never expires)`,
      });
    }

    const groups: QuotaGroup[] = [
      {
        displayName: "Credits",
        buckets: creditBuckets,
      },
    ];

    const windowLimits = credData?.credits?.windowLimits;
    const limitBuckets: QuotaBucket[] = [];

    if (windowLimits?.fiveHour && windowLimits.fiveHour.cap > 0) {
      const { used, cap, resetAt } = windowLimits.fiveHour;
      const uFrac = Math.min(1, Math.max(0, used / cap));
      limitBuckets.push({
        bucketId: "commandcode-5hour",
        displayName: "5-Hour Window",
        window: "5-hour",
        windowSeconds: 5 * 3600,
        usedFraction: uFrac,
        remainingFraction: Math.max(0, 1 - uFrac),
        resetTime: resetAt,
        description: `$${used.toFixed(2)} of $${cap.toFixed(2)} used`,
      });
    }

    if (windowLimits?.weekly && windowLimits.weekly.cap > 0) {
      const { used, cap, resetAt } = windowLimits.weekly;
      const uFrac = Math.min(1, Math.max(0, used / cap));
      limitBuckets.push({
        bucketId: "commandcode-weekly",
        displayName: "Weekly Window",
        window: "weekly",
        windowSeconds: 7 * 86400,
        usedFraction: uFrac,
        remainingFraction: Math.max(0, 1 - uFrac),
        resetTime: resetAt,
        description: `$${used.toFixed(2)} of $${cap.toFixed(2)} used`,
      });
    }

    if (limitBuckets.length > 0) {
      groups.push({
        displayName: "Usage Limits",
        buckets: limitBuckets,
      });
    }

    let capacitySummary = `$${totalRemaining.toFixed(2)} remaining`;
    if (windowLimits?.fiveHour && windowLimits.fiveHour.cap > 0) {
      const avail5h = Math.max(0, windowLimits.fiveHour.cap - windowLimits.fiveHour.used);
      capacitySummary = `$${avail5h.toFixed(2)} / $${windowLimits.fiveHour.cap.toFixed(2)} (5h) · $${totalRemaining.toFixed(2)} total`;
    }

    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType,
      fetchedAt,
      groups,
      capacitySummary,
    };
  } catch (err) {
    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType: existingPlanType,
      fetchedAt,
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
