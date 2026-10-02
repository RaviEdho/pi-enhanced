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
import type { DeclarativeRule, FilterResult, ParserResult } from "./types.js";

/**
 * Normalizes parser output into a uniform text and lossy flag.
 */
function normalizeParserResult(res: ParserResult): { text: string; lossy: boolean } | null {
  if (res === null) return null;
  if (typeof res === "string") {
    return { text: res, lossy: false };
  }
  return { text: res.text, lossy: res.lossy ?? false };
}

/**
 * Runs the complete output-reduction pipeline on a command's raw output.
 */
export function runFilterPipeline(
  command: string,
  rawOutput: string,
  isError: boolean
): FilterResult | null {
  const originalBytes = Buffer.byteLength(rawOutput, "utf8");

  // Phase 1: Pre-clean ANSI codes and carriage returns
  const cleaned = preCleanOutput(rawOutput);

  let parsed: { text: string; lossy: boolean } | null = null;
  let filterName = "generic";

  // Phase 2: Specialized ecosystem parsers
  parsed = normalizeParserResult(filterGitCommand(command, cleaned, isError));
  if (parsed !== null) {
    filterName = "git";
  }

  if (parsed === null) {
    parsed = normalizeParserResult(filterTestCommand(command, cleaned, isError));
    if (parsed !== null) {
      filterName = "test";
    }
  }

  if (parsed === null) {
    parsed = normalizeParserResult(filterLintCommand(command, cleaned, isError));
    if (parsed !== null) {
      filterName = "lint";
    }
  }

  if (parsed === null) {
    parsed = normalizeParserResult(filterSystemCommand(command, cleaned, isError));
    if (parsed !== null) {
      filterName = "system";
    }
  }

  // Phase 3: Declarative rules table
  if (parsed === null) {
    for (const rule of DECLARATIVE_RULES) {
      if (rule.matchCommand.test(command)) {
        parsed = applyDeclarativeRule(rule, cleaned);
        filterName = rule.name;
        break;
      }
    }
  }

  // Phase 4: Fallback generic deduplication
  if (parsed === null) {
    const lines = cleaned.split("\n");
    const deduped = collapseConsecutiveDuplicates(lines);
    const compacted = collapseEmptyLines(deduped);
    if (compacted.length < lines.length) {
      parsed = { text: compacted.join("\n"), lossy: false };
      filterName = "dedup";
    }
  }

  // If no parser matched or the output was unchanged, pass through
  if (parsed === null || parsed.text === rawOutput) {
    return null;
  }

  const filteredText = parsed.text;
  const filteredBytes = Buffer.byteLength(filteredText, "utf8");
  const savedBytes = originalBytes - filteredBytes;

  return {
    text: filteredText,
    originalBytes,
    filteredBytes,
    savedBytes,
    filterName,
    lossy: parsed.lossy,
  };
}

function applyDeclarativeRule(rule: DeclarativeRule, text: string): { text: string; lossy: boolean } {
  let lines = text.split("\n");
  let lossy = false;

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
    lossy = true;
    const head = lines.slice(0, rule.maxLines);
    head.push(`... and ${lines.length - rule.maxLines} more lines`);
    lines = head;
  }

  const result = lines.join("\n").trim();
  if (result.length === 0 && rule.onEmpty) {
    return { text: rule.onEmpty, lossy };
  }

  return { text: result, lossy };
}
