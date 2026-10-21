import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  ACCOUNT_BALANCE_URL,
  ACCOUNT_QUOTA_URL,
  API_TIMEOUT_MS,
  KENARI_USER_AGENT,
  PLANS_URL,
} from "./constants.js";
import type {
  KenariAccountBilling,
  KenariBalanceResponse,
  KenariPlan,
  KenariQuotaResponse,
} from "./types.js";

export const DEFAULT_KENARI_PLANS: KenariPlan[] = [
  {
    id: "plan-ringan-v3",
    name: "Indie",
    price_idr: 49000,
    scope_models: [
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-1-flash",
      "deepseek-v4-pro",
      "gemini-3-7-flash",
      "gemini-3-8-flash",
      "gemma-4-31b-it",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "gpt-5-6-luna",
      "gpt-6-luna",
      "gpt-oss-120b",
      "grok-4-6",
      "grok-4-7",
      "hy3",
      "hy4-preview",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k3",
      "mimo-v2-5",
      "mimo-v2-6-flash",
      "mimo-v2-5-pro",
      "mimo-v2-6-pro",
      "minimax-m3",
      "minimax-m3-1-flash",
      "muse-spark-1-2",
      "muse-spark-1-3",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3-contributor",
      "muse-wonder-1-0",
      "nemotron-3-super-120b-a12b",
      "qwen3-8-flash",
      "qwen3-8-max",
      "qwen3-8-omni-flash",
      "qwen3-7-plus",
      "step-5-preview",
    ],
  },
  {
    id: "plan-kreator-v3",
    name: "Kreator",
    price_idr: 99000,
    scope_models: [
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-1-flash",
      "deepseek-v4-pro",
      "gemini-3-7-flash",
      "gemini-3-8-flash",
      "gemma-4-31b-it",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "gpt-5-6-luna",
      "gpt-6-luna",
      "gpt-oss-120b",
      "gpt-6-1-sol",
      "grok-4-6",
      "grok-4-7",
      "hy3",
      "hy4-preview",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k3",
      "mimo-v2-5",
      "mimo-v2-6-flash",
      "mimo-v2-5-pro",
      "mimo-v2-6-pro",
      "minimax-m3",
      "minimax-m3-1-flash",
      "muse-spark-1-2",
      "muse-spark-1-3",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3-contributor",
      "muse-wonder-1-0",
      "nemotron-3-super-120b-a12b",
      "qwen3-8-flash",
      "qwen3-8-max",
      "qwen3-8-omni-flash",
      "qwen3-7-plus",
      "step-5-preview",
    ],
  },
  {
    id: "plan-studio-v3",
    name: "Studio",
    price_idr: 199000,
    scope_models: [
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-1-flash",
      "deepseek-v4-pro",
      "gemini-3-7-flash",
      "gemini-3-8-flash",
      "gemma-4-31b-it",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "gpt-5-6-luna",
      "gpt-6-luna",
      "gpt-oss-120b",
      "gpt-6-sol",
      "gpt-6-1-sol",
      "grok-4-6",
      "grok-4-7",
      "hy3",
      "hy4-preview",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k3",
      "mimo-v2-5",
      "mimo-v2-6-flash",
      "mimo-v2-5-pro",
      "mimo-v2-6-pro",
      "minimax-m3",
      "minimax-m3-1-flash",
      "muse-spark-1-2",
      "muse-spark-1-3",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3-contributor",
      "muse-wonder-1-0",
      "nemotron-3-super-120b-a12b",
      "qwen3-8-flash",
      "qwen3-8-max",
      "qwen3-8-omni-flash",
      "qwen3-7-plus",
      "step-5-preview",
    ],
  },
  {
    id: "plan-agensi-v3",
    name: "Agensi",
    price_idr: 999000,
    scope_models: [
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-1-flash",
      "deepseek-v4-pro",
      "gemini-3-6-flash",
      "gemini-3-7-flash",
      "gemini-3-8-flash",
      "gemma-4-31b-it",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "gpt-6-astra",
      "gpt-5-6-luna",
      "gpt-6-luna",
      "gpt-oss-120b",
      "gpt-5-6-sol",
      "gpt-6-sol",
      "gpt-6-1-sol",
      "gpt-5-6-terra",
      "grok-4-6",
      "grok-4-7",
      "hy3",
      "hy4-preview",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k3",
      "mimo-v2-5",
      "mimo-v2-6-flash",
      "mimo-v2-5-pro",
      "mimo-v2-6-pro",
      "minimax-m3",
      "minimax-m3-1-flash",
      "muse-spark-1-2",
      "muse-spark-1-3",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3-contributor",
      "muse-wonder-1-0",
      "nemotron-3-super-120b-a12b",
      "qwen3-8-flash",
      "qwen3-8-max",
      "qwen3-8-omni-flash",
      "qwen3-7-plus",
      "step-5-preview",
    ],
  },
  {
    id: "d4393180-e56a-4833-9d21-8fcf8b95318a",
    name: "Enterprise",
    price_idr: 1999000,
    scope_models: [
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-1-flash",
      "deepseek-v4-pro",
      "gemini-3-6-flash",
      "gemini-3-7-flash",
      "gemini-3-8-flash",
      "gemma-4-31b-it",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "gpt-6-astra",
      "gpt-5-6-luna",
      "gpt-6-luna",
      "gpt-oss-120b",
      "gpt-5-6-sol",
      "gpt-6-sol",
      "gpt-6-1-sol",
      "gpt-5-6-terra",
      "grok-4-6",
      "grok-4-7",
      "hy3",
      "hy4-preview",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k3",
      "mimo-v2-5",
      "mimo-v2-6-flash",
      "mimo-v2-5-pro",
      "mimo-v2-6-pro",
      "minimax-m3",
      "minimax-m3-1-flash",
      "muse-spark-1-2",
      "muse-spark-1-3",
      "muse-spark-1-2-contributor",
      "muse-spark-1-3-contributor",
      "muse-wonder-1-0",
      "nemotron-3-super-120b-a12b",
      "qwen3-8-flash",
      "qwen3-8-max",
      "qwen3-8-omni-flash",
      "qwen3-7-plus",
      "step-5-preview",
    ],
  },
];

