import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSearchInterceptor } from "./interceptor.js";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createMultiGrepToolDefinition,
} from "./tools.js";

export function registerScout(pi: ExtensionAPI): void {
  // Register core search tools
  pi.registerTool(createFindToolDefinition("find"));
  pi.registerTool(createGrepToolDefinition("grep"));
  pi.registerTool(createMultiGrepToolDefinition("multi_grep"));

  const searchToolNames = ["find", "grep", "multi_grep"];

  function activateSearchTools(): void {
    try {
      const current = pi.getActiveTools();
      const toAdd = searchToolNames.filter((name) => !current.includes(name));
      if (toAdd.length > 0) {
        pi.setActiveTools([...current, ...toAdd]);
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  activateSearchTools();

  // Warm index in the background when session starts and ensure tools are active
  pi.on("session_start", async () => {
    try {
      activateSearchTools();
      const { FileIndexer } = await import("./indexer.js");
      const indexer = FileIndexer.getInstance();
      // Start background scan without blocking startup
      indexer.scan().catch(() => {});
    } catch {
      // Ignore background warmup errors
    }
  });

  // Inject system prompt rules and guidelines nudging agent to use in-memory search tools over bash
  pi.on("before_agent_start", (event) => {
    if (!event.systemPromptOptions) return;

    if (event.systemPromptOptions.selectedTools) {
      for (const name of searchToolNames) {
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
  pi.registerCommand("search-rescan", {
    description: "Alias for /scout-rescan",
    handler: handleRescan,
  });

  // Health command
  const handleHealth = async (_args: string | undefined, ctx: any) => {
    const { FileIndexer } = await import("./indexer.js");
    const { FrecencyTracker } = await import("./frecency.js");
    const indexer = FileIndexer.getInstance(ctx.cwd);
    const frecency = FrecencyTracker.getInstance();
    await indexer.scan();
    const filesCount = indexer.getIndexedFileCount();
    const gitCount = indexer.getGitModifiedCount();
    const frecencyCount = frecency.getTrackedCount();
    const memUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const report = [
      "Scout Search Engine Status:",
      `  Indexed files:    ${filesCount}`,
      `  Git changes:      ${gitCount} active files`,
      `  Frecency memory:  ${frecencyCount} tracked entries`,
      `  Heap memory:      ~${memUsageMb} MB`,
    ].join("\n");

    if (ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify(report, "info");
    } else {
      console.log(report);
    }
  };

  pi.registerCommand("scout-health", {
    description: "Display scout search engine health, indexed file counts, and frecency memory",
    handler: handleHealth,
  });
  pi.registerCommand("search-health", {
    description: "Alias for /scout-health",
    handler: handleHealth,
  });
}

// Backward-compatible alias
export const registerSmartSearch = registerScout;

