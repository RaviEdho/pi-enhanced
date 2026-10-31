import { fetchAccountList, isRecord } from "./api.js";
import type { CloudflareConnection, CloudflareWorkersPlan } from "./types.js";

/** Recognize only an unambiguous account-scoped Workers Paid subscription. */
export function parseCloudflareWorkersPlan(subscriptions: unknown): CloudflareWorkersPlan {
  if (!Array.isArray(subscriptions)) return "unknown";
  let paid = false;
  let uncertainWorkers = false;
  for (const subscription of subscriptions) {
    if (!isRecord(subscription) || !isRecord(subscription.rate_plan)) continue;
    const { id, scope } = subscription.rate_plan;
    if (typeof id !== "string") continue;
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId.includes("workers")) continue;
    // Partner plans and other Workers IDs have no verified mapping. The account
    // endpoint may omit scope; when present, it must explicitly be account-wide.
    if (normalizedId !== "workers_paid" ||
        (scope !== undefined && (typeof scope !== "string" || scope.toLowerCase() !== "account")) ||
        subscription.state !== "Paid") {
      uncertainWorkers = true;
      continue;
    }
    paid = true;
  }
  // An absent subscription is not sufficient evidence of Workers Free.
  return paid && !uncertainWorkers ? "paid" : "unknown";
}

/** Billing Read may be unavailable to an inference token; failures remain unknown. */
export async function detectCloudflareWorkersPlan(connection: CloudflareConnection): Promise<CloudflareWorkersPlan> {
  try {
    return parseCloudflareWorkersPlan(await fetchAccountList(connection, "subscriptions"));
  } catch (error) {
    if (connection.signal?.aborted) throw error;
    return "unknown";
  }
}

