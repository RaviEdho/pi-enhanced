import {
  API_TIMEOUT_MS,
  CREDITS_URL,
  SUBSCRIPTIONS_URL,
} from "./constants.js";
import type {
  AccountBillingInfo,
  CommandCodeCreditsResponse,
  CommandCodeSubscriptionsResponse,
} from "./types.js";

// Models explicitly classified as premium tier by Command Code.
// Models not in this set default to "opensource" (which are allowed on GOAT, Pro, Max).
const PREMIUM_MODELS = new Set<string>([
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "google/gemini-4-argon",
  "meta/muse-wonder-1.0",
  "sakana/fugu-ultra",
]);

// Ultra-premium models blocked on the Pro plan ($20/mo)
const PRO_BLOCKED_MODELS = new Set<string>([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "meta/muse-wonder-1.0",
  "sakana/fugu-ultra",
]);

// Models blocked on the entry Go plan ($1/mo)
const GO_BLOCKED_MODELS = new Set<string>([
  ...PREMIUM_MODELS,
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-5.6-sol",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.3",
  "xai/grok-4.6",
  "xai/grok-4.7",
  "xiaomi/mimo-v2.6-pro-ultraspeed",
]);

const billingCache = new Map<string, AccountBillingInfo>();

/**
 * Fetches billing and credit status for an API key.
 */
export async function fetchBillingInfo(
  apiKey: string,
  signal?: AbortSignal
): Promise<AccountBillingInfo | null> {
  const cached = billingCache.get(apiKey);
  if (cached && Date.now() - cached.fetchedAt < 60000) {
    return cached;
  }

  try {
    const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const [subRes, credRes] = await Promise.all([
      fetch(SUBSCRIPTIONS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: combinedSignal,
      }),
      fetch(CREDITS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: combinedSignal,
      }),
    ]);

    if (!subRes.ok && !credRes.ok) {
      return null;
    }

    const subData = subRes.ok ? ((await subRes.json()) as CommandCodeSubscriptionsResponse) : null;
    const credData = credRes.ok ? ((await credRes.json()) as CommandCodeCreditsResponse) : null;

    const info: AccountBillingInfo = {
      planId: subData?.data?.planId || credData?.credits?.planId,
      status: subData?.data?.status,
      monthlyCredits: credData?.credits?.monthlyCredits ?? 0,
      purchasedCredits: credData?.credits?.purchasedCredits ?? 0,
      freeCredits: credData?.credits?.freeCredits ?? 0,
      currentPeriodEnd: subData?.data?.currentPeriodEnd,
      fetchedAt: Date.now(),
    };

    billingCache.set(apiKey, info);
    return info;
  } catch {
    return cached || null;
  }
}

/**
 * Checks whether a model is covered by the plan itself (without requiring extra purchased credits).
 */
export function isModelCoveredByPlan(
  modelId: string,
  planId?: string
): boolean {
  if (!planId) return false;
  const plan = planId.toLowerCase();
  const cleanId = modelId.replace(/^[^/]+\//, "");

  // Max / Ultra / Teams plans have access to all models
  if (
    plan.includes("max") ||
    plan.includes("ultra") ||
    plan.includes("team")
  ) {
    return true;
  }

  // Provider pay-as-you-go plan allows virtually all models except unreleased experiments
  if (plan.includes("provider")) {
    return cleanId !== "gpt-6.1-sol" && cleanId !== "meta/muse-wonder-1.0";
  }

  // Pro plan allows open-source and standard premium, but gates ultra-premium (Opus, Fable, GPT-6 Astra)
  if (plan.includes("pro")) {
    return !PRO_BLOCKED_MODELS.has(cleanId);
  }

  // GOAT plan ($10/mo) allows open-source models + Sonnet 5.5, Haiku, Gemini 3.7, GPT-5.6 Sol
  if (plan.includes("goat")) {
    return !PREMIUM_MODELS.has(cleanId);
  }

  // Go plan ($1/mo) has entry restrictions
  if (plan.includes("go")) {
    return !GO_BLOCKED_MODELS.has(cleanId);
  }

  // Default allow
  return true;
}

/**
 * Checks whether a given model is allowed under the account's plan and credit status.
 */
export function isModelAllowedForBilling(
  modelId: string,
  billing?: AccountBillingInfo | null
): boolean {
  if (!billing) {
    // If billing is not yet resolved, allow by default
    return true;
  }

  // If the user has extra purchased credits or promotional free credits, all models are allowed
  if (billing.purchasedCredits > 0 || billing.freeCredits > 0) {
    return true;
  }

  return isModelCoveredByPlan(modelId, billing.planId);
}

/**
 * Returns human-readable plan name.
 */
export function getPlanDisplayName(planId?: string): string {
  if (!planId) return "Unknown";
  const p = planId.toLowerCase();
  if (p.includes("goat")) return "GOAT";
  if (p.includes("pro")) return "Pro";
  if (p.includes("provider")) return "Provider";
  if (p.includes("ultra")) return "Ultra";
  if (p.includes("max")) return "Max";
  if (p.includes("go")) return "Go";
  return planId;
}
