import type { GitFileStatus, SearchQueryConstraints } from "./types.js";

/**
 * Parses user query into search constraints and core text pattern.
 * e.g. "git:modified *.ts !test/ authService" ->
 * {
 *   pattern: "authService",
 *   gitFilter: "modified",
 *   extensions: [".ts"],
 *   excludePaths: ["test/"]
 * }
 */
export function parseQueryConstraints(query: string): SearchQueryConstraints {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const patternParts: string[] = [];
  const extensions: string[] = [];
  const includePaths: string[] = [];
  const excludePaths: string[] = [];
  const globs: string[] = [];
  let gitFilter: GitFileStatus | undefined;

  for (const token of tokens) {
    if (token.startsWith("git:")) {
      const status = token.slice(4).toLowerCase();
      if (status === "modified" || status === "staged" || status === "untracked" || status === "deleted") {
        gitFilter = status as GitFileStatus;
        continue;
      }
    }

    if (token.startsWith("!") && token.length > 1) {
      if (token.includes("*")) {
        globs.push(token);
      } else {
        excludePaths.push(token.slice(1).replace(/\\/g, "/"));
      }
      continue;
    }

    // Brace expansion or wildcard glob e.g. *.{ts,tsx} or **/*.json
    if (token.startsWith("*.") && token.includes("{")) {
      globs.push(token);
      continue;
    }

    if (token.startsWith("*.") && token.length > 2) {
      extensions.push(token.slice(1).toLowerCase()); // e.g. ".ts"
      continue;
    }

    if (token.includes("*")) {
      globs.push(token);
      continue;
    }

    // Path constraints: any token with a slash
    if (token.includes("/")) {
      includePaths.push(token.replace(/\\/g, "/"));
      continue;
    }

    patternParts.push(token);
  }

  return {
    pattern: patternParts.join(" "),
    extensions: extensions.length > 0 ? extensions : undefined,
    includePaths: includePaths.length > 0 ? includePaths : undefined,
    excludePaths: excludePaths.length > 0 ? excludePaths : undefined,
    globs: globs.length > 0 ? globs : undefined,
    gitFilter,
  };
}

/**
 * Checks if a relative file path matches a glob pattern (e.g. *.ts, *.{ts,tsx}, src/** /*.ts, !*.test.ts)
 */
