import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { classifyLine } from "./classifier.js";
import { fuzzyMatch, matchesConstraints, parseQueryConstraints } from "./matcher.js";
import type { FindResultItem, SearchMatch } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Expand leading ~ or relative path against working directory
 */
export function resolveTargetPath(rawPath: string, cwd: string): string {
  let p = rawPath.trim();
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
  } else if (!path.isAbsolute(p)) {
    p = path.resolve(cwd, p);
  }
  return p;
}

/**
 * Clean path for display: use ~/ if within home, or relative to cwd if within cwd
 */
export function formatDisplayPath(absPath: string, cwd: string): string {
  const home = os.homedir();
  const normalizedAbs = absPath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/");
  const normalizedHome = home.replace(/\\/g, "/");

  if (normalizedAbs === normalizedCwd) {
    return ".";
  }
  if (normalizedAbs.startsWith(normalizedCwd + "/")) {
    return path.relative(cwd, absPath).replace(/\\/g, "/");
  }
  if (normalizedAbs === normalizedHome) {
    return "~";
  }
  if (normalizedAbs.startsWith(normalizedHome + "/")) {
    return "~/" + path.relative(home, absPath).replace(/\\/g, "/");
  }
  return normalizedAbs;
}

interface RawLineItem {
  type: "match" | "context";
  filePath: string;
  lineNumber: number;
  content: string;
}

function parseRawGrepOutput(rawOutput: string, cwd: string): RawLineItem[] {
  const lines = rawOutput.split(/\r?\n/);
  const items: RawLineItem[] = [];

  for (const line of lines) {
    if (!line || line === "--") continue;

    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (match) {
      const lineNum = parseInt(match[2], 10);
      if (!isNaN(lineNum)) {
        items.push({
          type: "match",
          filePath: formatDisplayPath(match[1], cwd),
          lineNumber: lineNum,
          content: match[3],
        });
        continue;
      }
    }

    const ctxMatch = line.match(/^(.*?)-(\d+)-(.*)$/);
    if (ctxMatch) {
      const lineNum = parseInt(ctxMatch[2], 10);
      if (!isNaN(lineNum)) {
        items.push({
          type: "context",
          filePath: formatDisplayPath(ctxMatch[1], cwd),
          lineNumber: lineNum,
          content: ctxMatch[3],
        });
      }
    }
  }

  return items;
}

export interface ExternalGrepOptions {
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
}

/**
 * Execute ripgrep (or fallback to grep) on an external or unindexed directory
 * and return parsed SearchMatch items formatted for the FFF pipeline.
 */
