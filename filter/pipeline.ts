import { filterGitCommand } from "./parsers/git.js";
import { filterLintCommand } from "./parsers/lint.js";
import { filterSystemCommand } from "./parsers/system.js";
import { filterTestCommand } from "./parsers/test.js";
import { DECLARATIVE_RULES } from "./rules.js";
import {
  collapseConsecutiveDuplicates,
  collapseEmptyLines,
  preCleanOutput,
} from "./sanitizer.js";
import type { DeclarativeRule, FilterResult } from "./types.js";

/**
 * Runs the complete output-reduction pipeline on a command's raw output.
 */
export function runFilterPipeline(
  command: string,
  rawOutput: string,
  isError: boolean
): FilterResult | null {
  const originalBytes = Buffer.byteLength(rawOutput, "utf8");
  if (originalBytes < 40) {
    return null;
  }

  // Phase 1: Pre-clean ANSI codes and carriage returns
  const cleaned = preCleanOutput(rawOutput);

  let filteredText: string | null = null;
  let filterName = "generic";

  // Phase 2: Specialized ecosystem parsers
  filteredText = filterGitCommand(command, cleaned, isError);
  if (filteredText !== null) {
    filterName = "git";
  }

  if (filteredText === null) {
    filteredText = filterTestCommand(command, cleaned, isError);
    if (filteredText !== null) {
      filterName = "test";
    }
  }

  if (filteredText === null) {
    filteredText = filterLintCommand(command, cleaned, isError);
    if (filteredText !== null) {
      filterName = "lint";
    }
  }

  if (filteredText === null) {
    filteredText = filterSystemCommand(command, cleaned, isError);
    if (filteredText !== null) {
      filterName = "system";
    }
  }

  // Phase 3: Declarative rules table
  if (filteredText === null) {
    for (const rule of DECLARATIVE_RULES) {
      if (rule.matchCommand.test(command)) {
        filteredText = applyDeclarativeRule(rule, cleaned);
        filterName = rule.name;
        break;
      }
    }
  }

  // Phase 4: Fallback generic deduplication
  if (filteredText === null) {
    const lines = cleaned.split("\n");
    const deduped = collapseConsecutiveDuplicates(lines);
    const compacted = collapseEmptyLines(deduped);
    if (compacted.length < lines.length) {
      filteredText = compacted.join("\n");
      filterName = "dedup";
    }
  }

  if (filteredText === null) {
    return null;
  }

  const filteredBytes = Buffer.byteLength(filteredText, "utf8");
  const savedBytes = originalBytes - filteredBytes;

  // Only commit filtering if at least 30 bytes or 20% was saved
  const savingsRatio = savedBytes / originalBytes;
  if (savedBytes < 30 && savingsRatio < 0.2) {
    return null;
  }

  return {
    text: filteredText,
    originalBytes,
    filteredBytes,
    savedBytes,
    filterName,
  };
}

function applyDeclarativeRule(rule: DeclarativeRule, text: string): string {
  let lines = text.split("\n");

  if (rule.stripLinesMatching) {
    lines = lines.filter((line) => {
      return !rule.stripLinesMatching!.some((regex) => regex.test(line));
    });
  }

  if (rule.keepLinesMatching) {
    lines = lines.filter((line) => {
      return rule.keepLinesMatching!.some((regex) => regex.test(line));
    });
  }

  if (rule.maxLines && lines.length > rule.maxLines) {
    const head = lines.slice(0, rule.maxLines);
    head.push(`... and ${lines.length - rule.maxLines} more lines`);
    lines = head;
  }

  const result = lines.join("\n").trim();
  if (result.length === 0 && rule.onEmpty) {
    return rule.onEmpty;
  }

  return result;
}
