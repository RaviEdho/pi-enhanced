import { OPENCODE_GO_ID, OPENCODE_GO_NAME, openCodeGoAccountId } from "../../providers/opencode-go/credentials.js";
import { isProviderNetworkEnabled } from "../../providers/network.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";
import { QUOTA_WINDOW, quotaWindowLabel } from "./windows.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WEEK_SECONDS = 7 * 24 * 3600;
const FIVE_HOUR_SECONDS = 5 * 3600;
const WINDOWS = [
  ["monthly", QUOTA_WINDOW.monthly, undefined],
  ["weekly", QUOTA_WINDOW.weekly, WEEK_SECONDS],
  ["rolling", QUOTA_WINDOW.fiveHour, FIVE_HOUR_SECONDS],
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Verified against the upstream usage route. Missing percentages never become zero. */
export function parseOpenCodeGoUsage(payload: unknown, now = Date.now()): QuotaBucket[] | undefined {
  const usage = asRecord(asRecord(payload)?.usage);
  const buckets: QuotaBucket[] = [];
  for (const [id, window, windowSeconds] of WINDOWS) {
    const raw = asRecord(usage?.[id]);
    const percent = raw?.percent;
    if (!raw || (raw.status !== "ok" && raw.status !== "rate-limited") ||
      typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
    const exhausted = raw.status === "rate-limited";
    const usedFraction = exhausted ? 1 : percent / 100;
    const reset = typeof raw.resetsAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw.resetsAt) ? Date.parse(raw.resetsAt) : NaN;
    // For an idle 5-hour allowance the API can return a placeholder of now + 5h.
    // Zero is rounded, so we can't tell an idle window from an active one at 0%.
    const resetTime = reset > now && (id !== "rolling" || usedFraction > 0) ? new Date(reset).toISOString() : undefined;
    buckets.push({
      bucketId: `${OPENCODE_GO_ID}-${id}`, displayName: quotaWindowLabel(window), window, windowSeconds,
      usedFraction, remainingFraction: 1 - usedFraction, exhausted, resetTime,
      windowStartedAt: id === "weekly" && resetTime ? new Date(reset - WEEK_SECONDS * 1000).toISOString() : undefined,
    });
  }
  return buckets;
}

// Like the shared cache, failures are keyed by exact credential, never a display label.
// Keep transient failures in memory so a first failed poll doesn't show an endless spinner.
const failures = new Map<string, ProviderUsageReport>();
export function getOpenCodeGoUsageFailure(key: string): ProviderUsageReport | undefined {
  return failures.get(openCodeGoAccountId(key));
}

export async function fetchOpenCodeGoUsage(key: string, identity: string, signal?: AbortSignal): Promise<ProviderUsageReport> {
  const base = { providerId: OPENCODE_GO_ID, providerName: OPENCODE_GO_NAME, accountEmail: identity };
  const id = openCodeGoAccountId(key);
  const failure = (error: string): ProviderUsageReport => {
    const report = { ...base, fetchedAt: Date.now(), groups: [], error };
    if (!signal?.aborted) {
      failures.delete(id);
      failures.set(id, report);
      if (failures.size > 32) failures.delete(failures.keys().next().value!);
    }
    return report;
  };
  if (!isProviderNetworkEnabled()) return failure("Quota lookup is disabled in offline mode.");
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failure(response.status === 401 ? "The usage endpoint rejected this API key." :
        response.status === 403 ? "Quota access denied; check your Go subscription and key permissions." :
        `The usage endpoint returned HTTP ${response.status}.`);
    }
    const buckets = parseOpenCodeGoUsage(await response.json().catch(() => undefined));
    if (!buckets) return failure("The usage endpoint returned incomplete or unrecognized quota data.");
    failures.delete(id);
    return { ...base, fetchedAt: Date.now(), groups: [{ displayName: "Go allowance", buckets }] };
  } catch {
    return failure(timeout.aborted ? "OpenCode Go quota lookup timed out." : "OpenCode Go quota lookup failed.");
  }
}
