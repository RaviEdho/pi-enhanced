/**
 * Web Search Subsystem.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { registerSearchLoginProviders } from "./login.js";
import { createWebFetchToolDefinition, createWebSearchToolDefinition } from "./tools.js";

const WEB_TOOL_NAMES = ["web_search", "web_fetch"];
export const WEB_TOOL_SESSION_ENTRY = "web-tool-session-state";

export interface WebSessionState {
  enabled: boolean;
  timestamp: number;
}

let activeSessionEnabled: boolean | undefined = undefined;
let savedPi: ExtensionAPI | undefined = undefined;

/**
 * Returns whether web search and fetch tools are active for the current session.
 * Prefers session-persisted state to protect prompt caches on resumed sessions,
 * falling back to active tools in the session, or the global setting in enhanced-settings.json.
 */
export function isWebActive(): boolean {
  if (activeSessionEnabled !== undefined) {
    return activeSessionEnabled;
  }
  if (savedPi) {
    try {
      const active = savedPi.getActiveTools();
      if (active && active.length > 0) {
        return active.includes("web_search");
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }
  return EnhancedSettingsStore.getInstance().get("web.enabled");
}

export function registerWebSearch(pi: ExtensionAPI): void {
  savedPi = pi;

  // Register search providers into /login and /logout
  registerSearchLoginProviders(pi);

  // Register the unified web_search and web_fetch tools
  pi.registerTool(createWebSearchToolDefinition());
  pi.registerTool(createWebFetchToolDefinition());

  const store = EnhancedSettingsStore.getInstance();

  function syncWebTools(enabled?: boolean): void {
    const isEnabled = enabled !== undefined ? enabled : isWebActive();
    try {
      const current = pi.getActiveTools();
      if (isEnabled) {
        const toAdd = WEB_TOOL_NAMES.filter((name) => !current.includes(name));
        if (toAdd.length > 0) {
          pi.setActiveTools([...current, ...toAdd]);
        }
      } else {
        const remaining = current.filter((name) => !WEB_TOOL_NAMES.includes(name));
        if (remaining.length !== current.length) {
          pi.setActiveTools(remaining);
        }
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  // Initial sync
  syncWebTools();

  // Session lifecycle: restore session-scoped state to protect prompt cache on resumed sessions
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager?.getEntries?.() || [];

    // 1. Look for explicit persisted session state
    const lastSessionEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.type === "custom" &&
          ((e as any).customType === WEB_TOOL_SESSION_ENTRY ||
            (e as any).name === WEB_TOOL_SESSION_ENTRY)
      );

    const customEntry = lastSessionEntry as any;
    if (
      customEntry?.data &&
      typeof customEntry.data.enabled === "boolean"
    ) {
      activeSessionEnabled = customEntry.data.enabled;
    } else {
      // 2. Check if this is an existing session with past conversation history
      const hasPriorConversation = entries.some(
        (e: any) =>
          e.type === "message" ||
          e.type === "custom_message" ||
          e.role === "user" ||
          e.role === "assistant"
      );

      if (hasPriorConversation) {
        // Existing session: keep enabled to preserve prefix prompt cache hits!
        activeSessionEnabled = true;
      } else {
        // 3. New session: adopt user's global setting from enhanced-settings.json
        activeSessionEnabled = store.get("web.enabled");
        try {
          pi.appendEntry(WEB_TOOL_SESSION_ENTRY, {
            enabled: activeSessionEnabled,
            timestamp: Date.now(),
          } satisfies WebSessionState);
        } catch {
          // Ignore if session tree is not yet writable
        }
      }
    }

    syncWebTools(activeSessionEnabled);
  });

  // Dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "web.enabled") {
      const newEnabled = settings["web.enabled"];
      activeSessionEnabled = newEnabled;
      syncWebTools(newEnabled);

      try {
        pi.appendEntry(WEB_TOOL_SESSION_ENTRY, {
          enabled: newEnabled,
          timestamp: Date.now(),
        } satisfies WebSessionState);
      } catch {
        // Non-fatal
      }
    }
  });

  // Inject or prune web tools from system prompt
  pi.on("before_agent_start", (event) => {
    const isEnabled = isWebActive();

    // If disabled: completely prune web tools from active tools and prompt
    if (!isEnabled) {
      if (event.systemPromptOptions?.selectedTools) {
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
          (name) => !WEB_TOOL_NAMES.includes(name)
        );
      }
      syncWebTools(false);
      return;
    }

    if (!event.systemPromptOptions) return;

    if (event.systemPromptOptions.selectedTools) {
      for (const name of WEB_TOOL_NAMES) {
        if (!event.systemPromptOptions.selectedTools.includes(name)) {
          event.systemPromptOptions.selectedTools.push(name);
        }
      }
    }
  });
}

export * from "./types.js";
export * from "./fetch/types.js";
export {
  createWebFetchToolDefinition,
  createWebSearchToolDefinition,
} from "./tools.js";
