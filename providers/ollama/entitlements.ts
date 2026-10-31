/** Models explicitly denied to a Free account with zero purchased balance.
 * Unknown models remain visible; this list does not describe paid entitlements. */
export const OLLAMA_FREE_RESTRICTED_MODELS: ReadonlySet<string> = new Set([
  "kimi-k2.6", "deepseek-v4.1-flash", "kimi-k2.7-code", "minimax-m3.1-flash",
  "kimi-k3", "deepseek-v4-pro:0813", "deepseek-v4.1-flash:1017", "mistral-large-4",
  "muse-spark-open", "minimax-m3", "glm-5.3-flash", "mistral-large-3:675b",
  "glm-5.2", "glm-5.3", "minimax-m2.7", "mimo-v2.6-flash", "mimo-v2.6-pro",
]);

export interface OllamaEntitlement { plan: string | null; purchasedBalance: number | null }

/** Both endpoints must independently succeed; unrecognized data remains unknown. */
export async function fetchOllamaEntitlement(key: string, signal?: AbortSignal): Promise<OllamaEntitlement> {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const request = async (path: string, method: string): Promise<any> => {
    try {
      const response = await fetch(`https://ollama.com/api/${path}`, { method, headers, signal: combined, redirect: "error" });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const [me, balance] = await Promise.all([request("me", "POST"), request("balance", "GET")]);
  const rawPlan = me?.Plan ?? me?.plan;
  const plan = typeof rawPlan === "string" && rawPlan.trim() ? rawPlan.trim().toLowerCase() : null;
  const amount = balance?.purchased?.balance_usd;
  return { plan, purchasedBalance: typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : null };
}
