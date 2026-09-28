/**
 * Unified credential resolver for web search providers.
 *
 * Checks:
 * 1. Process environment variables (e.g. BRAVE_API_KEY, TAVILY_API_KEY)
 * 2. Pi stored credentials in ~/.pi/agent/auth.json (from /login)
 * 3. Multi-account credentials in ~/.pi/agent/accounts.json
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../accounts/store.js";
import type { SearchProviderId } from "./types.js";

const AUTH_FILE_PATH = join(homedir(), ".pi/agent/auth.json");

let cachedMtime = 0;
let cachedAuthData: Record<string, any> = {};

function readPiAuthJson(): Record<string, any> {
  try {
    if (!existsSync(AUTH_FILE_PATH)) return {};
    const mtime = statSync(AUTH_FILE_PATH).mtimeMs;
    if (mtime === cachedMtime) {
      return cachedAuthData;
    }
    const raw = readFileSync(AUTH_FILE_PATH, "utf8");
    cachedAuthData = JSON.parse(raw);
    cachedMtime = mtime;
    return cachedAuthData;
  } catch {
    return {};
  }
}

const ENV_VAR_MAPPINGS: Record<SearchProviderId, string[]> = {
  brave: ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  exa: ["EXA_API_KEY"],
  parallel: ["PARALLEL_API_KEY"],
  tinyfish: ["TINYFISH_API_KEY"],
  antigravity: [],
};

/**
 * Resolves API key for a search provider.
 */
export function resolveSearchApiKey(provider: SearchProviderId): string | undefined {
  // 1. Check environment variables
  for (const envName of ENV_VAR_MAPPINGS[provider] || []) {
    const val = process.env[envName];
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }

  // 2. Check ~/.pi/agent/auth.json
  const authData = readPiAuthJson();
  const entry = authData[provider];
  if (entry) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return entry.trim();
    }
    if (typeof entry === "object" && entry.key && typeof entry.key === "string") {
      return entry.key.trim();
    }
    if (typeof entry === "object" && entry.apiKey && typeof entry.apiKey === "string") {
      return entry.apiKey.trim();
    }
  }

  // 3. Check multi-account store
  const store = AccountStore.getInstance();
  const activeAccount = store.getActive(provider);
  if (activeAccount?.apiKey) {
    return activeAccount.apiKey.trim();
  }

  return undefined;
}
