/**
 * Web Search Subsystem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSearchLoginProviders } from "./login.js";
import { createWebFetchToolDefinition, createWebSearchToolDefinition } from "./tools.js";

export function registerWebSearch(pi: ExtensionAPI): void {
  // Register search providers into /login and /logout
  registerSearchLoginProviders(pi);

  // Register the unified web_search and web_fetch tools
  pi.registerTool(createWebSearchToolDefinition());
  pi.registerTool(createWebFetchToolDefinition());

  // Ensure tools are active in the session
  try {
    const current = pi.getActiveTools();
    const additions: string[] = [];
    if (!current.includes("web_search")) additions.push("web_search");
    if (!current.includes("web_fetch")) additions.push("web_fetch");
    if (additions.length > 0) {
      pi.setActiveTools([...current, ...additions]);
    }
  } catch {
    // Non-fatal if session runner not yet initialized
  }
}

export * from "./types.js";
export * from "./pipeline.js";
export * from "./fetch/types.js";
export * from "./fetch/pipeline.js";
