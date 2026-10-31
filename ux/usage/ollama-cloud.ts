import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";

/** Ollama documents both credit balances and legacy limits at /api/balance.
 * It does not identify the plan, or specify a duration for legacy session limits.
 * Only use returned reset timestamps; never infer a plan or reset schedule.
 * https://docs.ollama.com/api/balance
 */
interface PollEntry {
  nextPollAt: number;
  promise: Promise<ProviderUsageReport>;
}
const polls = new Map<string, PollEntry>();

/** Credential-scoped in-memory identifier; never expose the credential itself. */
export function getOllamaCredentialId(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

/** Shared by /usage and the footer; hashes are never written to disk. */
export function getOllamaFallbackAuth(): { token: string; label: string } | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"))["ollama-cloud"];
    const token = auth?.key || auth?.access || auth?.apiKey || process.env.OLLAMA_API_KEY;
    if (typeof token === "string" && token.trim()) return { token, label: typeof auth?.email === "string" ? auth.email : "default" };
  } catch {
    // An absent or unreadable auth file must not hide environment credentials.
  }
  const token = process.env.OLLAMA_API_KEY;
  return token?.trim() ? { token, label: "default" } : undefined;
}

export async function fetchOllamaCloudUsage(
  apiKey: string,
  label?: string,
  signal?: AbortSignal,
): Promise<ProviderUsageReport> {
  const cancelled = (): ProviderUsageReport => ({ providerId: "ollama-cloud", providerName: "Ollama Cloud", fetchedAt: Date.now(), groups: [], error: "Balance check cancelled", accountEmail: label });
  if (signal?.aborted) return cancelled();
  const key = getOllamaCredentialId(apiKey);
  const now = Date.now();
  let entry = polls.get(key);
  if (!entry || now >= entry.nextPollAt) {
    const newEntry: PollEntry = {
      nextPollAt: now + 60_000,
      promise: Promise.resolve().then(() => pollOllamaCloudUsage(apiKey, (retryAt) => {
        newEntry.nextPollAt = Math.max(newEntry.nextPollAt, retryAt);
      })),
    };
    entry = newEntry;
    polls.set(key, entry);
  }
  // A caller can stop waiting without cancelling or poisoning the shared poll.
  if (!signal) return { ...await entry.promise, accountEmail: label };
  return new Promise((resolve) => {
    const onAbort = () => resolve(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    entry.promise.then((report) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ ...report, accountEmail: label });
    });
  });
}

async function pollOllamaCloudUsage(
  apiKey: string,
  onRetryAfter: (retryAt: number) => void,
): Promise<ProviderUsageReport> {
  const report: ProviderUsageReport = {
    providerId: "ollama-cloud", providerName: "Ollama Cloud",
    fetchedAt: Date.now(), groups: [], usageUrl: "https://ollama.com/settings",
  };
  try {
    const timeout = AbortSignal.timeout(10000);
    const response = await fetch("https://ollama.com/api/balance", {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      signal: timeout,
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after")?.trim();
        if (retryAfter) {
          const now = Date.now();
          const retryAt = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
          if (Number.isFinite(retryAt)) onRetryAfter(retryAt);
        }
      }
      report.error = `Balance check failed (HTTP ${response.status})`;
      return report;
    }
    const data = await response.json() as {
      included?: { balance_usd?: unknown; allowance_usd?: unknown; period?: { from?: unknown; until?: unknown }; session?: { remaining_percent?: unknown; resets_at?: unknown }; weekly?: { remaining_percent?: unknown; resets_at?: unknown } };
      purchased?: { balance_usd?: unknown };
    };
    const buckets: QuotaBucket[] = [];
    const included = data?.included;
    const validAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const reset = (v: unknown): string | undefined => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
    for (const key of ["session", "weekly"] as const) {
      const limit = included?.[key];
      const remaining = limit?.remaining_percent;
      if (validAmount(remaining) && remaining <= 100) {
        buckets.push({ bucketId: `ollama-cloud-${key}`, displayName: key === "session" ? "Session" : "Weekly", window: key, remainingFraction: remaining / 100, usedFraction: 1 - remaining / 100, resetTime: reset(limit?.resets_at) });
      }
    }
    if (validAmount(included?.balance_usd)) {
      const balance = included.balance_usd;
      const allowance = included.allowance_usd;
      if (validAmount(allowance) && allowance > 0) {
        const remaining = Math.min(1, balance / allowance);
        const from = reset(included.period?.from);
        const until = reset(included.period?.until);
        const durationMs = from && until ? Date.parse(until) - Date.parse(from) : 0;
        buckets.push({ bucketId: "ollama-cloud-included", displayName: "Monthly", window: "monthly", windowSeconds: durationMs > 0 ? durationMs / 1000 : undefined, balanceUsd: balance, remainingFraction: remaining, usedFraction: 1 - remaining, resetTime: until, description: `$${balance.toFixed(2)} / $${allowance.toFixed(2)} available` });
      } else {
        buckets.push({ bucketId: "ollama-cloud-included", displayName: "Monthly", window: "balance", displayMode: "value", balanceUsd: balance, remainingFraction: 1, usedFraction: 0, description: `$${balance.toFixed(2)} available` });
      }
    }
    if (validAmount(data?.purchased?.balance_usd)) {
      buckets.push({ bucketId: "ollama-cloud-purchased", displayName: "Purchased credits", window: "balance", displayMode: "value", balanceUsd: data.purchased.balance_usd, remainingFraction: 1, usedFraction: 0, description: `$${data.purchased.balance_usd.toFixed(2)} available` });
    }
    if (buckets.length) report.groups.push({ displayName: "Balance and limits", buckets });
    else report.quotaUnavailableReason = "Ollama Cloud did not return recognizable balance or quota data.";
  } catch {
    report.error = "Balance check failed (network error or timeout)";
  }
  return report;
}
