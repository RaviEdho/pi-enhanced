import { createHash } from "node:crypto";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { connectionFor } from "../../providers/cloudflare/index.js";
import { detectCloudflareWorkersPlan } from "../../providers/cloudflare/plan.js";
import type { ProviderUsageReport } from "./types.js";

const PROVIDER = "cloudflare-workers-ai";
type Connection = { apiToken: string; accountId: string };
export function getCloudflareConnection(): Connection | undefined {
  try { return connectionFor(readStoredCredential(PROVIDER)); }
  catch { return connectionFor(); }
}
export function cloudflareCacheKey(connection: Connection): string {
  return `cloudflare-usage:${createHash("sha256").update(JSON.stringify([connection.accountId, connection.apiToken])).digest("hex")}`;
}

// No dimensions: Cloudflare returns one aggregate for the whole account and interval.
// DateTime and both filter operators are supported by the Workers AI analytics dataset.
const QUERY = `query($accountTag: String!, $start: DateTime!, $end: DateTime!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { totalNeurons }
    }
  } }
}`;
let cached: { key: string; until: number; promise: Promise<ProviderUsageReport> } | undefined;
export function fetchCloudflareUsage(connection: Connection): Promise<ProviderUsageReport> {
  const key = cloudflareCacheKey(connection);
  const now = Date.now();
  if (cached?.key === key && cached.until > now) return cached.promise;
  const date = new Date(now);
  const nextReset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  const promise = poll(connection, date);
  cached = { key, until: Math.min(now + 60_000, nextReset), promise };
  return promise;
}

async function poll(connection: Connection, now: Date): Promise<ProviderUsageReport> {
  const report: ProviderUsageReport = { providerId: PROVIDER, providerName: "Cloudflare Workers AI", fetchedAt: now.getTime(), groups: [], usageUrl: "https://dash.cloudflare.com/" };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const next = new Date(start.getTime() + 86400_000);
  const signal = AbortSignal.timeout(10_000);
  try {
    const [response, plan] = await Promise.all([
      fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST", headers: { Authorization: `Bearer ${connection.apiToken.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { accountTag: connection.accountId.trim(), start: start.toISOString(), end: now.toISOString() } }), signal,
      }),
      detectCloudflareWorkersPlan({ ...connection, signal }),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: any = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length) throw new Error("GraphQL error");
    const accounts = payload?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("Account unavailable");
    const groups = accounts[0]?.aiInferenceAdaptiveGroups;
    if (!Array.isArray(groups) || groups.length >= 1000) throw new Error("Incomplete analytics data");
    let total = 0;
    for (const group of groups) {
      const value = group?.sum?.totalNeurons;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid analytics data");
      total += value;
    }
    if (!Number.isFinite(total)) throw new Error("Invalid analytics total");
    report.planType = plan === "unknown" ? undefined : plan;
    const usedFraction = Math.min(1, total / 10_000);
    report.groups = [{ displayName: "Daily free allocation", buckets: [{ bucketId: "cloudflare-neurons", displayName: "Free allocation", window: "daily", windowSeconds: 86_400, remainingFraction: 1 - usedFraction, usedFraction, resetTime: next.toISOString() }] }];
  } catch {
    report.error = "Workers AI analytics unavailable. Check account ID and token permissions (Account Analytics: Read); inference-only tokens may not grant analytics access.";
  }
  return report;
}
