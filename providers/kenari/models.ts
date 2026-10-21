import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
  DEFAULT_USD_IDR_RATE,
  KENARI_API_BASE_URL,
  KENARI_USER_AGENT,
  MODEL_FETCH_TIMEOUT_MS,
  MODELS_URL,
  PRICING_URL,
  PROVIDER_ID,
} from "./constants.js";
import type {
  KenariModelsResponse,
  KenariPublicPricingResponse,
  KenariRawModel,
} from "./types.js";

export const DEFAULT_KENARI_MODELS: Model<"openai-completions">[] = [
  {
    id: "step-3-7-flash:free",
    name: "Step 3.7 Flash (Free)",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "agnes-2-5-flash:free",
    name: "Agnes 2.5 Flash (Free)",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 512000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: false,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "deepseek-v4-1-flash:free",
    name: "DeepSeek V4.1 Flash (Free)",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 12.0, output: 57.14, cacheRead: 1.2, cacheWrite: 14.86 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 0.1143, output: 0.5714, cacheRead: 0.0114, cacheWrite: 0.1429 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 1.5, output: 6.0, cacheRead: 0.375, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.25, output: 1.0, cacheRead: 0.0625, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "deepseek-v4-1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "gemini-2-5-flash",
    name: "Gemini 2.5 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "kenari-free",
    name: "Kenari Free Route (Auto-fallback)",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: false,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
];

function getCachePath(): string {
  return join(homedir(), ".pi/agent/kenari-models.json");
}

export function loadCachedModels(): Model<"openai-completions">[] | null {
  try {
    const file = getCachePath();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCachedModels(models: Model<"openai-completions">[]): void {
  try {
    const file = getCachePath();
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(file, JSON.stringify(models, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Ignore cache write error
  }
}

/**
 * Builds ThinkingLevelMap based on model's supported reasoning options.
 */
function buildThinkingLevelMap(options?: string[]): ThinkingLevelMap | undefined {
  if (!options || options.length === 0) return undefined;

  const has = (lvl: string) => options.includes(lvl);

  return {
    off: has("none") ? "none" : null,
    minimal: has("minimal") ? "minimal" : has("low") ? "low" : null,
    low: has("low") ? "low" : null,
    medium: has("medium") ? "medium" : has("low") ? "low" : has("high") ? "high" : null,
    high: has("high") ? "high" : null,
    xhigh: has("xhigh") ? "xhigh" : has("high") ? "high" : null,
    max: has("max") ? "max" : has("xhigh") ? "xhigh" : has("high") ? "high" : null,
  };
}

/**
 * Converts micro-IDR per 1M tokens to USD per 1M tokens.
 */
function microIdrToUsd(microIdr: number | null | undefined, usdIdrRate: number): number {
  if (!microIdr || typeof microIdr !== "number" || microIdr <= 0) return 0;
  // microIdr / 1_000_000 = IDR per 1M tokens
  // IDR per 1M / usdIdrRate = USD per 1M tokens
  const idrPer1m = microIdr / 1_000_000;
  return Number((idrPer1m / usdIdrRate).toFixed(6));
}

/**
 * Transforms a raw Kenari model item into Pi Model<"openai-completions">.
 */
export function transformKenariModel(
  raw: KenariRawModel,
  usdIdrRate: number
): Model<"openai-completions"> | null {
  if (!raw.id) return null;

  const input: ("text" | "image")[] = ["text"];
  if (raw.modalities?.input?.includes("image")) {
    input.push("image");
  }

  const reasoningOptions = raw.reasoning_options || raw.supported_reasoning_levels;
  const reasoning = Boolean(raw.reasoning || (reasoningOptions && reasoningOptions.length > 0));
  const thinkingLevelMap = reasoning ? buildThinkingLevelMap(reasoningOptions) : undefined;

  const isFree = Boolean(raw.pricing?.free || raw.id.endsWith(":free"));

  const cost = isFree
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    : {
        input: microIdrToUsd(raw.pricing?.input, usdIdrRate),
        output: microIdrToUsd(raw.pricing?.output, usdIdrRate),
        cacheRead: microIdrToUsd(raw.pricing?.cache_read, usdIdrRate),
        cacheWrite: microIdrToUsd(raw.pricing?.cache_write, usdIdrRate),
      };

  return {
    id: raw.id,
    name: raw.name || raw.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: KENARI_API_BASE_URL,
    headers: { "User-Agent": KENARI_USER_AGENT },
    reasoning,
    thinkingLevelMap,
    input,
    cost,
    contextWindow: raw.context_length || 128000,
    maxTokens: raw.max_output_tokens || 8192,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  };
}

/**
 * Fetches dynamic models catalog and active exchange rate from Kenari.
 */
export async function fetchKenariModels(
  apiKey?: string,
  signal?: AbortSignal
): Promise<Model<"openai-completions">[] | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers: Record<string, string> = {
      "User-Agent": KENARI_USER_AGENT,
      Accept: "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const [modelsRes, pricingRes] = await Promise.all([
      fetch(MODELS_URL, { headers, signal: combinedSignal }),
      fetch(PRICING_URL, { headers: { "User-Agent": KENARI_USER_AGENT }, signal: combinedSignal }).catch(() => null),
    ]);

    if (!modelsRes.ok) {
      return null;
    }

    let usdIdrRate = DEFAULT_USD_IDR_RATE;
    if (pricingRes && pricingRes.ok) {
      try {
        const pricingData = (await pricingRes.json()) as KenariPublicPricingResponse;
        if (pricingData.usd_idr_rate && pricingData.usd_idr_rate > 0) {
          usdIdrRate = pricingData.usd_idr_rate;
        }
      } catch {
        // Fall back to DEFAULT_USD_IDR_RATE
      }
    }

    const data = (await modelsRes.json()) as KenariModelsResponse;
    if (!data.data || !Array.isArray(data.data)) {
      return null;
    }

    const models: Model<"openai-completions">[] = [];
    for (const raw of data.data) {
      // Only include chat models (or models serving chat endpoints)
      if (raw.endpoints && !raw.endpoints.includes("chat")) {
        continue;
      }
      const model = transformKenariModel(raw, usdIdrRate);
      if (model) {
        models.push(model);
      }
    }

    if (models.length > 0) {
      // Also ensure the kenari-free fallback route is included if not present
      if (!models.some((m) => m.id === "kenari-free")) {
        const freeRoute = DEFAULT_KENARI_MODELS.find((m) => m.id === "kenari-free");
        if (freeRoute) models.push(freeRoute);
      }
      saveCachedModels(models);
      return models;
    }

    return null;
  } catch {
    return null;
  }
}
