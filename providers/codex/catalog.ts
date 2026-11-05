import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CodexCatalogCache,
  CodexModelSummary,
  RawCodexCatalogResponse,
} from "./types.js";

const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_FALLBACK_FREE_MODELS = [
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-reserve",
];

const DISK_CHECK_INTERVAL_MS = 250;
let memoryCache: CodexCatalogCache | null = null;
let memoryCachePath: string | undefined;
let diskCheck: { checkedAt: number; signature: string | null | undefined } | undefined;

function getCacheFilePath(): string {
  return join(homedir(), ".pi/agent/codex-catalog-cache.json");
}

/**
 * Loads the cached Codex catalog from memory or disk.
 * Eligibility checks require a fresh catalog by default. Startup can opt into
 * the last snapshot to keep discovered models selectable while refreshing.
 */
export function loadCachedCatalog(options: { allowStale?: boolean } = {}): CodexModelSummary[] | null {
  const cachePath = getCacheFilePath();
  if (memoryCachePath !== cachePath) {
    memoryCachePath = cachePath;
    memoryCache = null;
    diskCheck = undefined;
  }
  const usable = () => memoryCache && (options.allowStale || Date.now() - memoryCache.updatedAt < CACHE_TTL_MS)
    ? memoryCache.models : null;
  const current = usable();
  if (current) return current;

  // Expired, missing and corrupt snapshots are negative-cache hits too. Poll
  // metadata, not JSON, so one footer redraw cannot parse the file per account.
  const now = performance.now();
  if (diskCheck && now - diskCheck.checkedAt < DISK_CHECK_INTERVAL_MS) return usable();
  let signature: string | null = null;
  try {
    const stat = statSync(cachePath);
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    // Missing/unreadable metadata is retried after the polling interval.
  }
  const previous = diskCheck;
  diskCheck = { checkedAt: now, signature };
  if (signature === null || previous?.signature === signature) return usable();

  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf-8");
  } catch {
    // Retry transient read errors even if the next metadata fingerprint matches.
    diskCheck.signature = undefined;
    return usable();
  }
  try {
    const parsed = JSON.parse(raw) as CodexCatalogCache;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.models) &&
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)) {
      memoryCache = parsed;
    }
  } catch {
    // Retain the last successful snapshot; do not repeatedly parse corrupt JSON.
  }
  return usable();
}

/**
 * Persists the discovered catalog to disk and memory.
 */
export function saveCachedCatalog(models: CodexModelSummary[]): void {
  memoryCachePath = getCacheFilePath();
  diskCheck = undefined;
  memoryCache = {
    updatedAt: Date.now(),
    models,
  };

  try {
    const cachePath = getCacheFilePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(memoryCache, null, 2), "utf-8");
  } catch {
    // Non-fatal if disk write fails
  }
}

/**
 * Fetches the live model catalog from OpenAI's Codex endpoint. The caller saves
 * it only after Pi accepts the refresh publication (which may be superseded).
 */
export async function fetchLiveCodexCatalog(
  accessToken: string,
  accountId: string,
  signal?: AbortSignal
): Promise<CodexModelSummary[]> {
  const res = await fetch(CODEX_MODELS_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      accept: "application/json",
      originator: "pi",
      "User-Agent": "pi",
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Codex models: HTTP ${res.status}`);
  }

  const data = (await res.json()) as RawCodexCatalogResponse;
  if (!data?.models || !Array.isArray(data.models)) {
    return [];
  }

  const summaries: CodexModelSummary[] = data.models
    .filter((m) => m && typeof m.slug === "string")
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name || m.slug,
      availableInPlans: Array.isArray(m.available_in_plans) ? m.available_in_plans : [],
      contextWindow: m.context_window,
      maxOutputTokens: m.max_output_tokens,
      inputModalities: Array.isArray(m.input_modalities) ? m.input_modalities : undefined,
      reasoningLevels: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
            .filter((level) => level && typeof level.effort === "string")
            .map((level) => level.effort)
        : undefined,
      supportedInApi: m.supported_in_api,
      visibility: m.visibility,
    }));

  signal?.throwIfAborted();
  return summaries;
}
