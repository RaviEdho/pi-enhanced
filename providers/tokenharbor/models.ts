import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { withTokenHarborReasoning, type TokenHarborReasoning } from "./reasoning.js";
import { tokenHarborCredentialHash } from "./credentials.js";
import {
  CATALOG_TTL_MS, METADATA_TTL_MS, MODELS_URL, PROVIDER_ID,
  REQUEST_TIMEOUT_MS, TOKENHARBOR_BASE_URL, TOKENHARBOR_ORIGIN,
} from "./constants.js";

type RecordValue = Record<string, unknown>;
type Cost = Model<"openai-completions">["cost"];
export interface TokenHarborModel extends Model<"openai-completions"> {
  metadataSource: { url: string; verifiedAt: number };
  tokenHarborReasoning?: TokenHarborReasoning;
  /** Pi's numeric maxTokens uses 0 for unknown; the OpenAI adapter then omits the default cap. */
  tokenHarborMaxOutputTokensUnknown?: boolean;
  /** Pi's numeric cost uses 0 when this base cache-read price is unknown, not verified free. */
  tokenHarborCacheReadPriceUnknown?: boolean;
  /** Pi's numeric cost uses 0 when this base cache-write price is unknown, not verified free. */
  tokenHarborCacheWritePriceUnknown?: boolean;
}
export interface PageMetadata {
  id: string;
  type?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  cost: Partial<Cost>;
  url: string;
  verifiedAt: number;
}
export interface TokenHarborCatalog {
  version: 1;
  credentialHash: string;
  fetchedAt: number;
  visibleIds: string[];
  models: TokenHarborModel[];
  skipped: { id: string; reason: string }[];
}
interface PageEntry { checkedAt: number; metadata?: PageMetadata }
const catalogs = new Map<string, TokenHarborCatalog | undefined>();
let pages: Record<string, PageEntry> | undefined;
const costFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const priceFields = ["input_usd_per_1m", "output_usd_per_1m", "cache_read_usd_per_1m", "cache_write_usd_per_1m"] as const;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function price(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value);
}
function cacheRoot(): string { return join(homedir(), ".pi/agent/tokenharbor"); }
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function saveJson(path: string, value: unknown): void {
  // Only sanitized catalog metadata is persisted, never keys or request payloads.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* Nothing was written. */ }
  }
}
function completeCost(values: readonly (number | undefined)[]): Cost | undefined {
  const [input, output, cacheRead, cacheWrite] = values;
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined : { input, output, cacheRead, cacheWrite };
}
function validModel(value: unknown): value is TokenHarborModel {
  const m = record(value), cost = record(m?.cost), source = record(m?.metadataSource);
  return !!m && validId(m.id) && m.provider === PROVIDER_ID && m.api === "openai-completions" &&
    m.baseUrl === TOKENHARBOR_BASE_URL && typeof m.name === "string" && typeof m.reasoning === "boolean" &&
    !!positive(m.contextWindow) &&
    (m.tokenHarborMaxOutputTokensUnknown === true ? m.maxTokens === 0
      : (m.tokenHarborMaxOutputTokensUnknown === undefined || m.tokenHarborMaxOutputTokensUnknown === false) && !!positive(m.maxTokens)) &&
    Array.isArray(m.input) && m.input.includes("text") &&
    m.input.every(v => v === "text" || v === "image") && !!cost && costFields.every(k => typeof cost[k] === "number" && price(cost[k]) !== undefined) &&
    (m.tokenHarborCacheReadPriceUnknown === undefined || typeof m.tokenHarborCacheReadPriceUnknown === "boolean") &&
    (m.tokenHarborCacheReadPriceUnknown !== true || cost.cacheRead === 0) &&
    (m.tokenHarborCacheWritePriceUnknown === undefined || typeof m.tokenHarborCacheWritePriceUnknown === "boolean") &&
    (m.tokenHarborCacheWritePriceUnknown !== true || cost.cacheWrite === 0) &&
    (cost.tiers === undefined || (Array.isArray(cost.tiers) && cost.tiers.every(value => {
      const tier = record(value);
      return tier && positive(tier.inputTokensAbove) && costFields.every(k => typeof tier[k] === "number" && price(tier[k]) !== undefined);
    }))) &&
    source?.url === `${TOKENHARBOR_ORIGIN}/models/${encodeURIComponent(m.id)}` && !!positive(source.verifiedAt);
}

export function loadTokenHarborCatalog(key: string): TokenHarborCatalog | undefined {
  const hash = tokenHarborCredentialHash(key);
  if (catalogs.has(hash)) return catalogs.get(hash);
  const value = record(readJson(join(cacheRoot(), `${hash}.json`)));
  const cached = value?.version === 1 && value.credentialHash === hash && !!positive(value.fetchedAt) &&
    Array.isArray(value.visibleIds) && value.visibleIds.every(validId) &&
    Array.isArray(value.models) && value.models.every(validModel) && Array.isArray(value.skipped)
    ? value as unknown as TokenHarborCatalog : undefined;
  // Old snapshots have no verified reasoning contract; never trust legacy maps.
  const normalized = cached ? { ...cached, models: cached.models.map(model => withTokenHarborReasoning(model, model.tokenHarborReasoning)) } : undefined;
  catalogs.set(hash, normalized);
  return normalized;
}

