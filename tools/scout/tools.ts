import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { parseQueryConstraints } from "./matcher.js";
import { isScoutActive } from "./register.js";
import type { FindResultItem } from "./types.js";

const PAGE_SIZE_FIND = 30;
const PAGE_SIZE_GREP = 35;
const MAX_DIRECTORY_DEPTH = 15;
let loadedIndexer: typeof import("./indexer.js") | undefined;
let indexerPromise: Promise<typeof import("./indexer.js")> | undefined;
let indexerGeneration = 0;
// Jiti can expose incomplete exports to overlapping imports. Share every
// first-use module load between find/grep, not just the indexer import.
let scoutModulesPromise: Promise<[
  typeof import("./cursor.js"),
  typeof import("./external.js"),
  typeof import("./formatter.js"),
  typeof import("./frecency.js"),
]> | undefined;

function loadScoutModules() {
  return scoutModulesPromise ??= Promise.all([
    import("./cursor.js"), import("./external.js"), import("./formatter.js"), import("./frecency.js"),
  ]).catch((error) => {
    scoutModulesPromise = undefined;
    throw error;
  });
}

export async function loadFileIndexer(): Promise<typeof import("./indexer.js")> {
  const generation = indexerGeneration;
  const loaded = await (indexerPromise ??= import("./indexer.js").catch((error) => {
    indexerPromise = undefined;
    throw error;
  }));
  if (generation !== indexerGeneration) throw new Error("Scout session ended while loading its index");
  loadedIndexer = loaded;
  return loaded;
}

export function disposeScoutIndex(): void {
  indexerGeneration++;
  // Keep module promises: restarting an in-flight import would recreate the
  // race. Each loadFileIndexer caller checks its own session generation.
  loadedIndexer?.FileIndexer.disposeIfInitialized();
}

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

type FindParams = Static<typeof findToolSchema>;

function findPatterns(params: Pick<FindParams, "pattern" | "patterns">): string[] {
  const candidates = Array.isArray(params.patterns) ? [params.pattern, ...params.patterns] : [params.pattern];
  const patterns = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) patterns.add(candidate.trim());
  }
  return [...patterns];
}

export async function executeFind(params: FindParams, cwd: string): Promise<{ output: string; details: any }> {
  const [{ CursorStore }, { externalFind, findDirectories, resolveTargetPath }, { formatFindOutput }, { FrecencyTracker }] =
    await loadScoutModules();
  const cursorStore = CursorStore.getInstance();
  const stored = params.cursor ? cursorStore.get(params.cursor) : undefined;
  const previous = stored?.type === "find" ? stored : undefined;
  const search = previous ? previous.options as FindParams : params;
  const patterns = findPatterns(search);
  const queries = (patterns.length ? patterns : [""]).map(parseQueryConstraints);
  const type = search.type ?? "file";
  const depth = search.depth ?? 1;
  const targetPath = search.path?.trim() ? resolveTargetPath(search.path, cwd) : undefined;
  const limit = params.limit ?? search.limit ?? PAGE_SIZE_FIND;
  const offset = previous?.nextOffset ?? 0;
  const options = { path: targetPath, limit, offset };

  let items: FindResultItem[];
  let totalMatched: number;
  const external = shouldDelegateToExternal(targetPath, cwd);
  if (type === "directory") {
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DIRECTORY_DEPTH) {
      throw new Error(`Directory search depth must be an integer from 1 to ${MAX_DIRECTORY_DEPTH}.`);
    }
    if (queries.some((query) => query.gitFilter)) {
      throw new Error("Git status filters apply to file searches, not directory searches.");
    }
    ({ items, totalMatched } = await findDirectories(queries, { ...options, depth }, cwd));
  } else if (external) {
    ({ items, totalMatched } = await externalFind(queries, options, cwd));
  } else {
    const { FileIndexer } = await loadFileIndexer();
    const frecency = FrecencyTracker.getInstance();
    const result = await FileIndexer.getInstance(cwd).findFiles(queries, options);
    totalMatched = result.totalMatched;
    // Record access for the top 3 matched files in frecency memory.
    for (const file of result.files.slice(0, 3)) frecency.recordAccess(file.relativePath);
    items = result.files.map((file) => ({
      relativePath: file.relativePath,
      gitStatus: file.gitStatus,
      frecencyTag: frecency.getFrecencyTag(file.frecencyScore),
      score: file.frecencyScore,
    }));
  }

  const nextCursor = items.length && offset + items.length < totalMatched
    ? cursorStore.store("find", patterns.join(" | "), offset + items.length, { patterns, type, depth, path: targetPath, limit })
    : undefined;
  return {
    output: formatFindOutput(items, totalMatched, nextCursor, type),
    details: { totalMatched, count: items.length, ...(external ? { external: true } : {}) },
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
  const [modules, { FileIndexer }] = await Promise.all([loadScoutModules(), loadFileIndexer()]);
  const [{ CursorStore }, { externalGrep, externalMultiGrep }, { formatGrepOutput }, { FrecencyTracker }] = modules;
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
  pattern: Type.Optional(Type.String({ description: "One fuzzy path query; use patterns for alternatives. Supports !exclude, *.ext, and file-only git:modified." })),
  patterns: Type.Optional(Type.Array(Type.String(), {
    description: "Fuzzy path queries matched with OR logic in one pass. Each query can have its own constraints; a path is returned once.",
  })),
  path: Type.Optional(Type.String({ description: "Directory or subpath to search (supports ~)" })),
  type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory")], {
    description: "Return files (default) or directories. Omit pattern(s) to list entries of the chosen type.",
  })),
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIRECTORY_DEPTH, description: "Directory mode only: max depth below path (default: 1, direct children only)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 30)" })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for fetching the next page of the same search" })),
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
      "Fuzzy path finder for files or directories. File results prioritize recently used and changed files. Use patterns for OR matching or type: 'directory' to find project folders without scanning files.",
    parameters: findToolSchema,
    promptGuidelines: [
      `Use ${name} instead of shell searches. Use type: 'directory' (default depth 1) to list folders, and patterns: [...] to match any of several fuzzy path queries. File searches support constraints like 'git:modified', '*.ts', '!test/'.`,
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
      const patternText = args ? findPatterns(args).join(" | ") || "*" : "*";
      const rawPath = args?.path?.trim();

      let text = theme.fg("toolTitle", theme.bold(name)) + " " + theme.fg("accent", patternText);
      if (rawPath) {
        text += theme.fg("toolOutput", ` in ${shortenPath(rawPath)}`);
      }
      if (args?.type === "directory") {
        text += theme.fg("toolOutput", ` (directories, depth ${args.depth ?? 1})`);
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
