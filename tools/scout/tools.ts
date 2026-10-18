import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CursorStore } from "./cursor.js";
import { externalFind, externalGrep, externalMultiGrep } from "./external.js";
import { formatFindOutput, formatGrepOutput } from "./formatter.js";
import { FrecencyTracker } from "./frecency.js";
import { FileIndexer } from "./indexer.js";
import { isScoutActive } from "./index.js";

const PAGE_SIZE_FIND = 30;
const PAGE_SIZE_GREP = 35;

export function shouldDelegateToExternal(targetPath: string | undefined, cwd: string): boolean {
  if (!targetPath || targetPath === "." || targetPath === "./") return false;
  let trimmed = targetPath.trim();

  // Expand ~ and ~/
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    trimmed = path.join(os.homedir(), trimmed.slice(1));
  }

  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(cwd, trimmed);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return true;
    }
  } else if (trimmed.startsWith("../") || trimmed === "..") {
    return true;
  }

  const norm = trimmed.replace(/\\/g, "/");
  // Check unindexed dirs
  if (
    /(?:^|\/)(?:node_modules|\.git|dist|build|target|\.next|\.turbo|\.cache|\.venv|venv|__pycache__|coverage)(?:\/|$)/.test(
      norm
    )
  ) {
    return true;
  }
  return false;
}

export async function executeFind(
  params: {
    pattern?: string;
    path?: string;
    limit?: number;
    cursor?: string;
  },
  cwd: string
): Promise<{ output: string; details: any }> {
  const cursorStore = CursorStore.getInstance();
  let offset = 0;
  let limit = params.limit ?? PAGE_SIZE_FIND;

  let query = (params.pattern || "").trim();
  let targetPath = params.path;

  if (params.cursor) {
    const stored = cursorStore.get(params.cursor);
    if (stored && stored.type === "find") {
      offset = stored.nextOffset;
      query = stored.query;
      targetPath = targetPath ?? stored.options?.path;
      if (params.limit === undefined && typeof stored.options?.limit === "number") {
        limit = stored.options.limit;
      }
    }
  }

  if (targetPath && shouldDelegateToExternal(targetPath, cwd)) {
    const { items, totalMatched } = await externalFind(
      query,
      {
        path: targetPath,
        limit,
        offset,
      },
      cwd
    );

    let nextCursor: string | undefined;
    if (offset + items.length < totalMatched) {
      nextCursor = cursorStore.store("find", query, offset + items.length, { ...params, path: targetPath });
    }

    const output = formatFindOutput(items, totalMatched, nextCursor);
    return {
      output,
      details: { totalMatched, count: items.length, external: true },
    };
  }

  const indexer = FileIndexer.getInstance(cwd);
  const frecency = FrecencyTracker.getInstance();

  let relPath = targetPath;
  if (relPath && path.isAbsolute(relPath)) {
    relPath = path.relative(cwd, relPath);
  }

  if (relPath && relPath !== "." && !params.cursor) {
    query = `${relPath} ${query}`.trim();
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
    output,
    details: { totalMatched, count: items.length },
  };
}

