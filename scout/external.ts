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
  if (absPath.startsWith(cwd + path.sep)) {
    return path.relative(cwd, absPath).replace(/\\/g, "/");
  }
  if (absPath.startsWith(home + path.sep)) {
    return "~/" + path.relative(home, absPath).replace(/\\/g, "/");
  }
  return absPath.replace(/\\/g, "/");
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

  // Build ripgrep arguments
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--no-ignore",
    "--max-columns=500",
    "--max-columns-preview",
  ];

  if (options.ignoreCase === true) {
    rgArgs.push("-i");
  } else if (options.ignoreCase === false) {
    rgArgs.push("-s");
  } else {
    // Smart case by default
    rgArgs.push("-S");
  }

  if (options.literal) {
    rgArgs.push("-F");
  }

  if (options.glob) {
    rgArgs.push("-g", options.glob);
  }

  if (options.context && options.context > 0) {
    rgArgs.push("-C", String(Math.min(5, options.context)));
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
    if (err.code === 1) {
      // Exit code 1 from ripgrep means 0 matches found
      return { matches: [], totalMatched: 0 };
    }
    // Fallback to standard grep if rg is missing or errored
    try {
      const grepArgs = ["-rn"];
      if (options.ignoreCase) grepArgs.push("-i");
      if (options.literal) grepArgs.push("-F");
      if (options.glob) grepArgs.push(`--include=${options.glob}`);
      grepArgs.push("-e", pattern, "--", targetDir);

      const { stdout } = await execFileAsync("grep", grepArgs, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000,
      });
      rawOutput = stdout;
    } catch (grepErr: any) {
      if (grepErr.code === 1) {
        return { matches: [], totalMatched: 0 };
      }
      return { matches: [], totalMatched: 0 };
    }
  }

  const lines = rawOutput.split(/\r?\n/);
  const allMatches: SearchMatch[] = [];

  for (const line of lines) {
    if (!line) continue;

    // Parse <path>:<line>:<content>
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;

    const rawFile = match[1];
    const lineNum = parseInt(match[2], 10);
    const lineContent = match[3];
    if (isNaN(lineNum)) continue;

    const displayFile = formatDisplayPath(rawFile, cwd);

    // Compute match start/end
    const lowerContent = lineContent.toLowerCase();
    const lowerPat = pattern.toLowerCase();
    const matchIdx = lowerContent.indexOf(lowerPat);
    const matchStart = matchIdx >= 0 ? matchIdx : 0;
    const matchEnd = matchIdx >= 0 ? matchIdx + pattern.length : 0;

    const { isDefinition, isImport } = classifyLine(lineContent);

    allMatches.push({
      filePath: displayFile,
      lineNumber: lineNum,
      lineContent,
      isDefinition,
      isImport,
      matchStart,
      matchEnd,
    });
  }

  // Sort definitions first, then usages, then imports (matching FFF ranking)
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

  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--no-ignore",
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
    if (err.code === 1) {
      return { matches: [], totalMatched: 0 };
    }
    return { matches: [], totalMatched: 0 };
  }

  const lines = rawOutput.split(/\r?\n/);
  const allMatches: SearchMatch[] = [];

  for (const line of lines) {
    if (!line) continue;

    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;

    const rawFile = match[1];
    const lineNum = parseInt(match[2], 10);
    const lineContent = match[3];
    if (isNaN(lineNum)) continue;

    const displayFile = formatDisplayPath(rawFile, cwd);

    // Identify which pattern matched
    const lowerContent = lineContent.toLowerCase();
    let matchedPattern: string | undefined;
    let matchStart = 0;
    let matchEnd = 0;

    for (const pat of patterns) {
      const idx = lowerContent.indexOf(pat.toLowerCase());
      if (idx >= 0) {
        matchedPattern = pat;
        matchStart = idx;
        matchEnd = idx + pat.length;
        break;
      }
    }

    const { isDefinition, isImport } = classifyLine(lineContent);

    allMatches.push({
      filePath: displayFile,
      lineNumber: lineNum,
      lineContent,
      isDefinition,
      isImport,
      matchStart,
      matchEnd,
      pattern: matchedPattern,
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
  const paginated = allMatches.slice(0, limit);

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
    const { stdout } = await execFileAsync("rg", ["--files", "--no-ignore", "--max-depth=6", targetDir], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    rawOutput = stdout;
  } catch {
    try {
      const { stdout } = await execFileAsync("find", [targetDir, "-maxdepth", "6", "-type", "f"], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000,
      });
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
