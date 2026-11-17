import { getFilterCommand } from "./command.js";
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

export function formatRecallHint(id: string): string {
  return `\n[full output: /recall ${id}]`;
}

/** Runs output reduction; the delivered text including recall must never grow. */
export function runFilterPipeline(
  command: string,
  rawOutput: string,
  isError: boolean
): FilterResult | null {
  const originalBytes = Buffer.byteLength(rawOutput, "utf8");

  // Phase 1: Pre-clean ANSI codes and carriage returns
  const cleaned = preCleanOutput(rawOutput);
  const filterCommand = getFilterCommand(command);
  // Unknown, chained, piped, redirected, or script commands only get generic
  // cleanup: their combined output cannot safely be attributed to one parser.
  command = filterCommand ?? "";

  let parsed: { text: string; lossy: boolean } | null = null;
  let filterName = "generic";

  // Phase 2: Specialized ecosystem parsers
  parsed = isError ? null : normalizeParserResult(filterGitCommand(command, cleaned, isError));
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
  if (parsed === null && !isError) {
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
    if (compacted.join("\n") !== rawOutput) {
      parsed = { text: compacted.join("\n"), lossy: false };
      filterName = "dedup";
    }
  }

  // If no parser matched or the output was unchanged, pass through
  if (parsed === null || parsed.text === rawOutput) {
    return null;
  }

  const filteredText = parsed.text;
  // Specialized parsers can discard details even without hitting a line cap.
  // Conservatively expose recall for every semantic rewrite, not ANSI cleanup.
  parsed.lossy ||= filterName !== "dedup" && filteredText !== cleaned;
  const delivered = filteredText + (parsed.lossy ? formatRecallHint("00000000") : "");
  const filteredBytes = Buffer.byteLength(filteredText, "utf8");
  if (Buffer.byteLength(delivered, "utf8") >= originalBytes ||
      Math.ceil(delivered.length / 4) > Math.ceil(rawOutput.length / 4)) return null;
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
  // A successful exit does not imply there are no security/deprecation reports
  // or warnings. Never truncate their following explanation or remediation.
  if (/\b(?:error|warning|warn|err|vulnerability|vulnerabilities|deprecated|security)\b/i.test(text)) {
    return { text, lossy: false };
  }
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
  lossy ||= result !== text.trim();
  if (result.length === 0 && rule.onEmpty) {
    return { text: rule.onEmpty, lossy };
  }

  return { text: result, lossy };
}
