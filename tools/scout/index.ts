import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionToolState } from "../../ux/settings/session.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { registerSearchInterceptor } from "./interceptor.js";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createMultiGrepToolDefinition,
} from "./tools.js";

const SEARCH_TOOL_NAMES = ["find", "grep", "multi_grep"];
export const SCOUT_TOOL_SESSION_ENTRY = "scout-tool-session-state";

export interface ScoutSessionState {
  enabled: boolean;
  timestamp: number;
}

let activeSessionEnabled: boolean | undefined = undefined;
let savedPi: ExtensionAPI | undefined = undefined;

/**
 * Returns whether Scout search tools are active for the current session.
 * Prefers the session-persisted state to protect prompt caches on resumed sessions,
 * falling back to active tools in the session, or the global setting in enhanced-settings.json.
 */
export function isScoutActive(): boolean {
  if (activeSessionEnabled !== undefined) {
    return activeSessionEnabled;
  }
  if (savedPi) {
    try {
      const active = savedPi.getActiveTools();
      if (active && active.length > 0) {
        return active.includes("find");
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }
  return EnhancedSettingsStore.getInstance().get("scout.enabled");
}

export function registerScout(pi: ExtensionAPI): void {
  savedPi = pi;
  // Register core search tools
  pi.registerTool(createFindToolDefinition("find"));
  pi.registerTool(createGrepToolDefinition("grep"));
  pi.registerTool(createMultiGrepToolDefinition("multi_grep"));

  const store = EnhancedSettingsStore.getInstance();

  function syncSearchTools(enabled?: boolean): void {
    const isEnabled = enabled !== undefined ? enabled : isScoutActive();
    try {
      const current = pi.getActiveTools();
      if (isEnabled) {
        const toAdd = SEARCH_TOOL_NAMES.filter((name) => !current.includes(name));
        if (toAdd.length > 0) {
          pi.setActiveTools([...current, ...toAdd]);
        }
      } else {
        const remaining = current.filter((name) => !SEARCH_TOOL_NAMES.includes(name));
        if (remaining.length !== current.length) {
          pi.setActiveTools(remaining);
        }
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  // Session lifecycle: restore session-scoped state to protect prompt cache on resumed sessions
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager?.getEntries?.() || [];
    const isEnabled = resolveSessionToolState(entries, "find", store.get("scout.enabled"));
    activeSessionEnabled = isEnabled;
    syncSearchTools(isEnabled);

    // Warm index in background only if Scout is enabled for this session
    if (isEnabled) {
      try {
        const { FileIndexer } = await import("./indexer.js");
        const indexer = FileIndexer.getInstance();
        indexer.scan().catch(() => {});
      } catch {
        // Ignore background warmup errors
      }
    }
  });

  // Dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "scout.enabled") {
      const newEnabled = settings["scout.enabled"];
      activeSessionEnabled = newEnabled;
      syncSearchTools(newEnabled);
    }
  });

  // Inject system prompt rules and guidelines nudging agent to use in-memory search tools over bash
  pi.on("before_agent_start", (event) => {
    const isEnabled = isScoutActive();

    // If disabled: completely prune search tools from active tools, toolSnippets, and prompt guidelines
    if (!isEnabled) {
      if (event.systemPromptOptions?.selectedTools) {
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
          (name) => !SEARCH_TOOL_NAMES.includes(name)
        );
      }
      syncSearchTools(false);
      return;
    }

    if (!event.systemPromptOptions) return;

    if (event.systemPromptOptions.selectedTools) {
      for (const name of SEARCH_TOOL_NAMES) {
        if (!event.systemPromptOptions.selectedTools.includes(name)) {
          event.systemPromptOptions.selectedTools.push(name);
        }
      }
    }

    // Override shell tool snippets so Pi doesn't advertise (ls, grep, find) under <tools>
    if (!event.systemPromptOptions.toolSnippets) {
      event.systemPromptOptions.toolSnippets = {};
    }
    const shellSnippet =
      "Execute shell commands (git, build tools, tests, package managers). Do NOT use for searching code or files; use grep, multi_grep, or find instead.";
    event.systemPromptOptions.toolSnippets["bash"] = shellSnippet;
    event.systemPromptOptions.toolSnippets["powershell"] = shellSnippet;

    // Attach strict negative constraints to bash and powershell tool guidelines
    if (!event.systemPromptOptions.toolGuidelines) {
      event.systemPromptOptions.toolGuidelines = {};
    }
    for (const shellTool of ["bash", "powershell"]) {
      if (!event.systemPromptOptions.toolGuidelines[shellTool]) {
        event.systemPromptOptions.toolGuidelines[shellTool] = [];
      }
      event.systemPromptOptions.toolGuidelines[shellTool].push(
        "Never run file search or content search commands (rg, ripgrep, grep, find, ag, fd) via shell. Always use the dedicated grep, find, or multi_grep tools instead."
      );
    }

    if (!event.systemPromptOptions.promptGuidelines) {
      event.systemPromptOptions.promptGuidelines = [];
    }
    event.systemPromptOptions.promptGuidelines.push(
      "CRITICAL: Do NOT execute `rg`, `ripgrep`, `grep`, `find`, `fd`, or `ag` via the bash or powershell tools. Always use the built-in search tools (`grep`, `multi_grep`, `find`) for both workspace and external paths.",
      "The built-in search tools support workspace files (in-memory) and external paths/node_modules (auto-fallback), definition-first ranking, and token-compressed output."
    );
  });

  // Transparent interceptor: catch standalone search commands run via bash/powershell,
  // execute them via the enhanced search engine, and nudge the agent towards specialized tools.
  registerSearchInterceptor(pi);

  // Save frecency to disk cleanly on shutdown
  pi.on("session_shutdown", async () => {
    try {
      const { FrecencyTracker } = await import("./frecency.js");
      FrecencyTracker.getInstance().saveSync();
    } catch {
      // Ignore shutdown errors
    }
  });

  // Rescan command to force reindexing
  const handleRescan = async (_args: string | undefined, ctx: any) => {
    const { FileIndexer } = await import("./indexer.js");
    const indexer = FileIndexer.getInstance(ctx.cwd);
    await indexer.scan(true);
    const count = indexer.getIndexedFileCount();
    const gitCount = indexer.getGitModifiedCount();
    const msg = `Rescanned ${count} files (${gitCount} git modified/staged/untracked).`;
    if (ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  };

  pi.registerCommand("scout-rescan", {
    description: "Force rescan the repository index and refresh git status",
    handler: handleRescan,
  });

  // Health check command for scout index
  const handleHealth = async (_args: string | undefined, ctx: any) => {
    const { FileIndexer } = await import("./indexer.js");
    const indexer = FileIndexer.getInstance(ctx.cwd);
    const count = indexer.getIndexedFileCount();
    const gitCount = indexer.getGitModifiedCount();
    const memoryKb = Math.round(process.memoryUsage().heapUsed / 1024);
    const active = isScoutActive();
    const statusStr = active ? "Active" : "Disabled";

    const lines = [
      `Scout Search Engine Health (${statusStr}):`,
      `  Files Indexed:   ${count}`,
      `  Git Tracked:     ${gitCount}`,
      `  Process Heap:    ${memoryKb} KB`,
      `  Indexed Exts:    ts, js, json, md, rs, py, go, c, cpp, h, toml, yaml...`,
    ];
    const msg = lines.join("\n");
    if (ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  };

  pi.registerCommand("scout-health", {
    description: "Display health, file count, and memory metrics for Scout index",
    handler: handleHealth,
  });
}

export { FileIndexer } from "./indexer.js";
export { FrecencyTracker } from "./frecency.js";
export {
  createFindToolDefinition,
  createGrepToolDefinition,
  createMultiGrepToolDefinition,
} from "./tools.js";
