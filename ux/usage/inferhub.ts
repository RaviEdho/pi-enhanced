import { isProviderNetworkEnabled } from "../../providers/network.js";
import { PROVIDER_ID, PROVIDER_NAME, USAGE_URL } from "../../providers/inferhub/constants.js";
import { fetchInferHubJson, record } from "../../providers/inferhub/http.js";
import { inferHubCredentialHash } from "../../providers/inferhub/credentials.js";
import type { ProviderUsageReport } from "./types.js";
import { QUOTA_WINDOW } from "./windows.js";

// Errors are display-only memory state, never persisted as successful quota reports.
const failures = new Map<string, ProviderUsageReport>();
export function getInferHubUsageFailure(key: string): ProviderUsageReport | undefined {
  return failures.get(inferHubCredentialHash(key));
}

/** Read-only inference surface: works with inference_only keys, without /api/me. */
export async function fetchInferHubUsage(key: string, label?: string, signal?: AbortSignal): Promise<ProviderUsageReport> {
  const base: ProviderUsageReport = { providerId: PROVIDER_ID, providerName: PROVIDER_NAME,
    accountEmail: label, fetchedAt: Date.now(), groups: [], usageUrl: "https://inferhub.dev" };
  if (signal?.aborted) return { ...base, error: "InferHub balance refresh cancelled." };
  if (!isProviderNetworkEnabled()) return { ...base, error: "InferHub balance refresh is unavailable offline." };
  if (!key.trim()) return { ...base, error: "No InferHub API key; run /login inferhub." };
  try {
    const value = record(await fetchInferHubJson(USAGE_URL, key.trim(), signal));
    const balance = record(value?.balance)?.amount_usdc;
    // Unknown/malformed balances are not zero. Never invent subscription windows or resets.
    if (value?.object !== "account.usage" || value.currency !== "USDC" || typeof balance !== "string"
      || !/^\d+(?:\.\d{1,6})?$/.test(balance) || !Number.isFinite(Number(balance))) {
      throw new Error("InferHub returned an invalid balance response.");
    }
    failures.delete(inferHubCredentialHash(key));
    return { ...base, fetchedAt: Date.now(), groups: [{ displayName: "Balance", buckets: [{
      bucketId: "inferhub-balance", displayName: "Balance", window: QUOTA_WINDOW.balance,
      displayMode: "value", balanceAmount: Number(balance), usedFraction: 0, remainingFraction: 0,
      description: `${balance} USDC`,
    }] }] };
  } catch (error) {
    const failure = { ...base, error: signal?.aborted ? "InferHub balance refresh cancelled."
      : error instanceof Error ? error.message : "InferHub balance lookup failed." };
    if (!signal?.aborted) {
      failures.set(inferHubCredentialHash(key), failure);
      if (failures.size > 128) failures.delete(failures.keys().next().value!);
    }
    return failure;
  }
}
