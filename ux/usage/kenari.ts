import {
  ACCOUNT_BALANCE_URL,
  ACCOUNT_QUOTA_URL,
  API_TIMEOUT_MS,
  KENARI_USER_AGENT,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "../../providers/kenari/constants.js";
import { updateCachedKenariBilling } from "../../providers/kenari/plan.js";
import { QUOTA_WINDOW, QUOTA_WINDOW_LABEL, QUOTA_WINDOW_SHORT_LABEL } from "./windows.js";
import type {
  KenariBalanceResponse,
  KenariQuotaResponse,
} from "../../providers/kenari/types.js";
import type { ProviderUsageReport, QuotaBucket, QuotaGroup } from "./types.js";

/**
 * Fetches subscription quota windows and prepaid balance from Kenari.
 */
export async function fetchKenariUsage(
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
      Authorization: `Bearer ${apiKey.trim()}`,
      "User-Agent": KENARI_USER_AGENT,
      Accept: "application/json",
    };

    const [quotaRes, balanceRes] = await Promise.all([
      fetch(ACCOUNT_QUOTA_URL, { headers, signal: combinedSignal }).catch(() => null),
      fetch(ACCOUNT_BALANCE_URL, { headers, signal: combinedSignal }).catch(() => null),
    ]);

    if ((!quotaRes || !quotaRes.ok) && (!balanceRes || !balanceRes.ok)) {
      const errorText = quotaRes ? await quotaRes.text() : "Failed to fetch Kenari account usage";
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

    const quotaData = quotaRes && quotaRes.ok ? ((await quotaRes.json()) as KenariQuotaResponse) : null;
    const balanceData = balanceRes && balanceRes.ok ? ((await balanceRes.json()) as KenariBalanceResponse) : null;

    const availableMicroIdr = balanceData?.available_micro_idr ?? 0;
    updateCachedKenariBilling(apiKey, {
      planName: quotaData?.plan?.name,
      availableMicroIdr,
      hasBalance: availableMicroIdr > 0,
      couponScope:
        quotaData?.coupon && (quotaData.coupon.remaining_rp === null || quotaData.coupon.remaining_rp > 0)
          ? quotaData.coupon.scope_models
          : undefined,
      fetchedAt,
    });

    const planType = quotaData?.plan?.name || existingPlanType || "PAYG";

    const groups: QuotaGroup[] = [];
    const planWindows = quotaData?.plan?.windows;

    // 1. Subscription plan quota windows
    if (planWindows) {
      const quotaBuckets: QuotaBucket[] = [];

      if (planWindows.five_hour && planWindows.five_hour.budget_rp > 0) {
        const w = planWindows.five_hour;
        quotaBuckets.push({
          bucketId: "kenari-5hour",
          displayName: QUOTA_WINDOW_LABEL[QUOTA_WINDOW.fiveHour],
          window: QUOTA_WINDOW.fiveHour,
          windowSeconds: 5 * 3600,
          usedFraction: w.used_frac,
          remainingFraction: Math.max(0, 1 - w.used_frac),
          resetTime: w.resets_at,
          description: `Rp ${w.used_rp.toLocaleString("id-ID")} / Rp ${w.budget_rp.toLocaleString("id-ID")} used`,
        });
      }

      if (planWindows.week && planWindows.week.budget_rp > 0) {
        const w = planWindows.week;
        quotaBuckets.push({
          bucketId: "kenari-weekly",
          displayName: QUOTA_WINDOW_LABEL[QUOTA_WINDOW.weekly],
          window: QUOTA_WINDOW.weekly,
          windowSeconds: 7 * 86400,
          usedFraction: w.used_frac,
          remainingFraction: Math.max(0, 1 - w.used_frac),
          resetTime: w.resets_at,
          description: `Rp ${w.used_rp.toLocaleString("id-ID")} / Rp ${w.budget_rp.toLocaleString("id-ID")} used`,
        });
      }

      if (planWindows.month && planWindows.month.budget_rp > 0) {
        const w = planWindows.month;
        quotaBuckets.push({
          bucketId: "kenari-monthly",
          displayName: QUOTA_WINDOW_LABEL[QUOTA_WINDOW.monthly],
          window: QUOTA_WINDOW.monthly,
          windowSeconds: 30 * 86400,
          usedFraction: w.used_frac,
          remainingFraction: Math.max(0, 1 - w.used_frac),
          resetTime: w.resets_at,
          description: `Rp ${w.used_rp.toLocaleString("id-ID")} / Rp ${w.budget_rp.toLocaleString("id-ID")} used`,
        });
      }

      if (quotaBuckets.length > 0) {
        groups.push({
          displayName: `Plan Quota (${planType})`,
          buckets: quotaBuckets,
        });
      }
    }

    // 2. Prepaid Balance
    let availableIdr = 0;
    if (balanceData && typeof balanceData.available_micro_idr === "number") {
      availableIdr = balanceData.available_micro_idr / 1_000_000;
      const reservedIdr = (balanceData.reserved_micro_idr || 0) / 1_000_000;

      const balanceBucket: QuotaBucket = {
        bucketId: "kenari-balance",
        displayName: "Prepaid Balance",
        window: QUOTA_WINDOW.prepaid,
        displayMode: "value",
        usedFraction: 0,
        remainingFraction: 1,
        description: `Rp ${Math.round(availableIdr).toLocaleString("id-ID")} available${reservedIdr > 0 ? ` (Rp ${Math.round(reservedIdr).toLocaleString("id-ID")} held)` : ""}`,
      };

      groups.push({
        displayName: "Balance",
        buckets: [balanceBucket],
      });
    }

    // 3. Active Coupon (if present)
    if (quotaData?.coupon) {
      const c = quotaData.coupon;
      const remainingDesc = c.remaining_rp !== null ? `Rp ${c.remaining_rp.toLocaleString("id-ID")} remaining` : "unlimited";
      groups.push({
        displayName: "Active Coupon",
        buckets: [
          {
            bucketId: "kenari-coupon",
            displayName: c.name || "Coupon",
            window: QUOTA_WINDOW.coupon,
            displayMode: "value",
            usedFraction: 0,
            remainingFraction: 1,
            resetTime: c.expires_at,
            description: `${remainingDesc} (expires ${c.expires_at})`,
          },
        ],
      });
    }

    let capacitySummary = `Rp ${Math.round(availableIdr).toLocaleString("id-ID")} available`;
    let capacitySummaryShort = capacitySummary;
    if (planWindows?.five_hour && planWindows.five_hour.budget_rp > 0) {
      capacitySummary = `Rp ${planWindows.five_hour.remaining_rp.toLocaleString("id-ID")} (${QUOTA_WINDOW_LABEL[QUOTA_WINDOW.fiveHour]}) · Rp ${Math.round(availableIdr).toLocaleString("id-ID")} bal`;
      capacitySummaryShort = `Rp ${planWindows.five_hour.remaining_rp.toLocaleString("id-ID")} (${QUOTA_WINDOW_SHORT_LABEL[QUOTA_WINDOW.fiveHour]}) · Rp ${Math.round(availableIdr).toLocaleString("id-ID")} bal`;
    } else if (planWindows?.week && planWindows.week.budget_rp > 0) {
      capacitySummary = `Rp ${planWindows.week.remaining_rp.toLocaleString("id-ID")} (${QUOTA_WINDOW_LABEL[QUOTA_WINDOW.weekly]}) · Rp ${Math.round(availableIdr).toLocaleString("id-ID")} bal`;
      capacitySummaryShort = `Rp ${planWindows.week.remaining_rp.toLocaleString("id-ID")} (${QUOTA_WINDOW_SHORT_LABEL[QUOTA_WINDOW.weekly]}) · Rp ${Math.round(availableIdr).toLocaleString("id-ID")} bal`;
    }

    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType,
      fetchedAt,
      groups,
      capacitySummary,
      capacitySummaryShort,
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
