import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FrecencyTracker } from "./frecency.js";
import { FileIndexer } from "./indexer.js";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createMultiGrepToolDefinition,
} from "./tools.js";
import type { SearchMode } from "./types.js";

let currentMode: SearchMode = "override";

export function registerSmartSearch(pi: ExtensionAPI): void {
  const frecency = FrecencyTracker.getInstance();

  // Determine tool names based on mode
  function getToolNames(mode: SearchMode) {
    if (mode === "override") {
      return {
        find: "find",
        grep: "grep",
        multiGrep: "multi_grep",
      };
    }
    return {
      find: "smart_find",
      grep: "smart_grep",
      multiGrep: "multi_grep",
    };
  }

  // Register core smart search tools
  pi.registerTool(createFindToolDefinition("find"));
  pi.registerTool(createGrepToolDefinition("grep"));
  pi.registerTool(createMultiGrepToolDefinition("multi_grep"));
  pi.registerTool(createFindToolDefinition("smart_find"));
  pi.registerTool(createGrepToolDefinition("smart_grep"));

  const searchToolNames = ["find", "grep", "multi_grep", "smart_find", "smart_grep"];

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
      const indexer = FileIndexer.getInstance();
      // Start background scan without blocking startup
      indexer.scan().catch(() => {});
    } catch {
      // Ignore background warmup errors
    }
  });

  // Inject system prompt rule nudging agent to use in-memory search tools over bash
  pi.on("before_agent_start", (event) => {
    if (event.systemPromptOptions?.selectedTools) {
      for (const name of searchToolNames) {
        if (!event.systemPromptOptions.selectedTools.includes(name)) {
          event.systemPromptOptions.selectedTools.push(name);
        }
      }
    }

    if (event.systemPromptOptions) {
      if (!event.systemPromptOptions.promptGuidelines) {
        event.systemPromptOptions.promptGuidelines = [];
      }
      event.systemPromptOptions.promptGuidelines.push(
        "Prefer the dedicated find, grep, and multi_grep tools over running find, ls, or grep in bash for file discovery and code search."
      );
    }
  });

  // Save frecency to disk cleanly on shutdown
  pi.on("session_shutdown", () => {
    frecency.saveSync();
  });

  // /search-rescan command to force reindexing
  pi.registerCommand("search-rescan", {
    description: "Force rescan the repository index and refresh git status",
    handler: async (_args, ctx) => {
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
    },
  });

  // /search-health command
  pi.registerCommand("search-health", {
    description: "Display smart search engine health, indexed file counts, and frecency memory",
    handler: async (_args, ctx) => {
      const indexer = FileIndexer.getInstance(ctx.cwd);
      await indexer.scan();
      const filesCount = indexer.getIndexedFileCount();
      const gitCount = indexer.getGitModifiedCount();
      const frecencyCount = frecency.getTrackedCount();
      const memUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      const report = [
        "Smart Search Engine Status:",
        `  Mode:             ${currentMode}`,
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
    },
  });

  // /search-mode command to toggle mode
  pi.registerCommand("search-mode", {
    description: "Switch search tool registration mode: /search-mode [override|tools]",
    handler: async (args, ctx) => {
      const mode = args?.trim().toLowerCase();
      if (mode === "override" || mode === "tools") {
        currentMode = mode as SearchMode;
        const msg = `Search mode switched to '${currentMode}'. (Note: Tool name rebindings take effect on reload / next session).`;
        if (ctx.hasUI && ctx.mode === "tui") {
          ctx.ui.notify(msg, "info");
        } else {
          console.log(msg);
        }
      } else {
        const msg = `Current search mode: '${currentMode}'. Usage: /search-mode [override|tools]`;
        if (ctx.hasUI && ctx.mode === "tui") {
          ctx.ui.notify(msg, "info");
        } else {
          console.log(msg);
        }
      }
    },
  });
}
