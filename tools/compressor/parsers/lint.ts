import type { ParserResult } from "../types.js";

/** Diagnostic blocks are indivisible: keep file headings and continuations. */
export function filterLintCommand(command: string, raw: string, _isError: boolean): ParserResult {
  if (!/^(?:tsc|eslint|biome|ruff check|oxlint|rubocop|golangci-lint|markdownlint|yamllint|hadolint|sqlfluff)\b/.test(command)) return null;
  const lines = raw.split("\n");
  // JSON, help, configuration failures and unknown formats must remain intact.
  // In particular, "0 errors" is not evidence of a warning-free run.
  const hasDiagnostics = lines.some((line) =>
    /\b(?:error|warning) TS\d+:/.test(line) ||
    /\d+:\d+(?::|\s).*\b(?:error|warning|[A-Z]+\d+)\b/i.test(line) ||
    /[┌╭].*\d+:\d+/.test(line));
  if (!hasDiagnostics) return { text: raw };
  const kept = lines.filter((line) => {
    // Remove only pointer/ruler lines, never source excerpts, file identities,
    // explanatory lines, nested assignability errors, or suggested fixes.
    const t = line.trim();
    return !/^[│┃|]?\s*[\^~]+\s*$/.test(t) && !/^[└┘┌┐╰╯─━]+$/.test(t);
  });
  return { text: kept.join("\n"), lossy: kept.length !== lines.length };
}