/** Call only from an accepted refresh publication. */
export function saveTokenHarborCatalog(catalog: TokenHarborCatalog): void {
  catalogs.set(catalog.credentialHash, catalog);
  saveJson(join(cacheRoot(), `${catalog.credentialHash}.json`), catalog);
}

/** The server's key-visible catalog is not a subscription entitlement guarantee. */
export function isTokenHarborModelVisible(key: string, id: string): boolean {
  const catalog = loadTokenHarborCatalog(key);
  return !catalog || Date.now() - catalog.fetchedAt >= CATALOG_TTL_MS || catalog.visibleIds.includes(id);
}

function decodeHtml(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Parse named specification rows, not recommendations, marketing estimates, or executable page scripts. */
export function parseTokenHarborModelPage(html: string, id: string, verifiedAt = Date.now()): PageMetadata | undefined {
  const pageId = html.match(/aria-label="Copy model id ([^"]+)"/i)?.[1];
  if (!pageId || decodeHtml(pageId) !== id) return undefined;
  // React may stream individual specification values into an inert placeholder.
  let resolved = html;
  for (const match of html.matchAll(/<div\b[^>]*\bhidden\b[^>]*\bid="S:([\w-]+)"[^>]*>([\s\S]*?)<\/div>/g)) {
    resolved = resolved.replace(`<template id="P:${match[1]}"></template>`, match[2]);
  }
  const start = resolved.indexOf('aria-label="Copy model id ');
  const end = resolved.indexOf("<aside", start);
  const specifications = resolved.slice(start, end < 0 ? undefined : end);
  const fields = new Map<string, string>();
  for (const match of specifications.matchAll(/<span\b[^>]*>([^<]{1,80})<\/span>\s*<span\b[^>]*>([^<]*)<\/span>/g)) {
    const label = decodeHtml(match[1]).trim();
    if (!fields.has(label)) fields.set(label, decodeHtml(match[2]).trim());
  }
  const tokens = (label: string) => {
    const value = fields.get(label)?.match(/^([\d,]+)(?:\s+tokens)?$/)?.[1];
    return value ? positive(Number(value.replaceAll(",", ""))) : undefined;
  };
  const pagePrice = (label: string) => {
    const value = fields.get(label)?.match(/^\$([\d,.]+)\s*\/\s*1M\s+tokens$/)?.[1];
    return value ? price(value.replaceAll(",", "")) : undefined;
  };
  const modalities = fields.get("Modalities")?.toLowerCase().split(/[,\s]+/);
  const input: ("text" | "image")[] | undefined = modalities?.includes("text")
    ? ["text", ...(modalities.some(m => m === "image" || m === "vision") ? ["image" as const] : [])] : undefined;
  return {
    id, type: fields.get("Type"), contextWindow: tokens("Context window"), maxTokens: tokens("Maximum output tokens"), input,
    cost: { input: pagePrice("Input"), output: pagePrice("Output"), cacheRead: pagePrice("Cache hit"), cacheWrite: pagePrice("Cache write") },
    url: `${TOKENHARBOR_ORIGIN}/models/${encodeURIComponent(id)}`, verifiedAt,
  };
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Token Harbor returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("Token Harbor discovery response exceeded 2 MiB");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchTokenHarborCatalog(key: string, signal?: AbortSignal): Promise<RecordValue[]> {
  const response = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    // Do not include upstream error bodies: they can reflect credentials.
    const status = response.status;
    await response.body?.cancel();
    throw new Error(status === 401 ? "Token Harbor API key rejected (HTTP 401); run /login tokenharbor."
      : status === 403 ? "Token Harbor refused discovery (HTTP 403). Check email verification, network/region access, and key restrictions."
      : `Token Harbor model discovery failed (HTTP ${status}).`);
  }
  let data: RecordValue | undefined;
  try { data = record(JSON.parse(await responseText(response))); }
  catch { signal?.throwIfAborted(); throw new Error("Token Harbor returned an invalid model catalog"); }
  if (!Array.isArray(data?.data) || !data.data.every(v => record(v) && validId(record(v)?.id))) {
    throw new Error("Token Harbor returned an invalid model catalog");
  }
  return data.data as RecordValue[];
}