export async function externalGrep(
  pattern: string,
  options: ExternalGrepOptions,
  cwd: string
): Promise<{ matches: SearchMatch[]; totalMatched: number }> {
  const targetDir = resolveTargetPath(options.path || cwd, cwd);
  const limit = options.limit ?? 40;
  const offset = options.offset ?? 0;
  const contextLines = options.context ?? 0;

  // Build ripgrep arguments
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--no-ignore",
    "--hidden",
    "-g", "!.git/*",
    "-H",
    "--max-columns=500",
    "--max-columns-preview",
  ];

  if (options.ignoreCase === true) {
    rgArgs.push("-i");
  } else if (options.ignoreCase === false) {
    rgArgs.push("-s");
  } else {
    rgArgs.push("-S");
  }

  if (options.literal) {
    rgArgs.push("-F");
  }

  if (options.glob) {
    rgArgs.push("-g", options.glob);
  }

  if (contextLines > 0) {
    rgArgs.push("-C", String(Math.min(5, contextLines)));
  }

  rgArgs.push("-e", pattern, "--", targetDir);

  let rawOutput = "";
  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    rawOutput = stdout;
  } catch (err: any) {
    if (err && typeof err.stdout === "string" && err.stdout.length > 0) {
      rawOutput = err.stdout;
    } else if (err.code === 1) {
      return { matches: [], totalMatched: 0 };
    } else {
      // Fallback to standard grep if rg is missing or errored without stdout
      try {
        const grepArgs = ["-rn", "-H", "-I"];
        if (options.ignoreCase) grepArgs.push("-i");
        if (options.literal) grepArgs.push("-F");
        if (options.glob) {
          if (options.glob.startsWith("!")) {
            grepArgs.push(`--exclude=${options.glob.slice(1)}`);
          } else {
            grepArgs.push(`--include=${options.glob}`);
          }
        }
        if (contextLines > 0) {
          grepArgs.push("-C", String(Math.min(5, contextLines)));
        }
        grepArgs.push("-e", pattern, "--", targetDir);

        const { stdout } = await execFileAsync("grep", grepArgs, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
        });
        rawOutput = stdout;
      } catch (grepErr: any) {
        if (grepErr && typeof grepErr.stdout === "string" && grepErr.stdout.length > 0) {
          rawOutput = grepErr.stdout;
        } else {
          return { matches: [], totalMatched: 0 };
        }
      }
    }
  }

  const rawItems = parseRawGrepOutput(rawOutput, cwd);
  const allMatches: SearchMatch[] = [];

  let regex: RegExp | null = null;
  if (!options.literal) {
    try {
      regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
    } catch {}
  }

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (item.type !== "match") continue;

    // Collect context lines
    const contextBefore: string[] = [];
    const contextAfter: string[] = [];

    if (contextLines > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const prev = rawItems[j];
        if (prev.filePath !== item.filePath || prev.type !== "context") break;
        if (item.lineNumber - prev.lineNumber <= contextLines && item.lineNumber > prev.lineNumber) {
          contextBefore.unshift(prev.content);
        } else {
          break;
        }
      }
      for (let j = i + 1; j < rawItems.length; j++) {
        const next = rawItems[j];
        if (next.filePath !== item.filePath || next.type !== "context") break;
        if (next.lineNumber - item.lineNumber <= contextLines && next.lineNumber > item.lineNumber) {
          contextAfter.push(next.content);
        } else {
          break;
        }
      }
    }

    // Compute match start/end
    let matchStart = 0;
    let matchEnd = 0;

    if (regex) {
      const regMatch = regex.exec(item.content);
      if (regMatch) {
        matchStart = regMatch.index;
        matchEnd = regMatch.index + regMatch[0].length;
      }
    } else {
      const haystack = options.ignoreCase ? item.content.toLowerCase() : item.content;
      const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
      const idx = haystack.indexOf(needle);
      if (idx >= 0) {
        matchStart = idx;
        matchEnd = idx + pattern.length;
      }
    }

    const { isDefinition, isImport } = classifyLine(item.content);

    allMatches.push({
      filePath: item.filePath,
      lineNumber: item.lineNumber,
      lineContent: item.content,
      isDefinition,
      isImport,
      matchStart,
      matchEnd,
      contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
      contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
    });
  }

  // Sort definitions first, then usages, then imports
  allMatches.sort((a, b) => {
    if (a.isDefinition && !b.isDefinition) return -1;
    if (!a.isDefinition && b.isDefinition) return 1;
    if (a.isImport && !b.isImport) return 1;
    if (!a.isImport && b.isImport) return -1;
    return 0;
  });

  const totalMatched = allMatches.length;
  const paginated = allMatches.slice(offset, offset + limit);

  return { matches: paginated, totalMatched };
}

export interface ExternalMultiGrepOptions {
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
}

/**
 * Execute ripgrep on an external directory searching multiple patterns in one pass
 */
