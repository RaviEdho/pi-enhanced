import { ALLOWANCE_TTL_MS, ALLOWANCE_URL, PROVIDER_ID, PROVIDER_NAME, REQUEST_TIMEOUT_MS, USAGE_URL } from "../../providers/tokenharbor/constants.js";
import { tokenHarborCredentialHash } from "../../providers/tokenharbor/credentials.js";
import { isProviderNetworkEnabled } from "../../providers/network.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";
import { QUOTA_WINDOW } from "./windows.js";

interface Allowance {
  planName?: string;
  onPlan: boolean;
  passUsed: number;
  passExhausted: boolean;
  freeUsed: number;
  freeExhausted: boolean;
  freeEnabled: boolean;
  startedAt?: string;
  resetAt?: string;
  windowSeconds?: number;
}

interface Lookup {
  fetchedAt: number;
  allowance?: Allowance;
  error?: string;
}

// Cache successful and failed lookups alike to bound polling, including during
// outages. Only credential hashes and contract data are cached, never keys,
// account labels, session markers, legacy fields, or model eligibility claims.
const lookups = new Map<string, { startedAt: number; result: Promise<Lookup> }>();

function isoTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseAllowance(value: unknown, key: string): Allowance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid allowance response");
  const a = value as Record<string, unknown>;
  for (const field of ["on_plan", "plan_exhausted", "exhausted", "activated", "models_enabled"]) {
    if (typeof a[field] !== "boolean") throw new Error("Invalid allowance flags");
  }
  for (const field of ["plan_used_pct", "used_pct"]) {
    if (typeof a[field] !== "number" || !Number.isInteger(a[field]) || a[field] < 0 || a[field] > 100) {
      throw new Error("Invalid allowance percentage");
    }
  }
  if (a.plan_name !== null && (typeof a.plan_name !== "string" || !a.plan_name.trim()
    || a.plan_name.length > 100 || a.plan_name.includes(key) || /[\x00-\x1f\x7f-\x9f]/.test(a.plan_name))) {
    throw new Error("Invalid allowance plan");
  }
  if (a.on_plan && !a.plan_name) throw new Error("Missing allowance plan");
  if (!a.on_plan && (a.plan_used_pct !== 0 || a.plan_exhausted !== false)) throw new Error("Invalid inactive Pass allowance");

  const startedAt = isoTimestamp(a.period_started_at);
  const resetAt = isoTimestamp(a.reset_at);
  const endsAt = isoTimestamp(a.period_ends_at);
  if (a.activated) {
    if (!startedAt || !resetAt || !endsAt || Date.parse(resetAt) !== Date.parse(endsAt)
      || Date.parse(startedAt) >= Date.parse(resetAt)) throw new Error("Invalid allowance window");
  } else if (a.period_started_at !== null || a.reset_at !== null || a.period_ends_at !== null
    || a.used_pct !== 0 || a.plan_used_pct !== 0 || a.exhausted || a.plan_exhausted) {
    throw new Error("Invalid unstarted allowance");
  }
  return {
    planName: a.on_plan ? (a.plan_name as string).trim() : undefined,
    onPlan: a.on_plan as boolean,
    passUsed: (a.plan_used_pct as number) / 100,
    passExhausted: a.plan_exhausted as boolean,
    freeUsed: (a.used_pct as number) / 100,
    freeExhausted: a.exhausted as boolean,
    freeEnabled: a.models_enabled as boolean,
    startedAt,
    resetAt,
    windowSeconds: startedAt && resetAt ? (Date.parse(resetAt) - Date.parse(startedAt)) / 1000 : undefined,
  };
}

