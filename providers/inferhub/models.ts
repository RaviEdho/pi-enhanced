import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { BASE_URL, MODELS_URL, PROVIDER_ID } from "./constants.js";
import { inferHubCredentialHash } from "./credentials.js";
import { fetchInferHubJson, record } from "./http.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
interface ModelMetadata {
  id: string;
  input_token_limit: number;
  max_output_tokens: number;
  modality: string;
  reasoning_levels: string[];
}
export interface InferHubCatalog {
  version: 1;
  credentialHash: string;
  fetchedAt: number;
  source: typeof MODELS_URL;
  entries: ModelMetadata[];
}
export interface InferHubModel extends Model<"openai-completions"> {
  inferHubReasoningLevels: string[];
  metadataSource: { url: string; verifiedAt: number };
}
const catalogs = new Map<string, InferHubCatalog>();
const root = () => join(homedir(), ".pi/agent/inferhub");
const pathFor = (key: string) => join(root(), `${inferHubCredentialHash(key)}.json`);

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** No guessed limits or alias capabilities; image/video/embedding outputs are out of scope. */
function metadata(value: unknown, key: string): ModelMetadata | undefined {
  const m = record(value);
  if (!m || typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(m.id)
    || m.id.includes(key) || !m.id.includes("/") || m.id.startsWith("combo/") || m.owned_by === "alias"
    || (m.output_modality !== undefined && m.output_modality !== "text")
    || !positive(m.input_token_limit) || !positive(m.max_output_tokens) || typeof m.modality !== "string") return undefined;
  const modalities = m.modality.split(",").map(v => v.trim());
  if (!modalities.includes("text")) return undefined;
  const efforts = Array.isArray(m.reasoning_levels)
    ? m.reasoning_levels.filter((v): v is string => typeof v === "string" && ["none", ...levels.slice(1)].includes(v)) : [];
  return { id: m.id, input_token_limit: m.input_token_limit, max_output_tokens: m.max_output_tokens,
    modality: modalities.includes("image") ? "text,image" : "text", reasoning_levels: [...new Set(efforts)] };
}

export function buildInferHubModels(catalog: InferHubCatalog): InferHubModel[] {
  return catalog.entries.map(entry => {
    const thinkingLevelMap = Object.fromEntries(levels.map(level => [level,
      level === "off" ? entry.reasoning_levels.includes("none") ? "none" : null
        : entry.reasoning_levels.includes(level) ? level : null,
    ])) as ThinkingLevelMap;
    return {
      id: entry.id, name: entry.id, provider: PROVIDER_ID, api: "openai-completions", baseUrl: BASE_URL,
      input: entry.modality.includes("image") ? ["text", "image"] : ["text"],
      reasoning: entry.reasoning_levels.length > 0, thinkingLevelMap,
      // Stay on the documented minimal Chat Completions request surface.
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsLongCacheRetention: false },
      contextWindow: entry.input_token_limit, maxTokens: entry.max_output_tokens,
      // Required numeric placeholders, NOT free inference or estimated marketplace rates.
      // stream.ts replaces the total with the server's settled usage.cost when supplied.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      inferHubReasoningLevels: entry.reasoning_levels,
      metadataSource: { url: catalog.source, verifiedAt: catalog.fetchedAt },
    };
  });
}

export function loadInferHubCatalog(key: string): InferHubCatalog | undefined {
  const hash = inferHubCredentialHash(key);
  const cached = catalogs.get(hash);
  if (cached) return cached;
  try {
    const value = record(JSON.parse(readFileSync(pathFor(key), "utf8")));
    if (value?.version !== 1 || value.credentialHash !== hash || value.source !== MODELS_URL
      || !positive(value.fetchedAt) || !Array.isArray(value.entries)) return undefined;
    // Ignore removed discovery records while retaining cached explicit routes.
    const explicit = value.entries.filter(entry => {
      const m = record(entry);
      return m?.members === undefined && typeof m?.id === "string" && m.id.includes("/") && !m.id.startsWith("combo/");
    });
    const entries = explicit.map(entry => metadata(entry, key));
    if (entries.some(entry => !entry)) return undefined;
    const catalog: InferHubCatalog = { version: 1, credentialHash: hash, source: MODELS_URL,
      fetchedAt: value.fetchedAt, entries: entries as ModelMetadata[] };
    catalogs.set(hash, catalog);
    return catalog;
  } catch { return undefined; }
}

/** Publish only after Pi accepts this refresh generation; no secrets or request content. */
export function saveInferHubCatalog(catalog: InferHubCatalog): void {
  catalogs.set(catalog.credentialHash, catalog);
  const path = join(root(), `${catalog.credentialHash}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { try { unlinkSync(temporary); } catch { /* Cache is best-effort. */ } }
}

export function removeInferHubCatalog(key: string): void {
  catalogs.delete(inferHubCredentialHash(key));
  try { unlinkSync(pathFor(key)); } catch { /* No snapshot. */ }
}

export async function discoverInferHubModels(key: string, signal?: AbortSignal): Promise<InferHubCatalog> {
  const value = record(await fetchInferHubJson(MODELS_URL, key, signal));
  if (!Array.isArray(value?.data) || value.data.some(entry => typeof record(entry)?.id !== "string")) {
    throw new Error("InferHub returned an invalid model catalog.");
  }
  const entries = value.data.map(entry => metadata(entry, key)).filter((entry): entry is ModelMetadata => !!entry);
  signal?.throwIfAborted();
  return { version: 1, credentialHash: inferHubCredentialHash(key), source: MODELS_URL,
    fetchedAt: Date.now(), entries: [...new Map(entries.map(entry => [entry.id, entry])).values()] };
}
