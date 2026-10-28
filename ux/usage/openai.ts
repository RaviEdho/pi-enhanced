import type { ProviderUsageReport } from "./types.js";

/**
 * Sign in with ChatGPT grants access to the public Responses API, not the
 * legacy Codex /wham/usage endpoint. No supported quota API is documented for
 * this flow. Keep this informational: unavailable quota data is not an auth error.
 */
export function buildOpenAIUsageReport(account?: {
  email?: string;
  accountId?: string;
  planType?: string;
}): ProviderUsageReport {
  return {
    providerId: "openai",
    providerName: "OpenAI (ChatGPT)",
    accountEmail: account?.email,
    accountId: account?.accountId,
    planType: account?.planType,
    fetchedAt: Date.now(),
    groups: [],
    quotaUnavailableReason: "Quota reporting unavailable for this login (Sign in with ChatGPT).",
    usageUrl: "https://chatgpt.com/settings/usage",
  };
}
