import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shared observations from an explicitly authorized probe of a Free account with
 * zero purchased balance. Only explicit model entitlement denials are restricted;
 * inconclusive responses must be recorded as unknown. No credentials belong here. */
export interface OllamaFreeAccessSnapshot {
  version: 1;
  checkedAt: number;
  models: Record<string, "accessible" | "restricted" | "unknown">;
}
export const OLLAMA_FREE_ACCESS_PATH = join(homedir(), ".pi", "agent", "cache", "ollama-cloud-free-access.json");

export function loadOllamaFreeAccessSnapshot(): OllamaFreeAccessSnapshot | null {
  const read = (path: string | URL): OllamaFreeAccessSnapshot | null => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const data = value as OllamaFreeAccessSnapshot;
      if (data.version !== 1 || !Number.isFinite(data.checkedAt) || data.checkedAt > Date.now() || !data.models || typeof data.models !== "object" || Array.isArray(data.models)) return null;
      if (!Object.values(data.models).every((s) => s === "accessible" || s === "restricted" || s === "unknown")) return null;
      return data;
    } catch { return null; }
  };
  const bundled = read(new URL("./free-access-snapshot.json", import.meta.url));
  const local = read(OLLAMA_FREE_ACCESS_PATH);
  return local && (!bundled || local.checkedAt > bundled.checkedAt) ? local : bundled;
}

/** Store a complete shared observation snapshot; callers perform any probes themselves. */
export function saveOllamaFreeAccessSnapshot(snapshot: OllamaFreeAccessSnapshot): void {
  mkdirSync(dirname(OLLAMA_FREE_ACCESS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(OLLAMA_FREE_ACCESS_PATH, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(OLLAMA_FREE_ACCESS_PATH, 0o600);
}

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