export function globMatches(filePath: string, glob: string): boolean {
  if (!glob) return true;
  const isNegative = glob.startsWith("!");
  const pattern = isNegative ? glob.slice(1) : glob;
  const normPath = filePath.replace(/\\/g, "/");

  // Simple extension check: *.ext
  if (/^\*\.[a-zA-Z0-9_-]+$/.test(pattern)) {
    const ext = pattern.slice(1).toLowerCase();
    const matches = normPath.toLowerCase().endsWith(ext);
    return isNegative ? !matches : matches;
  }

  // Brace expansion: *.{ts,tsx,js}
  const braceMatch = pattern.match(/^\*\.\{([a-zA-Z0-9_,-]+)\}$/);
  if (braceMatch) {
    const exts = braceMatch[1].split(",").map((e) => `.${e.trim().toLowerCase()}`);
    const matches = exts.some((ext) => normPath.toLowerCase().endsWith(ext));
    return isNegative ? !matches : matches;
  }

  // Convert glob to RegExp
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (c === "{" && pattern.includes("}", i)) {
      const closeIdx = pattern.indexOf("}", i);
      const parts = pattern.slice(i + 1, closeIdx).split(",");
      regexStr += "(" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = closeIdx + 1;
    } else if (/[.+^$()[\]|\\]/.test(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  try {
    const regex = new RegExp(`(^|/)${regexStr}$`, "i");
    const matches = regex.test(normPath);
    return isNegative ? !matches : matches;
  } catch {
    return true;
  }
}

/**
 * Checks if a relative file path matches the parsed constraints
 */
export function matchesConstraints(
  filePath: string,
  constraints: SearchQueryConstraints,
  gitStatus?: GitFileStatus
): boolean {
  let normPath = filePath.replace(/\\/g, "/");
  if (normPath.startsWith("./")) {
    normPath = normPath.slice(2);
  }

  // Check git status constraint
  if (constraints.gitFilter) {
    if (!gitStatus || gitStatus !== constraints.gitFilter) {
      return false;
    }
  }

  // Check extension constraint
  if (constraints.extensions && constraints.extensions.length > 0) {
    const hasExt = constraints.extensions.some((ext) => normPath.toLowerCase().endsWith(ext));
    if (!hasExt) return false;
  }

  // Check exclusion paths
  if (constraints.excludePaths && constraints.excludePaths.length > 0) {
    for (const excl of constraints.excludePaths) {
      const cleanExcl = excl.startsWith("./") ? excl.slice(2) : excl;
      if (normPath.includes(cleanExcl) || normPath.startsWith(cleanExcl)) {
        return false;
      }
    }
  }

  // Check glob constraints
  if (constraints.globs && constraints.globs.length > 0) {
    for (const g of constraints.globs) {
      if (!globMatches(normPath, g)) {
        return false;
      }
    }
  }

  // Check include paths
  if (constraints.includePaths && constraints.includePaths.length > 0) {
    const matchesInclude = constraints.includePaths.some((inc) => {
      let cleanInc = inc.endsWith("/") ? inc.slice(0, -1) : inc;
      if (cleanInc.startsWith("./")) cleanInc = cleanInc.slice(2);
      if (!cleanInc || cleanInc === ".") return true;
      return (
        normPath === cleanInc ||
        normPath.startsWith(`${cleanInc}/`) ||
        normPath.includes(`/${cleanInc}/`) ||
        normPath.endsWith(`/${cleanInc}`) ||
        normPath.includes(cleanInc)
      );
    });
    if (!matchesInclude) return false;
  }

  return true;
}

export interface FuzzyScoreResult {
  score: number;
  matchRanges: Array<[number, number]>;
}

/**
 * Typo-tolerant, boundary-aware fuzzy matching algorithm for paths and symbols.
 * Based on modified Smith-Waterman / FZY scoring with typo tolerance.
 */
export function fuzzyMatch(pattern: string, target: string): FuzzyScoreResult | null {
  if (!pattern) {
    return { score: 0, matchRanges: [] };
  }

  const pLower = pattern.toLowerCase();
  const tLower = target.toLowerCase();

  // Fast exact substring match check for maximum score boost
  const subIdx = tLower.indexOf(pLower);
  if (subIdx !== -1) {
    let exactScore = 150 + pattern.length * 10;
    // Word boundary bonus
    if (subIdx === 0 || "/\\_- .".includes(target[subIdx - 1])) {
      exactScore += 50;
    }
    return {
      score: exactScore,
      matchRanges: [[subIdx, subIdx + pattern.length]],
    };
  }

  // Character-by-character fuzzy match with typo tolerance
  let pIdx = 0;
  let tIdx = 0;
  let score = 0;
  let consecutive = 0;
  const matchPositions: number[] = [];
  let allowedTypos = pattern.length >= 6 ? 2 : pattern.length >= 4 ? 1 : 0;
  let typoCount = 0;

  while (pIdx < pattern.length && tIdx < target.length) {
    const pChar = pLower[pIdx];
    const tChar = tLower[tIdx];

    if (pChar === tChar) {
      matchPositions.push(tIdx);
      consecutive += 1;
      score += 15 + consecutive * 5;

      // Bonus for match at start of word, camelCase, or separator
      if (tIdx === 0) {
        score += 30;
      } else {
        const prevChar = target[tIdx - 1];
        if (prevChar === "/" || prevChar === "\\" || prevChar === "_" || prevChar === "-" || prevChar === ".") {
          score += 25;
        } else if (prevChar >= "a" && prevChar <= "z" && target[tIdx] >= "A" && target[tIdx] <= "Z") {
          score += 20; // camelCase
        }
      }

      pIdx++;
      tIdx++;
    } else {
      // Check transposition (e.g. "shcema" vs "schema")
      if (
        allowedTypos > 0 &&
        pIdx + 1 < pattern.length &&
        tIdx + 1 < target.length &&
        pLower[pIdx + 1] === tChar &&
        pLower[pIdx] === tLower[tIdx + 1]
      ) {
        matchPositions.push(tIdx);
        matchPositions.push(tIdx + 1);
        score += 10;
        pIdx += 2;
        tIdx += 2;
        typoCount++;
        allowedTypos--;
        consecutive = 0;
        continue;
      }

      // Check single dropped character / substitution typo if at least 2 chars already matched
      if (allowedTypos > 0 && pIdx > 1 && pIdx + 1 < pattern.length && pLower[pIdx + 1] === tChar) {
        // pattern had an extra character or typo
        pIdx++;
        typoCount++;
        allowedTypos--;
        continue;
      }

      consecutive = 0;
      score -= 1; // Slight gap penalty
      tIdx++;
    }
  }

  // Must match all or almost all pattern characters
  const matchedChars = pIdx;
  if (matchedChars < pattern.length - typoCount) {
    return null;
  }

  // Weak match detection: if match ratio is very low, treat as noise
  if (score < 10) {
    return null;
  }

  // Group matched positions into ranges
  const matchRanges: Array<[number, number]> = [];
  if (matchPositions.length > 0) {
    let start = matchPositions[0];
    let prev = start;
    for (let i = 1; i < matchPositions.length; i++) {
      const cur = matchPositions[i];
      if (cur === prev + 1) {
        prev = cur;
      } else {
        matchRanges.push([start, prev + 1]);
        start = cur;
        prev = cur;
      }
    }
    matchRanges.push([start, prev + 1]);
  }

  return { score, matchRanges };
}
