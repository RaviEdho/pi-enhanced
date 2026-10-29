import { getCodexPlanType } from "../providers/codex/plan.js";
import { loadCachedPlans } from "../providers/kenari/plan.js";
import type { AccountCredential } from "./types.js";

/**
 * Provider-local subscription priority. Unknown, free, and PAYG accounts share
 * the fallback tier; never infer a subscription tier from a credit balance.
 */
export function getAccountTierPriority(account: AccountCredential): number {
  const tokenPlan = account.provider === "openai" || account.provider === "openai-codex"
    ? getCodexPlanType(account.access)
    : null;
  const plan = (tokenPlan ?? account.planType ?? "").trim().toLowerCase();

  switch (account.provider) {
    case "openai":
    case "openai-codex":
      switch (plan) {
        case "enterprise": return 5;
        case "business":
        case "team": return 4;
        case "pro": return 3;
        case "plus": return 2;
        case "go": return 1;
        default: return 0;
      }

    case "google-antigravity": {
      const parts = plan.split(/[^a-z0-9]+/);
      if (parts.includes("ultra")) return 3;
      if (parts.includes("pro")) return 2;
      if (parts.includes("standard")) return 1;
      return 0;
    }

    case "commandcode": {
      const parts = plan.split(/[^a-z0-9]+/);
      // Provider/PAYG keys must not outrank a subscription.
      if (parts.includes("provider")) return 0;
      if (parts.includes("teams") || parts.includes("team")) return 6;
      if (parts.includes("ultra")) return 5;
      if (parts.includes("max")) return 4;
      if (parts.includes("pro")) return 3;
      if (parts.includes("goat")) return 2;
      if (parts.includes("go")) return 1;
      return 0;
    }

    case "kenari": {
      // Use the provider's cached plan catalog instead of hardcoding its tiers.
      const matched = loadCachedPlans().find(
        (p) => p.id.toLowerCase() === plan || p.name.toLowerCase() === plan
      );
      return matched && Number.isFinite(matched.price_idr)
        ? Math.max(0, matched.price_idr)
        : 0;
    }

    // Hyper currently exposes credits, not comparable subscription tiers.
    default:
      return 0;
  }
}

/** Restricts healthy candidates to their highest available subscription tier. */
export function getHighestTierAccounts<T extends { account: AccountCredential }>(candidates: T[]): T[] {
  const ranked = candidates.map((candidate) => ({
    candidate,
    priority: getAccountTierPriority(candidate.account),
  }));
  const highestPriority = ranked.reduce((highest, entry) => Math.max(highest, entry.priority), 0);
  return ranked.filter((entry) => entry.priority === highestPriority).map((entry) => entry.candidate);
}
