import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionToolState } from "../../ux/settings/session.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { registerSearchInterceptor } from "./interceptor.js";
import { FrecencyTracker } from "./frecency.js";
import { createFindToolDefinition, createGrepToolDefinition } from "./tools.js";

const SEARCH_TOOL_NAMES = ["find", "grep"];
export const SCOUT_TOOL_SESSION_ENTRY = "scout-tool-session-state";
export interface ScoutSessionState { enabled: boolean; timestamp: number }
let activeSessionEnabled: boolean | undefined;
let savedPi: ExtensionAPI | undefined;

export function isScoutActive(): boolean {
  if (activeSessionEnabled !== undefined) return activeSessionEnabled;
  if (savedPi) {
    try {
      const active = savedPi.getActiveTools();
      if (active?.length) return active.includes("find");
    } catch { /* Session runner may not be initialized yet. */ }
  }
  return EnhancedSettingsStore.getInstance().get("scout.enabled");
}

export function registerScout(pi: ExtensionAPI): void {
  savedPi = pi;
  pi.registerTool(createFindToolDefinition("find"));
  pi.registerTool(createGrepToolDefinition("grep"));
  const store = EnhancedSettingsStore.getInstance();
  function syncSearchTools(enabled: boolean): void {
    try {
      const current = pi.getActiveTools();
      const next = enabled ? [...current, ...SEARCH_TOOL_NAMES.filter((name) => !current.includes(name))]
        : current.filter((name) => !SEARCH_TOOL_NAMES.includes(name));
      if (next.length !== current.length) pi.setActiveTools(next);
    } catch { /* Session runner may not be initialized yet. */ }
  }
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    activeSessionEnabled = resolveSessionToolState(ctx.sessionManager?.getEntries?.() || [], "find", store.get("scout.enabled"));
    syncSearchTools(activeSessionEnabled);
    // The first search scans on demand. Do not walk a potentially huge workspace
    // while Pi is opening a session that may never use Scout.
  });
  const unsubscribe = store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "scout.enabled") {
      activeSessionEnabled = settings["scout.enabled"];
      syncSearchTools(activeSessionEnabled);
    }
  });
  pi.on("before_agent_start", (event) => {
    if (!isScoutActive()) {
      if (event.systemPromptOptions?.selectedTools) {
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name) => !SEARCH_TOOL_NAMES.includes(name));
      }
      syncSearchTools(false);
      return;
    }
    if (!event.systemPromptOptions) return;
    const options = event.systemPromptOptions;
    if (options.selectedTools) {
      for (const name of SEARCH_TOOL_NAMES) if (!options.selectedTools.includes(name)) options.selectedTools.push(name);
    }
    options.toolSnippets ??= {};
    const shellSnippet = "Execute shell commands (git, build tools, tests, package managers). Do NOT use for searching code or files; use grep or find instead.";
    options.toolSnippets.bash = shellSnippet;
    options.toolSnippets.powershell = shellSnippet;
    options.toolGuidelines ??= {};
    for (const tool of ["bash", "powershell"]) {
      (options.toolGuidelines[tool] ??= []).push(
        "Never run file search or content search commands (rg, ripgrep, grep, find, ag, fd) via shell. Always use the dedicated grep or find tools instead."
      );
    }
    (options.promptGuidelines ??= []).push(
      "CRITICAL: Do NOT execute `rg`, `ripgrep`, `grep`, `find`, `fd`, or `ag` via the bash or powershell tools. Always use the built-in search tools (`grep`, `find`) for both workspace and external paths.",
      "The built-in search tools support workspace files (in-memory) and external paths/node_modules (auto-fallback), definition-first ranking, and token-compressed output."
    );
  });
  registerSearchInterceptor(pi);
  pi.on("session_shutdown", () => {
    unsubscribe();
    // Flush only an existing tracker; never initialize the search engine on exit.
    FrecencyTracker.saveIfInitialized();
    activeSessionEnabled = undefined;
    savedPi = undefined;
  });
  pi.registerCommand("scout-rescan", {
    description: "Force rescan the repository index and refresh git status",
    handler: async (_args, ctx) => {
      const { FileIndexer } = await import("./indexer.js");
      const indexer = FileIndexer.getInstance(ctx.cwd);
      await indexer.scan(true);
      const message = `Rescanned ${indexer.getIndexedFileCount()} files (${indexer.getGitModifiedCount()} git modified/staged/untracked).`;
      if (ctx.hasUI && ctx.mode === "tui") ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
  pi.registerCommand("scout-health", {
    description: "Display health, file count, and memory metrics for Scout index",
    handler: async (_args, ctx) => {
      const { FileIndexer } = await import("./indexer.js");
      const indexer = FileIndexer.getInstance(ctx.cwd);
      const message = [
        `Scout Search Engine Health (${isScoutActive() ? "Active" : "Disabled"}):`,
        `  Files Indexed:   ${indexer.getIndexedFileCount()}`,
        `  Git Tracked:     ${indexer.getGitModifiedCount()}`,
        `  Process Heap:    ${Math.round(process.memoryUsage().heapUsed / 1024)} KB`,
        "  Indexed Exts:    ts, js, json, md, rs, py, go, c, cpp, h, toml, yaml...",
      ].join("\n");
      if (ctx.hasUI && ctx.mode === "tui") ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });
}
