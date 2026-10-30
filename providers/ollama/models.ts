import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fetchOllamaPricing, findOllamaModelPricing, type OllamaPricingMap } from "./pricing.js";

export const OLLAMA_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_BASE_URL = "https://ollama.com/v1";
const API_URL = "https://ollama.com/api";
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache");
const CACHE_PATH = join(CACHE_DIR, "ollama-cloud-models.json");
const CACHE_TTL = 60 * 60 * 1000;

function validCatalogModels(models: unknown): models is Model<"openai-completions">[] {
  return Array.isArray(models) && models.length > 0 && models.every((m) =>
    m && m.provider === OLLAMA_PROVIDER_ID && m.api === "openai-completions" && m.baseUrl === OLLAMA_BASE_URL &&
    typeof m.id === "string" && !!m.id.trim() && typeof m.name === "string" &&
    Array.isArray(m.input) && m.input.length > 0 && m.input.every((v: unknown) => v === "text" || v === "image") &&
    typeof m.reasoning === "boolean" && Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 &&
    Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0 && m.cost &&
    [m.cost.input, m.cost.output, m.cost.cacheRead, m.cost.cacheWrite].every((v) => Number.isFinite(v) && v >= 0));
}

/** Prefer the user's public catalog; the bundled seed is always stale and never written to the cache. */
export function loadOllamaCatalog(): { models: Model<"openai-completions">[]; fresh: boolean } | null {
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (validCatalogModels(data.models) && Number.isFinite(data.checkedAt) && data.checkedAt <= Date.now()) {
      return { models: data.models.map((model: Model<"openai-completions">) => ({ ...model, name: model.id })), fresh: Date.now() - data.checkedAt < CACHE_TTL };
    }
  } catch { /* Missing or corrupt user cache: try the bundled snapshot. */ }
  try {
    const data = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
    if (validCatalogModels(data.models)) return { models: data.models.map((model: Model<"openai-completions">) => ({ ...model, name: model.id })), fresh: false };
  } catch { /* No usable offline snapshot. */ }
  return null;
}

export function saveOllamaCatalog(models: Model<"openai-completions">[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, JSON.stringify({ checkedAt: Date.now(), models }), { mode: 0o600 });
  } catch { /* Discovery still works without a persistent cache. */ }
}

interface CatalogItem { name?: unknown; model?: unknown; capabilities?: unknown }
interface ModelDetails { capabilities?: unknown; model_info?: unknown }

function capabilities(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** Pi requires numeric prices and limits even when Ollama does not publish them.
 * Zero prices are placeholders, not a claim that inference is free. Unknown limits
 * use conservative operational defaults; they are not provider-verified limits. */
export function transformOllamaModel(item: CatalogItem, details?: ModelDetails, prices?: OllamaPricingMap | null): Model<"openai-completions"> | null {
  const id = typeof item.model === "string" ? item.model : item.name;
  if (typeof id !== "string" || !id.trim()) return null;
  const caps = capabilities(details?.capabilities) ?? capabilities(item.capabilities);
  // A coding agent needs both completion and tool calling; unknown capabilities
  // are not evidence that a model supports either operation.
  if (!caps?.includes("completion") || !caps.includes("tools")) return null;
  const info = details?.model_info;
  const entries = info && typeof info === "object" && !Array.isArray(info) ? Object.entries(info) : [];
  const architecture = entries.find(([key]) => key === "general.architecture")?.[1];
  const preferred = typeof architecture === "string" ? `${architecture}.context_length` : undefined;
  const context = entries.find(([key]) => key === preferred)?.[1] ??
    entries.find(([key]) => key.endsWith(".context_length"))?.[1];
  const knownContext = typeof context === "number" && Number.isSafeInteger(context) && context > 0;
  const contextWindow = knownContext ? context : 32768;
  const pricing = prices ? findOllamaModelPricing(prices, id) : null;
  const rates = pricing?.regular;
  // Missing rates use zero placeholders; known rates are estimates, not billed totals.
  return {
    id, name: id, provider: OLLAMA_PROVIDER_ID, api: "openai-completions", baseUrl: OLLAMA_BASE_URL,
    input: caps?.includes("vision") ? ["text", "image"] : ["text"],
    reasoning: caps?.includes("thinking") ?? false,
    cost: { input: rates?.input ?? 0, output: rates?.output ?? 0, cacheRead: rates?.cacheRead ?? 0, cacheWrite: 0 },
    contextWindow, maxTokens: Math.min(contextWindow, 8192),
    // Ollama's native think options are not OpenAI reasoning_effort levels.
    compat: { supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
  };
}

/** A failed refresh returns null so a previously published catalog is retained. */
export async function fetchOllamaModels(key?: string, signal?: AbortSignal): Promise<Model<"openai-completions">[] | null> {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetch(`${API_URL}/tags`, { headers, signal: combined, redirect: "error" });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) return null;
    const items = (data as { models: unknown[] }).models.filter((v): v is CatalogItem => !!v && typeof v === "object" && !Array.isArray(v));
    const output: (Model<"openai-completions"> | null)[] = new Array(items.length).fill(null);
    const pricingPromise = fetchOllamaPricing(combined);
    const detailsByIndex: (ModelDetails | undefined)[] = new Array(items.length);
    let detailsFailed = false;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        const id = typeof item.model === "string" ? item.model : item.name;
        if (typeof id !== "string" || !id.trim()) continue;
        let details: ModelDetails | undefined;
        try {
          const res = await fetch(`${API_URL}/show`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: id }), signal: combined, redirect: "error" });
          if (res.ok) {
            const body: unknown = await res.json();
            if (body && typeof body === "object" && !Array.isArray(body)) details = body as ModelDetails;
          }
        } catch { /* Preserve the previous catalog on a transient failure. */ }
        if (!details) detailsFailed = true;
        detailsByIndex[index] = details;
      }
    }));
    const prices = await pricingPromise;
    if (combined.aborted || detailsFailed) return null;
    for (let i = 0; i < items.length; i++) output[i] = transformOllamaModel(items[i], detailsByIndex[i], prices);
    const seen = new Set<string>();
    const models = output.filter((m): m is Model<"openai-completions"> => {
      if (!m || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return models.length ? models : null;
  } catch { return null; }
}
