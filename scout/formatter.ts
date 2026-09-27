import { FrecencyTracker } from "./frecency.js";
import type { FindResultItem, GitFileStatus, SearchMatch } from "./types.js";

const MAX_OUTPUT_CHARS = 3500;
const MAX_LINE_LENGTH = 160;

/**
 * Truncate a single line centered around the match range
 */
export function truncateLineAroundMatch(
  line: string,
  matchStart: number,
  matchEnd: number,
  maxLen = MAX_LINE_LENGTH
): string {
  const trimmed = line.trimEnd();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }

  const matchLen = Math.max(0, matchEnd - matchStart);
  const budget = Math.max(0, maxLen - matchLen);
  const beforeBudget = Math.floor(budget / 3);
  const afterBudget = budget - beforeBudget;

  const winStart = Math.max(0, matchStart - beforeBudget);
  const winEnd = Math.min(trimmed.length, matchEnd + afterBudget);

  let result = trimmed.slice(winStart, winEnd);
  if (winStart > 0) {
    result = "…" + result;
  }
  if (winEnd < trimmed.length) {
    result = result + "…";
  }

  return result;
}

/**
 * Format file suffix with frecency and git status (clean status is suppressed)
 */
export function formatFileSuffix(gitStatus?: GitFileStatus, frecencyTag?: string): string {
  const parts: string[] = [];
  if (frecencyTag) {
    parts.push(frecencyTag);
  }
  if (gitStatus && gitStatus !== "deleted") {
    parts.push(`git:${gitStatus}`);
  }
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

/**
 * Format find results into clean, token-efficient text for the model
 */
export function formatFindOutput(
  items: FindResultItem[],
  totalMatched: number,
  cursor?: string
): string {
  if (items.length === 0) {
    return "No matching files found.";
  }

  const lines: string[] = [];
  for (const item of items) {
    const suffix = formatFileSuffix(item.gitStatus, item.frecencyTag);
    lines.push(`${item.relativePath}${suffix}`);
  }

  let output = lines.join("\n");
  const notices: string[] = [];

  if (totalMatched > items.length) {
    notices.push(`Showing ${items.length} of ${totalMatched} files`);
  }
  if (cursor) {
    notices.push(`use cursor="${cursor}" for next page`);
  }

  if (notices.length > 0) {
    output += `\n\n[${notices.join(". ")}]`;
  }

  return output;
}

/**
 * Format grep / multiGrep results into compact, definition-first text
 */
export function formatGrepOutput(
  matches: SearchMatch[],
  totalMatched: number,
  cursor?: string
): string {
  if (matches.length === 0) {
    return "No matches found.";
  }

  const frecency = FrecencyTracker.getInstance();
  const lines: string[] = [];

  // Suggestion: if there is a primary definition found, suggest reading it
  const defMatch = matches.find((m) => m.isDefinition);
  if (defMatch) {
    lines.push(`→ Read ${defMatch.filePath} [def]`);
  } else if (matches.length > 0 && matches[0]) {
    lines.push(`→ Read ${matches[0].filePath} (best match)`);
  }

  // Group matches by file
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.filePath) || [];
    list.push(m);
    byFile.set(m.filePath, list);
  }

  let totalChars = lines.join("\n").length;
  let matchesShown = 0;
  let hitCharLimit = false;

  for (const [filePath, fileMatches] of byFile) {
    if (totalChars >= MAX_OUTPUT_CHARS) {
      hitCharLimit = true;
      break;
    }

    const fileHeader = `\n${filePath}:`;
    lines.push(fileHeader);
    totalChars += fileHeader.length;

    for (const m of fileMatches) {
      if (totalChars >= MAX_OUTPUT_CHARS) {
        hitCharLimit = true;
        break;
      }

      // Truncate line around match
      const truncated = truncateLineAroundMatch(m.lineContent, m.matchStart, m.matchEnd);
      const tag = m.isDefinition ? " [def]" : m.isImport ? " [import]" : "";
      const patTag = m.pattern ? ` (${m.pattern})` : "";
      const matchLine = `  ${m.lineNumber}: ${truncated}${tag}${patTag}`;

      lines.push(matchLine);
      totalChars += matchLine.length;
      matchesShown++;

      // Include context lines if present
      if (m.contextBefore && m.contextBefore.length > 0) {
        // Only if within character budget
        for (let c = 0; c < m.contextBefore.length; c++) {
          const cLine = `  - ${m.contextBefore[c].trim()}`;
          if (totalChars + cLine.length < MAX_OUTPUT_CHARS) {
            lines.push(cLine);
            totalChars += cLine.length;
          }
        }
      }
      if (m.contextAfter && m.contextAfter.length > 0) {
        for (let c = 0; c < m.contextAfter.length; c++) {
          const cLine = `  + ${m.contextAfter[c].trim()}`;
          if (totalChars + cLine.length < MAX_OUTPUT_CHARS) {
            lines.push(cLine);
            totalChars += cLine.length;
          }
        }
      }
    }
  }

  const notices: string[] = [];
  if (totalMatched > matchesShown || hitCharLimit) {
    notices.push(`${matchesShown}/${totalMatched} matches shown`);
  }
  if (cursor) {
    notices.push(`use cursor="${cursor}" for next page`);
  }

  let output = lines.join("\n");
  if (notices.length > 0) {
    output += `\n\n[${notices.join(". ")}]`;
  }

  return output.trim();
}
