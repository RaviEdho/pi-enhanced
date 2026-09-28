/**
 * Web Search Subsystem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSearchLoginProviders } from "./login.js";
import { createWebSearchToolDefinition } from "./tools.js";

export function registerWebSearch(pi: ExtensionAPI): void {
  // Register search providers into /login and /logout
  registerSearchLoginProviders(pi);

  // Register the unified web_search tool
  pi.registerTool(createWebSearchToolDefinition());

  // Ensure web_search is active in the session
  try {
    const current = pi.getActiveTools();
    if (!current.includes("web_search")) {
      pi.setActiveTools([...current, "web_search"]);
    }
  } catch {
    // Non-fatal if session runner not yet initialized
  }
}

export * from "./types.js";
export * from "./pipeline.js";
