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
      excludePaths.push(token.slice(1).replace(/\\/g, "/"));
      continue;
    }

    if (token.startsWith("*.") && token.length > 2) {
      extensions.push(token.slice(1).toLowerCase()); // e.g. ".ts"
      continue;
    }

    if (token.includes("/") && (token.endsWith("/") || token.includes("*"))) {
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
    gitFilter,
  };
}

/**
 * Checks if a relative file path matches the parsed constraints
 */
export function matchesConstraints(
  filePath: string,
  constraints: SearchQueryConstraints,
  gitStatus?: GitFileStatus
): boolean {
  const normPath = filePath.replace(/\\/g, "/");

  // Check git status constraint
  if (constraints.gitFilter) {
    if (gitStatus !== constraints.gitFilter) {
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
      if (normPath.includes(excl) || normPath.startsWith(excl)) {
        return false;
      }
    }
  }

  // Check include paths
  if (constraints.includePaths && constraints.includePaths.length > 0) {
    const matchesInclude = constraints.includePaths.some((inc) => {
      const cleanInc = inc.endsWith("/") ? inc.slice(0, -1) : inc;
      if (!cleanInc || cleanInc === ".") return true;
      return (
        normPath === cleanInc ||
        normPath.startsWith(`${cleanInc}/`) ||
        normPath.includes(`/${cleanInc}/`) ||
        normPath.endsWith(`/${cleanInc}`) ||
        normPath.includes(inc)
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
