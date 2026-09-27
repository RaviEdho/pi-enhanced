import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CursorStore } from "./cursor.js";
import { formatFindOutput, formatGrepOutput } from "./formatter.js";
import { FrecencyTracker } from "./frecency.js";
import { FileIndexer } from "./indexer.js";

const PAGE_SIZE_FIND = 30;
const PAGE_SIZE_GREP = 35;

export const findToolSchema = Type.Object({
  pattern: Type.Optional(Type.String({ description: "Fuzzy search query for file paths (supports !exclude, *.ext, git:modified)" })),
  path: Type.Optional(Type.String({ description: "Directory constraint or subpath" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of files to return (default: 30)" })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for fetching the next page" })),
});

export const grepToolSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (text or regex)" }),
  path: Type.Optional(Type.String({ description: "Directory or file path constraint (e.g. 'src/', '!test/')" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: smart case)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of context lines before and after match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 35)" })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for fetching the next page" })),
});

export const multiGrepToolSchema = Type.Object({
  patterns: Type.Array(Type.String({ description: "Search pattern (literal text)" }), {
    description: "Array of patterns to search simultaneously with OR logic",
  }),
  path: Type.Optional(Type.String({ description: "Directory or path constraint" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  context: Type.Optional(Type.Number({ description: "Number of context lines (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches (default: 40)" })),
});

export function createFindToolDefinition(name = "smart_find"): ToolDefinition<typeof findToolSchema> {
  return {
    name,
    label: name,
    description:
      "Fast, frecency-ranked, typo-tolerant file finder. Automatically prioritizes modified/staged git files and files you work on most. Supports constraints like 'git:modified', '*.ts', '!test/'.",
    parameters: findToolSchema,
    promptGuidelines: [
      `Use ${name} to locate files by fuzzy name or path instead of running bash (find, ls, locate). Supports constraints like 'git:modified', '*.ts', '!test/'. Automatically ranks active and recently edited files highest.`,
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const indexer = FileIndexer.getInstance(ctx?.cwd);
      const frecency = FrecencyTracker.getInstance();
      const cursorStore = CursorStore.getInstance();

      let query = (params.pattern || "").trim();
      if (params.path && params.path !== ".") {
        query = `${params.path} ${query}`.trim();
      }

      let offset = 0;
      const limit = params.limit ?? PAGE_SIZE_FIND;

      if (params.cursor) {
        const stored = cursorStore.get(params.cursor);
        if (stored && stored.type === "find") {
          offset = stored.nextOffset;
          query = stored.query;
        }
      }

      const { files, totalMatched } = await indexer.findFiles(query, { limit, offset });

      // Record access for top 3 matched files in frecency memory
      for (let i = 0; i < Math.min(3, files.length); i++) {
        frecency.recordAccess(files[i].relativePath);
      }

      let nextCursor: string | undefined;
      if (offset + files.length < totalMatched) {
        nextCursor = cursorStore.store("find", query, offset + files.length, params);
      }

      const items = files.map((f) => ({
        relativePath: f.relativePath,
        gitStatus: f.gitStatus,
        frecencyTag: frecency.getFrecencyTag(f.frecencyScore),
        score: f.frecencyScore,
      }));

      const output = formatFindOutput(items, totalMatched, nextCursor);
      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched, count: items.length },
      };
    },
  };
}

export function createGrepToolDefinition(name = "smart_grep"): ToolDefinition<typeof grepToolSchema> {
  return {
    name,
    label: name,
    description:
      "Fast in-memory content search with definition-first prioritization, smart case, and typo fallback. Compresses matching lines to save LLM tokens. Surfaces definitions before usages.",
    parameters: grepToolSchema,
    promptGuidelines: [
      `Use ${name} to search code contents instead of running bash (grep, rg, ag). Returns compressed, definition-first results to minimize context size. Tolerates typos and automatically matches case.`,
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const indexer = FileIndexer.getInstance(ctx?.cwd);
      const frecency = FrecencyTracker.getInstance();
      const cursorStore = CursorStore.getInstance();

      let pattern = params.pattern;
      let offset = 0;
      const limit = params.limit ?? PAGE_SIZE_GREP;

      if (params.cursor) {
        const stored = cursorStore.get(params.cursor);
        if (stored && stored.type === "grep") {
          offset = stored.nextOffset;
          pattern = stored.query;
        }
      }

      const { matches, totalMatched, filesSearched } = await indexer.grep(pattern, {
        path: params.path,
        glob: params.glob,
        ignoreCase: params.ignoreCase,
        literal: params.literal,
        context: params.context,
        limit,
        offset,
      });

      // Record frecency access for files containing matched definitions
      for (const m of matches) {
        if (m.isDefinition) {
          frecency.recordAccess(m.filePath);
        }
      }

      let nextCursor: string | undefined;
      if (offset + matches.length < totalMatched) {
        nextCursor = cursorStore.store("grep", pattern, offset + matches.length, params);
      }

      const output = formatGrepOutput(matches, totalMatched, nextCursor);
      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched, count: matches.length, filesSearched },
      };
    },
  };
}

export function createMultiGrepToolDefinition(name = "multi_grep"): ToolDefinition<typeof multiGrepToolSchema> {
  return {
    name,
    label: name,
    description:
      "Search multiple patterns simultaneously with OR logic in one single pass. Eliminates multiple grep tool turns and saves agent context tokens.",
    parameters: multiGrepToolSchema,
    promptGuidelines: [
      `Use ${name} when searching for multiple keywords or identifiers simultaneously instead of running multiple sequential bash grep commands.`,
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const indexer = FileIndexer.getInstance(ctx?.cwd);
      const frecency = FrecencyTracker.getInstance();

      const { matches, totalMatched, filesSearched } = await indexer.multiGrep(params.patterns, {
        path: params.path,
        glob: params.glob,
        ignoreCase: params.ignoreCase,
        context: params.context,
        limit: params.limit ?? 40,
      });

      for (const m of matches) {
        if (m.isDefinition) {
          frecency.recordAccess(m.filePath);
        }
      }

      const output = formatGrepOutput(matches, totalMatched);
      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched, count: matches.length, filesSearched },
      };
    },
  };
}
