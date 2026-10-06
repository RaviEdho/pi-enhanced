// ANSI escape regex matching colors, styles, cursor movements, and OSC strings
const ANSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/**
 * Strips ANSI terminal escape sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Handles terminal carriage returns (\r) which are commonly used for in-place
 * progress bar overwrites (e.g. `10%\r20%\r100%`).
 */
export function resolveCarriageReturns(text: string): string {
  const lines = text.split("\n");
  const resolved = lines.map((line) => {
    if (!line.includes("\r")) return line;
    const segments = line.split("\r").filter((s) => s.trim().length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : "";
  });
  return resolved.join("\n");
}

/**
 * Collapses consecutive identical lines to reduce repetitive logs.
 * Example:
 *   [info] processing...
 *   [info] processing...
 *   [info] processing...
 * becomes:
 *   [info] processing...
 *     ↳ [repeated 3 times]
 */
export function collapseConsecutiveDuplicates(lines: string[]): string[] {
  if (lines.length <= 2) return lines;

  const result: string[] = [];
  let prevLine: string | null = null;
  let repeatCount = 0;

  for (const line of lines) {
    if (prevLine !== null && line.trim() === prevLine.trim() && line.trim().length > 0) {
      repeatCount++;
    } else {
      if (repeatCount > 1) {
        result.push(`  ↳ [repeated ${repeatCount} times]`);
      }
      result.push(line);
      prevLine = line;
      repeatCount = 1;
    }
  }

  if (repeatCount > 1) {
    result.push(`  ↳ [repeated ${repeatCount} times]`);
  }

  return result;
}

/**
 * Collapses multiple consecutive empty lines into a single empty line.
 */
export function collapseEmptyLines(lines: string[]): string[] {
  const result: string[] = [];
  let wasEmpty = false;

  for (const line of lines) {
    const isEmpty = line.trim().length === 0;
    if (isEmpty) {
      if (!wasEmpty) {
        result.push("");
        wasEmpty = true;
      }
    } else {
      result.push(line);
      wasEmpty = false;
    }
  }

  return result;
}

/**
 * Basic universal pre-cleaner applied before specialized parsing.
 */
export function preCleanOutput(text: string): string {
  let cleaned = stripAnsi(text);
  cleaned = resolveCarriageReturns(cleaned);
  return cleaned;
}