async function pageMetadata(id: string, signal?: AbortSignal, force = false): Promise<PageMetadata | undefined> {
  if (!pages) pages = record(readJson(join(cacheRoot(), "public-metadata.json"))) as Record<string, PageEntry> | undefined ?? {};
  const entry = pages[id];
  const metadata = record(entry?.metadata);
  const validEntry = metadata?.id === id && metadata.url === `${TOKENHARBOR_ORIGIN}/models/${encodeURIComponent(id)}` &&
    positive(metadata.verifiedAt) && record(metadata.cost) &&
    (metadata.contextWindow === undefined || positive(metadata.contextWindow)) &&
    (metadata.maxTokens === undefined || positive(metadata.maxTokens)) &&
    (metadata.input === undefined || (Array.isArray(metadata.input) && metadata.input.every(v => v === "text" || v === "image")));
  const previous = validEntry ? entry.metadata : undefined;
  const ttl = previous ? METADATA_TTL_MS : 5 * 60_000;
  if (!force && entry && Date.now() - entry.checkedAt < ttl && (previous || !entry.metadata)) return previous;
  try {
    const response = await fetch(`${TOKENHARBOR_ORIGIN}/models/${encodeURIComponent(id)}`, {
      // Never forward a credential to the public metadata page.
      headers: { Accept: "text/html" }, redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new Error("Token Harbor metadata temporarily unavailable");
    }
    const metadata = response.ok ? parseTokenHarborModelPage(await responseText(response), id) : undefined;
    if (!response.ok) await response.body?.cancel();
    signal?.throwIfAborted();
    pages[id] = { checkedAt: Date.now(), metadata };
    return metadata;
  } catch {
    signal?.throwIfAborted();
    // A stale verified page may keep an already discovered model usable after a temporary outage.
    return previous;
  }
}

export function buildTokenHarborModel(raw: RecordValue, page?: PageMetadata): TokenHarborModel | undefined {
  if (!validId(raw.id) || page?.id !== raw.id || page.type !== "chat") return undefined;
  if (raw.tool_call !== true) return undefined;
  const contextWindow = positive(raw.context_length) ?? positive(page.contextWindow);
  const maxTokens = positive(raw.max_output_tokens) ?? positive(raw.max_completion_tokens) ?? positive(page.maxTokens);
  const input = page.input;
  if (!contextWindow || !input?.includes("text")) return undefined;
  const pricing = record(raw.pricing);
  const [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] = costFields.map((field, i) =>
    price(pricing?.[priceFields[i]]) ?? price(page.cost[field]));
  // Pi requires numeric rates, so retain unknown cache prices separately from verified zeroes.
  const cost = completeCost([inputPrice, outputPrice, cacheReadPrice ?? 0, cacheWritePrice ?? 0]);
  if (!cost) return undefined;
  // Only the documented reasoning contract is capability evidence.
  const model: TokenHarborModel = {
    id: raw.id, name: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : raw.id,
    provider: PROVIDER_ID, api: "openai-completions", baseUrl: TOKENHARBOR_BASE_URL,
    reasoning: false,
    input, contextWindow, maxTokens: maxTokens ?? 0, cost, metadataSource: { url: page.url, verifiedAt: page.verifiedAt },
    tokenHarborMaxOutputTokensUnknown: maxTokens === undefined,
    tokenHarborCacheReadPriceUnknown: cacheReadPrice === undefined,
    tokenHarborCacheWritePriceUnknown: cacheWritePrice === undefined,
    // The audit verified both developer-role messages and max_completion_tokens on this gateway.
    compat: { supportsReasoningEffort: false },
  };
  const long = record(pricing?.long_context);
  const threshold = positive(long?.over_prompt_tokens);
  const longCost = completeCost(priceFields.map(field => price(long?.[field])));
  if (threshold && longCost) model.cost.tiers = [{ inputTokensAbove: threshold, ...longCost }];
  return withTokenHarborReasoning(model, raw.reasoning);
}

export async function discoverTokenHarborModels(key: string, signal?: AbortSignal, force = false, listing?: RecordValue[]): Promise<TokenHarborCatalog> {
  signal?.throwIfAborted();
  const cached = loadTokenHarborCatalog(key);
  // A fresh listing must rebuild all models, including previously skipped and newly added IDs.
  // The catalog TTL only applies when no fresh listing was supplied; public pages keep their own TTL.
  if (listing === undefined && !force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
  const raw = listing ?? await fetchTokenHarborCatalog(key, signal);
  const models: TokenHarborModel[] = [];
  const skipped: TokenHarborCatalog["skipped"] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, raw.length) }, async () => {
    while (cursor < raw.length) {
      signal?.throwIfAborted();
      const item = raw[cursor++];
      const id = item.id as string;
      // A public page cannot override the listing's required tool support.
      const model = item.tool_call === true ? buildTokenHarborModel(item, await pageMetadata(id, signal, force)) : undefined;
      if (model) models.push(model);
      else skipped.push({ id, reason: "Missing verified chat/tool metadata, context window, modalities, or input/output prices" });
    }
  }));
  signal?.throwIfAborted();
  const index = new Map(raw.map((m, i) => [m.id, i]));
  models.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  // Public metadata may be shared; credential-specific catalogs are published separately.
  if (pages) saveJson(join(cacheRoot(), "public-metadata.json"), Object.fromEntries(Object.entries(pages).slice(-512)));
  return { version: 1, credentialHash: tokenHarborCredentialHash(key), fetchedAt: Date.now(), visibleIds: raw.map(m => m.id as string), models, skipped };
}