async function lookupAllowance(key: string, signal?: AbortSignal): Promise<Lookup> {
  const fetchedAt = Date.now();
  const combined = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    combined.throwIfAborted();
    const response = await fetch(ALLOWANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: combined,
      redirect: "error",
    });
    // Do not echo provider errors: they may contain credentials or arbitrary text.
    if (!response.ok) {
      const error = response.status === 401 ? "Token Harbor allowance: unauthorized (401); run /login tokenharbor."
        : response.status === 403 ? "Token Harbor allowance access denied; verify your email in the dashboard."
        : `Token Harbor allowance lookup failed (HTTP ${response.status}).`;
      return { fetchedAt, error };
    }
    return { fetchedAt, allowance: parseAllowance(await response.json(), key) };
  } catch {
    return { fetchedAt, error: signal?.aborted ? "Token Harbor allowance refresh cancelled."
      : combined.aborted ? "Token Harbor allowance lookup timed out."
      : "Token Harbor allowance lookup failed or returned invalid data." };
  }
}

/** Read-only Universal-Key lookup. Never generate inference or import browser credentials. */
export async function fetchTokenHarborUsage(
  apiKey: string,
  label?: string,
  signal?: AbortSignal,
  existingPlanType?: string,
): Promise<ProviderUsageReport> {
  const base: ProviderUsageReport = {
    providerId: PROVIDER_ID, providerName: PROVIDER_NAME, accountEmail: label,
    planType: existingPlanType, fetchedAt: Date.now(), groups: [], usageUrl: USAGE_URL,
  };
  if (signal?.aborted) return { ...base, error: "Token Harbor allowance refresh cancelled." };
  if (!isProviderNetworkEnabled()) return { ...base, error: "Token Harbor allowance refresh is unavailable offline." };
  const key = apiKey.trim();
  if (!key) return { ...base, error: "No Token Harbor key available; run /login tokenharbor." };
  const hash = tokenHarborCredentialHash(key);
  let entry = lookups.get(hash);
  if (!entry || Date.now() - entry.startedAt >= ALLOWANCE_TTL_MS) {
    entry = { startedAt: Date.now(), result: lookupAllowance(key, signal) };
    lookups.set(hash, entry);
    if (lookups.size > 128) lookups.delete(lookups.keys().next().value!);
  }
  let onAbort: (() => void) | undefined;
  const cancelled: Lookup = { fetchedAt: Date.now(), error: "Token Harbor allowance refresh cancelled." };
  const result = signal ? await Promise.race([
    entry.result,
    new Promise<Lookup>(resolve => {
      onAbort = () => resolve(cancelled);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]).finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); }) : await entry.result;
  // Remove a cancelled underlying request, but not another view's healthy lookup.
  void entry.result.then(value => {
    if (value.error === cancelled.error && lookups.get(hash) === entry) lookups.delete(hash);
  });
  if (signal?.aborted) return { ...base, error: cancelled.error };
  if (!result.allowance) return { ...base, fetchedAt: result.fetchedAt, error: result.error };
  const a = result.allowance;
  const bucket = (pass: boolean): QuotaBucket => ({
    bucketId: pass ? "tokenharbor-pass" : "tokenharbor-free",
    displayName: pass ? "Pass · Weekly" : "Free · Weekly",
    window: QUOTA_WINDOW.weekly,
    windowSeconds: a.windowSeconds,
    windowStartedAt: a.startedAt,
    usedFraction: pass ? a.passUsed : a.freeUsed,
    remainingFraction: 1 - (pass ? a.passUsed : a.freeUsed),
    resetTime: a.resetAt,
    exhausted: pass ? a.passExhausted : a.freeExhausted,
    enabled: pass ? undefined : a.freeEnabled,
  });
  return {
    ...base, fetchedAt: result.fetchedAt, planType: a.planName,
    groups: [{ displayName: "Allowances", buckets: [...(a.onPlan ? [bucket(true)] : []), bucket(false)] }],
    capacitySummary: a.onPlan ? undefined : "No active Pass; wallet balance is not provided by the allowance API.",
    capacitySummaryShort: a.onPlan ? undefined : "No Pass · wallet unknown",
  };
}
