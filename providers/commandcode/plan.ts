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

// Manual snapshots of the "Models included" tables:
// https://commandcode.ai/docs/plans/go
// https://commandcode.ai/docs/plans/goat
// https://commandcode.ai/docs/plans/pro
// IDs are lowercased API IDs with the provider prefix removed, not page slugs.
// Keep these as allowlists: a catalog entry alone does not imply plan coverage.
// Coverage is separate from API access (Go currently has no Provider API access).
const GO_MODELS = new Set<string>([
  "kimi-k3.1-pro",
  "ornith-1.5-122b",
  "minimax-m3.1-flash",
  "beam:free",
  "muse-spark-open",
  "nemotron-3.5-super-vl",
  "ling-3.1-flash",
  "glyph-cluster:free",
  "mistral-large-4",
  "deepseek-v4.1-flash-fast",
  "gpt-6-luna",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "step-5-preview",
  "glm-5.3-flashx",
  "qwen3.8-omni-flash",
  "deepseek-v4.1-flash",
  "muse-spark-1.3-contributor",
  "qwen3.8-max-0902",
  "hy4-preview",
  "glm-5.3-flash",
  "longcat-2.0",
  "qwen3.8-flash",
  "deepseek-v4-flash-fast",
  "deepseek-v4-flash-vision-exp",
  "glm-5.3",
  "qwen3.8-27b",
  "deepseek-v4-pro",
  "muse-spark-1.2-contributor",
  "qwen3.8-max",
  "deepseek-v4-flash",
  "inkling-small",
  "qwen3.7-flash",
  "laguna-s-2.1-free",
  "inkling",
  "kimi-k3",
  "gpt-5.6-luna",
  "grok-4.5",
  "hy3-paid",
  "glm-5.2-fast",
  "glm-5.2",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.7-code",
  "nemotron-3-ultra-550b-a55b",
  "minimax-m3",
  "qwen3.7-plus",
  "step-3.7-flash",
  "qwen3.7-max",
  "step-3.5-flash",
  "glm-5.1",
  "minimax-m2.7",
  "qwen3.6-max-preview",
  "qwen3.6-plus",
  "kimi-k2.6",
  "glm-5",
  "kimi-k2.5",
  "minimax-m2.5",
]);

const GOAT_MODELS = new Set<string>([
  ...GO_MODELS,
  "jev-1.14.0",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "qwen3.8-max-prime",
  "jev",
  "mimo-v2.6-pro-ultraspeed",
  "grok-4.7",
  "gemini-3.8-flash",
  "muse-spark-1.3",
  "gemini-3.7-flash",
  "grok-4.6",
  "muse-spark-1.2",
  "gpt-5.6-sol",
]);

const PRO_MODELS = new Set<string>([
  ...GOAT_MODELS,
  "gpt-6.1-terra",
  "gemini-4-argon",
  "gpt-6-sol",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "muse-spark-1.1",
  "gpt-5.6-terra",
  "claude-sonnet-5",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.4",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
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
  const cleanId = modelId.replace(/^[^/]+\//, "").toLowerCase();

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
    return cleanId !== "gpt-6.1-sol" && cleanId !== "muse-wonder-1.0";
  }

  // Pro includes GOAT plus the premium models listed on its plan page.
  if (plan.includes("pro")) {
    return PRO_MODELS.has(cleanId);
  }

  // Match GOAT before Go: their plan IDs share the "go" prefix.
  if (plan.includes("goat")) {
    return GOAT_MODELS.has(cleanId);
  }

  if (plan.includes("go")) {
    return GO_MODELS.has(cleanId);
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