function getPlansCachePath(): string {
  return join(homedir(), ".pi/agent/kenari-plans.json");
}

function getBillingCachePath(): string {
  return join(homedir(), ".pi/agent/kenari-billing.json");
}

const inMemoryBillingCache = new Map<string, KenariAccountBilling>();
let inMemoryPlans: KenariPlan[] | null = null;

export function loadCachedPlans(): KenariPlan[] {
  if (inMemoryPlans && inMemoryPlans.length > 0) {
    return inMemoryPlans;
  }
  try {
    const file = getPlansCachePath();
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        inMemoryPlans = parsed;
        return parsed;
      }
    }
  } catch {
    // Fall back to default plans
  }
  inMemoryPlans = DEFAULT_KENARI_PLANS;
  return DEFAULT_KENARI_PLANS;
}

export function saveCachedPlans(plans: KenariPlan[]): void {
  try {
    inMemoryPlans = plans;
    const file = getPlansCachePath();
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(file, JSON.stringify(plans, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Ignore cache write error
  }
}

/**
 * Loads persisted billing cache from disk.
 */
function loadDiskBillingCache(): Record<string, KenariAccountBilling> {
  try {
    const file = getBillingCachePath();
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      return JSON.parse(raw) as Record<string, KenariAccountBilling>;
    }
  } catch {
    // Ignore
  }
  return {};
}

/**
 * Saves billing cache to disk.
 */
function saveDiskBillingCache(data: Record<string, KenariAccountBilling>): void {
  try {
    const file = getBillingCachePath();
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(file, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Ignore
  }
}

/**
 * Retrieves cached billing info for an API key.
 */
export function getCachedKenariBilling(apiKey?: string): KenariAccountBilling | null {
  if (!apiKey) return null;
  const key = apiKey.trim();
  const memory = inMemoryBillingCache.get(key);
  if (memory) return memory;

  const disk = loadDiskBillingCache();
  if (disk[key]) {
    inMemoryBillingCache.set(key, disk[key]);
    return disk[key];
  }

  return null;
}

/**
 * Updates in-memory and disk cache for an API key's billing status.
 */
export function updateCachedKenariBilling(
  apiKey: string,
  billing: Partial<KenariAccountBilling>
): KenariAccountBilling {
  const key = apiKey.trim();
  const existing = getCachedKenariBilling(key);
  const updated: KenariAccountBilling = {
    planId: billing.planId ?? existing?.planId,
    planName: billing.planName ?? existing?.planName,
    availableMicroIdr: billing.availableMicroIdr ?? existing?.availableMicroIdr ?? 0,
    hasBalance: (billing.availableMicroIdr ?? existing?.availableMicroIdr ?? 0) > 0,
    couponScope: billing.couponScope ?? existing?.couponScope,
    fetchedAt: billing.fetchedAt ?? Date.now(),
  };

  inMemoryBillingCache.set(key, updated);

  try {
    const disk = loadDiskBillingCache();
    disk[key] = updated;
    saveDiskBillingCache(disk);
  } catch {
    // Ignore
  }

  return updated;
}

/**
 * Fetches dynamic plan tier definitions from Kenari.
 */
export async function fetchKenariPlans(signal?: AbortSignal): Promise<KenariPlan[]> {
  try {
    const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(PLANS_URL, {
      headers: {
        "User-Agent": KENARI_USER_AGENT,
        Accept: "application/json",
      },
      signal: combinedSignal,
    });

    if (!res.ok) {
      return loadCachedPlans();
    }

    const plans = (await res.json()) as KenariPlan[];
    if (Array.isArray(plans) && plans.length > 0) {
      saveCachedPlans(plans);
      return plans;
    }
  } catch {
    // Ignore
  }

  return loadCachedPlans();
}

/**
 * Fetches billing, quota, and prepaid balance status for a Kenari API key.
 */
export async function fetchKenariBillingInfo(
  apiKey: string,
  signal?: AbortSignal
): Promise<KenariAccountBilling | null> {
  const key = apiKey.trim();
  const cached = getCachedKenariBilling(key);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached;
  }

  try {
    const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers = {
      Authorization: `Bearer ${key}`,
      "User-Agent": KENARI_USER_AGENT,
      Accept: "application/json",
    };

    const [quotaRes, balanceRes] = await Promise.all([
      fetch(ACCOUNT_QUOTA_URL, { headers, signal: combinedSignal }).catch(() => null),
      fetch(ACCOUNT_BALANCE_URL, { headers, signal: combinedSignal }).catch(() => null),
    ]);

    if ((!quotaRes || !quotaRes.ok) && (!balanceRes || !balanceRes.ok)) {
      return cached;
    }

    const quotaData = quotaRes && quotaRes.ok ? ((await quotaRes.json()) as KenariQuotaResponse) : null;
    const balanceData = balanceRes && balanceRes.ok ? ((await balanceRes.json()) as KenariBalanceResponse) : null;

    const availableMicroIdr =
      typeof balanceData?.available_micro_idr === "number" ? balanceData.available_micro_idr : 0;
    const planName = quotaData?.plan?.name || undefined;
    const couponScope =
      quotaData?.coupon && (quotaData.coupon.remaining_rp === null || quotaData.coupon.remaining_rp > 0)
        ? quotaData.coupon.scope_models
        : undefined;

    return updateCachedKenariBilling(key, {
      planName,
      availableMicroIdr,
      hasBalance: availableMicroIdr > 0,
      couponScope,
      fetchedAt: Date.now(),
    });
  } catch {
    return cached;
  }
}

/**
 * Determines whether a model is a free model.
 */
export function isKenariFreeModel(modelId: string): boolean {
  return modelId.endsWith(":free") || modelId === "kenari-free";
}

/**
 * Matches a plan identifier (name or id) against known plan schemas.
 */
export function findMatchingKenariPlan(
  identifier: string | undefined | null,
  plans: KenariPlan[]
): KenariPlan | undefined {
  if (!identifier) return undefined;
  const clean = identifier.trim().toLowerCase();
  if (clean === "free" || clean === "payg" || clean === "none") return undefined;

  return plans.find(
    (p) =>
      p.id.toLowerCase() === clean ||
      p.name.toLowerCase() === clean ||
      clean.includes(p.name.toLowerCase()) ||
      p.name.toLowerCase().includes(clean)
  );
}

/**
 * Checks whether a given model is allowed under the account's plan and balance status.
 *
 * Rules:
 * 1. Free models (:free, kenari-free) are ALWAYS allowed.
 * 2. If no credentials, no plan, and no prepaid balance: ONLY free models are allowed.
 * 3. If account has available prepaid balance (> 0 IDR): ALL models are allowed (PAYG bypass).
 * 4. If account has an active coupon scoping this model: allowed.
 * 5. If account is subscribed to a plan: only models included in that plan's scope_models are allowed.
 */
export function isModelAllowedForKenariBilling(
  modelId: string,
  billing?: KenariAccountBilling | null,
  plans?: KenariPlan[] | null
): boolean {
  // 1. Free models are always allowed
  if (isKenariFreeModel(modelId)) {
    return true;
  }

  // 2. No billing info / unauthenticated / no account
  if (!billing) {
    return false;
  }

  // 3. Prepaid balance bypass: accounts with IDR balance can access any model via PAYG
  if (billing.hasBalance) {
    return true;
  }

  // 4. Coupon scope allowance
  if (billing.couponScope && billing.couponScope.includes(modelId)) {
    return true;
  }

  // 5. Subscription plan scope
  const planIdentifier = billing.planName || billing.planId;
  if (planIdentifier) {
    const activePlans = plans && plans.length > 0 ? plans : loadCachedPlans();
    const matched = findMatchingKenariPlan(planIdentifier, activePlans);
    if (matched?.scope_models && matched.scope_models.includes(modelId)) {
      return true;
    }
  }

  // 6. No plan and no balance: not allowed
  return false;
}

/**
 * Filters a list of Kenari models based on the active billing status and plans.
 */
export function filterKenariModelsForBilling(
  models: readonly Model<"openai-completions">[],
  billing?: KenariAccountBilling | null,
  plans?: KenariPlan[] | null
): Model<"openai-completions">[] {
  const activePlans = plans && plans.length > 0 ? plans : loadCachedPlans();
  return models.filter((m) => isModelAllowedForKenariBilling(m.id, billing, activePlans));
}