export async function executeGrep(
  params: {
    pattern?: string;
    patterns?: string[];
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
    cursor?: string;
  },
  cwd: string
): Promise<{ output: string; details: any }> {
  const cursorStore = CursorStore.getInstance();

  let pattern = params.pattern;
  let patterns = params.patterns ? [...params.patterns] : undefined;
  let offset = 0;
  let limit = params.limit ?? PAGE_SIZE_GREP;
  let targetPath = params.path;
  let glob = params.glob;
  let ignoreCase = params.ignoreCase;
  let literal = params.literal;
  let context = params.context;

  if (params.cursor) {
    const stored = cursorStore.get(params.cursor);
    if (stored && stored.type === "grep") {
      offset = stored.nextOffset;
      if (stored.options?.patterns && Array.isArray(stored.options.patterns)) {
        patterns = stored.options.patterns;
      } else {
        pattern = stored.query;
      }
      targetPath = targetPath ?? stored.options?.path;
      glob = glob ?? stored.options?.glob;
      ignoreCase = ignoreCase ?? stored.options?.ignoreCase;
      literal = literal ?? stored.options?.literal;
      context = context ?? stored.options?.context;
      if (params.limit === undefined && typeof stored.options?.limit === "number") {
        limit = stored.options.limit;
      }
    }
  }

  // Normalize patterns vs pattern
  if (patterns && patterns.length > 0) {
    if (pattern && !patterns.includes(pattern)) {
      patterns.unshift(pattern);
    }
    if (patterns.length === 1) {
      pattern = patterns[0];
      patterns = undefined;
    }
  }

  // If neither pattern nor patterns is provided
  if (!pattern && (!patterns || patterns.length === 0)) {
    return {
      output: "Error: Must provide either 'pattern' or 'patterns' to grep.",
      details: { totalMatched: 0, count: 0, error: "Missing pattern" },
    };
  }

  // Handle multi-pattern search when multiple patterns are present
  if (patterns && patterns.length > 1) {
    if (targetPath && shouldDelegateToExternal(targetPath, cwd)) {
      const { matches, totalMatched } = await externalMultiGrep(
        patterns,
        {
          path: targetPath,
          glob,
          ignoreCase,
          context,
          limit,
          offset,
        },
        cwd
      );

      let nextCursor: string | undefined;
      if (offset + matches.length < totalMatched) {
        nextCursor = cursorStore.store("grep", patterns.join(" | "), offset + matches.length, {
          ...params,
          patterns,
          path: targetPath,
          glob,
          ignoreCase,
          context,
          limit,
        });
      }

      const output = formatGrepOutput(matches, totalMatched, nextCursor);
      return {
        output,
        details: { totalMatched, count: matches.length, filesSearched: 0, external: true, patterns },
      };
    }

    const indexer = FileIndexer.getInstance(cwd);
    const frecency = FrecencyTracker.getInstance();

    const { matches, totalMatched, filesSearched } = await indexer.multiGrep(patterns, {
      path: targetPath,
      glob,
      ignoreCase,
      context,
      limit,
      offset,
    });

    for (const m of matches) {
      if (m.isDefinition) {
        frecency.recordAccess(m.filePath);
      }
    }

    let nextCursor: string | undefined;
    if (offset + matches.length < totalMatched) {
      nextCursor = cursorStore.store("grep", patterns.join(" | "), offset + matches.length, {
        ...params,
        patterns,
        path: targetPath,
        glob,
        ignoreCase,
        context,
        limit,
      });
    }

    const output = formatGrepOutput(matches, totalMatched, nextCursor);
    return {
      output,
      details: { totalMatched, count: matches.length, filesSearched, patterns },
    };
  }

  // Fallback to single pattern
  const singlePattern = pattern!;

  if (targetPath && shouldDelegateToExternal(targetPath, cwd)) {
    const { matches, totalMatched } = await externalGrep(
      singlePattern,
      {
        path: targetPath,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
        offset,
      },
      cwd
    );

    let nextCursor: string | undefined;
    if (offset + matches.length < totalMatched) {
      nextCursor = cursorStore.store("grep", singlePattern, offset + matches.length, {
        ...params,
        path: targetPath,
        glob,
        ignoreCase,
        literal,
        context,
      });
    }

    const output = formatGrepOutput(matches, totalMatched, nextCursor);
    return {
      output,
      details: { totalMatched, count: matches.length, filesSearched: 0, external: true },
    };
  }

  const indexer = FileIndexer.getInstance(cwd);
  const frecency = FrecencyTracker.getInstance();

  const { matches, totalMatched, filesSearched } = await indexer.grep(singlePattern, {
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
    nextCursor = cursorStore.store("grep", singlePattern, offset + matches.length, params);
  }

  const output = formatGrepOutput(matches, totalMatched, nextCursor);
  return {
    output,
    details: { totalMatched, count: matches.length, filesSearched },
  };
}

export const findToolSchema = Type.Object({
  pattern: Type.Optional(Type.String({ description: "Fuzzy search query for file paths (supports !exclude, *.ext, git:modified)" })),
  path: Type.Optional(Type.String({ description: "Directory constraint or subpath" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of files to return (default: 30)" })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for fetching the next page" })),
});

export const grepToolSchema = Type.Object({
  pattern: Type.Optional(
    Type.String({ description: "Search pattern (literal text or regex). For multiple terms, you can also use 'patterns'." })
  ),
  patterns: Type.Optional(
    Type.Array(Type.String({ description: "Search pattern (literal text)" }), {
      description: "Array of patterns to search simultaneously with OR logic in one single pass",
    })
  ),
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

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

export function createFindToolDefinition(name = "find"): ToolDefinition<typeof findToolSchema> {
  return {
    name,
    label: name,
    description:
      "Fast, frecency-ranked, typo-tolerant file finder (replaces find, fd, ls -R). Automatically prioritizes modified/staged git files and files you work on most. Supports constraints like 'git:modified', '*.ts', '!test/'.",
    parameters: findToolSchema,
    promptGuidelines: [
      `Use ${name} to locate files by fuzzy name or path instead of running bash (find, ls, locate, fd). Supports constraints like 'git:modified', '*.ts', '!test/'. Automatically ranks active and recently edited files highest.`,
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isScoutActive()) {
        return {
          content: [{ type: "text", text: "Scout search tools are currently disabled for this session ('scout.enabled': false). Please use shell commands (find/grep/ls) instead." }],
          details: undefined,
          isError: true,
        };
      }
      const cwd = ctx?.cwd || process.cwd();
      const res = await executeFind(params, cwd);
      return {
        content: [{ type: "text", text: res.output }],
        details: res.details,
      };
    },
    renderCall(args, theme, context) {
      const rawPattern = args?.pattern?.trim();
      const patternText = rawPattern || "*";
      const rawPath = args?.path?.trim();

      let text = theme.fg("toolTitle", theme.bold(name)) + " " + theme.fg("accent", patternText);
      if (rawPath) {
        text += theme.fg("toolOutput", ` in ${shortenPath(rawPath)}`);
      }
      if (args?.limit !== undefined) {
        text += theme.fg("toolOutput", ` (limit ${args.limit})`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
  };
}

export function createGrepToolDefinition(name = "grep"): ToolDefinition<typeof grepToolSchema> {
  return {
    name,
    label: name,
    description:
      "Fast in-memory content search (replaces rg, ripgrep, ag, grep). Supports single pattern or multiple patterns with OR logic ('patterns: [...]'). Definition-first prioritization, smart case, and typo fallback. Compresses matching lines to save LLM tokens. Surfaces definitions before usages.",
    parameters: grepToolSchema,
    promptGuidelines: [
      `Use ${name} to search code contents instead of running bash (rg, ripgrep, grep, ag). Accepts single 'pattern' or multiple 'patterns' (searched simultaneously with OR logic in one single pass). Returns compressed, definition-first results to minimize context size. Tolerates typos and automatically matches case.`,
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isScoutActive()) {
        return {
          content: [{ type: "text", text: "Scout search tools are currently disabled for this session ('scout.enabled': false). Please use shell commands (find/grep/ls) instead." }],
          details: undefined,
          isError: true,
        };
      }
      const cwd = ctx?.cwd || process.cwd();
      const res = await executeGrep(params, cwd);
      return {
        content: [{ type: "text", text: res.output }],
        details: res.details,
      };
    },
    renderCall(args, theme, context) {
      const patterns = Array.isArray(args?.patterns) ? args.patterns.filter(Boolean) : [];
      const pattern = args?.pattern?.trim();
      let patternSummary = "";
      if (patterns.length > 0) {
        if (pattern && !patterns.includes(pattern)) {
          patterns.unshift(pattern);
        }
        patternSummary =
          patterns.slice(0, 3).map((p: string) => `/${p}/`).join(" | ") +
          (patterns.length > 3 ? ` (+${patterns.length - 3} more)` : "");
      } else if (pattern) {
        patternSummary = `/${pattern}/`;
      } else {
        patternSummary = `//`;
      }

      const rawPath = args?.path?.trim();
      let text = theme.fg("toolTitle", theme.bold(name)) + " " + theme.fg("accent", patternSummary);
      if (rawPath) {
        text += theme.fg("toolOutput", ` in ${shortenPath(rawPath)}`);
      }
      if (args?.glob) {
        text += theme.fg("toolOutput", ` (${args.glob})`);
      }
      if (args?.limit !== undefined) {
        text += theme.fg("toolOutput", ` limit ${args.limit}`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
  };
}

export function createMultiGrepToolDefinition(name = "multi_grep"): ToolDefinition<typeof multiGrepToolSchema> {
  return {
    name,
    label: name,
    description:
      "Search multiple patterns simultaneously with OR logic in one single pass (delegates to grep).",
    parameters: multiGrepToolSchema,
    promptGuidelines: [
      `Use ${name} when searching for multiple keywords or identifiers simultaneously.`,
    ],
    renderCall(args, theme, context) {
      const patterns = Array.isArray(args?.patterns) ? args.patterns : [];
      const summary =
        patterns.slice(0, 3).map((p: string) => `/${p}/`).join(" | ") +
        (patterns.length > 3 ? ` (+${patterns.length - 3} more)` : "");
      const rawPath = args?.path?.trim();
      let text = theme.fg("toolTitle", theme.bold(name)) + " " + theme.fg("accent", summary || `//`);
      if (rawPath) {
        text += theme.fg("toolOutput", ` in ${shortenPath(rawPath)}`);
      }
      if (args?.glob) {
        text += theme.fg("toolOutput", ` (${args.glob})`);
      }
      if (args?.limit !== undefined) {
        text += theme.fg("toolOutput", ` limit ${args.limit}`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isScoutActive()) {
        return {
          content: [{ type: "text", text: "Scout search tools are currently disabled for this session ('scout.enabled': false). Please use shell commands (find/grep/ls) instead." }],
          details: undefined,
          isError: true,
        };
      }
      const cwd = ctx?.cwd || process.cwd();
      const res = await executeGrep(params, cwd);
      return {
        content: [{ type: "text", text: res.output }],
        details: res.details,
      };
    },
  };
}