export async function externalMultiGrep(
  patterns: string[],
  options: ExternalMultiGrepOptions,
  cwd: string
): Promise<{ matches: SearchMatch[]; totalMatched: number }> {
  if (patterns.length === 0) {
    return { matches: [], totalMatched: 0 };
  }

  const targetDir = resolveTargetPath(options.path || cwd, cwd);
  const limit = options.limit ?? 40;
  const offset = options.offset ?? 0;
  const contextLines = options.context ?? 0;

  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--no-ignore",
    "--hidden",
    "-g", "!.git/*",
    "-H",
    "-F",
    "--max-columns=500",
    "--max-columns-preview",
  ];

  if (options.ignoreCase) {
    rgArgs.push("-i");
  } else {
    rgArgs.push("-S");
  }

  if (options.glob) {
    rgArgs.push("-g", options.glob);
  }

  if (contextLines > 0) {
    rgArgs.push("-C", String(Math.min(5, contextLines)));
  }

  for (const pat of patterns) {
    rgArgs.push("-e", pat);
  }

  rgArgs.push("--", targetDir);

  let rawOutput = "";
  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    rawOutput = stdout;
  } catch (err: any) {
    if (err && typeof err.stdout === "string" && err.stdout.length > 0) {
      rawOutput = err.stdout;
    } else if (err.code === 1) {
      return { matches: [], totalMatched: 0 };
    } else {
      // Fallback to grep
      try {
        const grepArgs = ["-rn", "-H", "-I", "-F"];
        if (options.ignoreCase) grepArgs.push("-i");
        if (options.glob) {
          if (options.glob.startsWith("!")) {
            grepArgs.push(`--exclude=${options.glob.slice(1)}`);
          } else {
            grepArgs.push(`--include=${options.glob}`);
          }
        }
        if (contextLines > 0) {
          grepArgs.push("-C", String(Math.min(5, contextLines)));
        }
        for (const pat of patterns) {
          grepArgs.push("-e", pat);
        }
        grepArgs.push("--", targetDir);

        const { stdout } = await execFileAsync("grep", grepArgs, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
        });
        rawOutput = stdout;
      } catch (grepErr: any) {
        if (grepErr && typeof grepErr.stdout === "string" && grepErr.stdout.length > 0) {
          rawOutput = grepErr.stdout;
        } else {
          return { matches: [], totalMatched: 0 };
        }
      }
    }
  }

  const rawItems = parseRawGrepOutput(rawOutput, cwd);
  const allMatches: SearchMatch[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (item.type !== "match") continue;

    const contextBefore: string[] = [];
    const contextAfter: string[] = [];

    if (contextLines > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const prev = rawItems[j];
        if (prev.filePath !== item.filePath || prev.type !== "context") break;
        if (item.lineNumber - prev.lineNumber <= contextLines && item.lineNumber > prev.lineNumber) {
          contextBefore.unshift(prev.content);
        } else {
          break;
        }
      }
      for (let j = i + 1; j < rawItems.length; j++) {
        const next = rawItems[j];
        if (next.filePath !== item.filePath || next.type !== "context") break;
        if (next.lineNumber - item.lineNumber <= contextLines && next.lineNumber > item.lineNumber) {
          contextAfter.push(next.content);
        } else {
          break;
        }
      }
    }

    // Identify which pattern matched
    const haystack = options.ignoreCase ? item.content.toLowerCase() : item.content;
    let matchedPattern: string | undefined;
    let matchStart = 0;
    let matchEnd = 0;

    for (const pat of patterns) {
      const needle = options.ignoreCase ? pat.toLowerCase() : pat;
      const idx = haystack.indexOf(needle);
      if (idx >= 0) {
        matchedPattern = pat;
        matchStart = idx;
        matchEnd = idx + pat.length;
        break;
      }
    }

    const { isDefinition, isImport } = classifyLine(item.content);

    allMatches.push({
      filePath: item.filePath,
      lineNumber: item.lineNumber,
      lineContent: item.content,
      isDefinition,
      isImport,
      matchStart,
      matchEnd,
      pattern: matchedPattern,
      contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
      contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
    });
  }

  allMatches.sort((a, b) => {
    if (a.isDefinition && !b.isDefinition) return -1;
    if (!a.isDefinition && b.isDefinition) return 1;
    if (a.isImport && !b.isImport) return 1;
    if (!a.isImport && b.isImport) return -1;
    return 0;
  });

  const totalMatched = allMatches.length;
  const paginated = allMatches.slice(offset, offset + limit);

  return { matches: paginated, totalMatched };
}

export interface ExternalFindOptions {
  path?: string;
  limit?: number;
  offset?: number;
}

/**
 * Execute ripgrep --files (or find) on an external directory, ranked with FFF fuzzy matcher
 */
export async function externalFind(
  query: string,
  options: ExternalFindOptions,
  cwd: string
): Promise<{ items: FindResultItem[]; totalMatched: number }> {
  const targetDir = resolveTargetPath(options.path || cwd, cwd);
  const limit = options.limit ?? 30;
  const offset = options.offset ?? 0;

  let rawOutput = "";
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files", "--no-ignore", "--hidden", "-g", "!.git/*", "--max-depth=15", targetDir],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000,
      }
    );
    rawOutput = stdout;
  } catch {
    try {
      const { stdout } = await execFileAsync(
        "find",
        [targetDir, "-maxdepth", "15", "-not", "(", "-path", "*/.git/*", "-prune", ")", "-type", "f"],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
        }
      );
      rawOutput = stdout;
    } catch {
      return { items: [], totalMatched: 0 };
    }
  }

  const rawFiles = rawOutput.split(/\r?\n/).filter(Boolean);
  const scored: Array<{ relativePath: string; score: number }> = [];

  const constraints = parseQueryConstraints(query);
  const pattern = constraints.pattern;

  for (const rawFile of rawFiles) {
    const displayPath = formatDisplayPath(rawFile, cwd);

    if (!matchesConstraints(displayPath, constraints)) {
      continue;
    }

    if (pattern) {
      const match = fuzzyMatch(pattern, displayPath);
      if (!match) continue;
      scored.push({ relativePath: displayPath, score: match.score });
    } else {
      scored.push({ relativePath: displayPath, score: 50 });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const totalMatched = scored.length;
  const paginated = scored.slice(offset, offset + limit).map((s) => ({
    relativePath: s.relativePath,
    score: s.score,
  }));

  return { items: paginated, totalMatched };
}
