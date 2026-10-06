import type { ParsedOutput, ParserResult } from "../types.js";

export function filterLintCommand(command: string, raw: string, isError: boolean): ParserResult {
  const isLint =
    /\b(tsc|eslint|biome|ruff|oxlint|rubocop|golangci-lint|markdownlint|yamllint|hadolint|sqlfluff)\b/.test(
      command
    );

  if (!isLint) return null;

  // TypeScript compiler (tsc)
  if (/\btsc\b/.test(command)) {
    return filterTsc(raw, isError);
  }

  // Biome / ESLint / Oxlint
  if (/\b(eslint|biome|oxlint)\b/.test(command)) {
    return filterJsLinters(raw, isError);
  }

  // Python ruff
  if (/\bruff\b/.test(command)) {
    return filterRuff(raw, isError);
  }

  // Generic fallback for other linters
  return filterGenericLinter(raw, isError);
}

function filterTsc(raw: string, isError: boolean): ParsedOutput {
  if (!isError && raw.trim().length === 0) {
    return { text: "ok tsc: no errors", lossy: false };
  }

  const lines = raw.split("\n");
  const errors: string[] = [];
  let summaryLine = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes("error TS")) {
      // e.g. "src/index.ts:45:12 - error TS2304: Cannot find name 'foo'."
      errors.push(trimmed.replace(" - error TS", " - TS"));
    } else if (trimmed.startsWith("Found ") && trimmed.includes("error")) {
      summaryLine = trimmed;
    }
  }

  if (errors.length > 0) {
    const isLossy = errors.length > 35;
    const out = errors.slice(0, 35);
    if (isLossy) {
      out.push(`... and ${errors.length - 35} more TypeScript errors`);
    }
    if (summaryLine) {
      out.push(`\n${summaryLine}`);
    }
    return { text: out.join("\n"), lossy: isLossy };
  }

  return { text: raw, lossy: false };
}

function filterJsLinters(raw: string, isError: boolean): ParsedOutput {
  if (!isError && (raw.trim().length === 0 || raw.includes("0 errors"))) {
    return { text: "ok lint: no errors", lossy: false };
  }

  const lines = raw.split("\n");
  const findings: string[] = [];
  let summary = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // Drop ASCII pointer squiggles
    if (/^\s*[│^~]+\s*$/.test(trimmed)) continue;
    if (trimmed.startsWith("┌") || trimmed.startsWith("└") || trimmed.startsWith("│")) continue;

    // Capture findings with line numbers
    if (/\d+:\d+\s+(error|warning)/i.test(trimmed) || /([^\s]+:\d+:\d+)/.test(trimmed)) {
      findings.push(trimmed);
    } else if (trimmed.includes("problems") || trimmed.includes("Checked ") || trimmed.includes("Found ")) {
      summary = trimmed;
    }
  }

  if (findings.length > 0) {
    const isLossy = findings.length > 30;
    const out = findings.slice(0, 30);
    if (isLossy) {
      out.push(`... and ${findings.length - 30} more lint findings`);
    }
    if (summary) {
      out.push(`\n${summary}`);
    }
    return { text: out.join("\n"), lossy: isLossy };
  }

  return { text: raw, lossy: false };
}

function filterRuff(raw: string, isError: boolean): ParsedOutput {
  if (!isError && (raw.trim().length === 0 || raw.includes("All checks passed"))) {
    return { text: "ok ruff: all checks passed", lossy: false };
  }

  const lines = raw.split("\n");
  const findings = lines.filter((line) => {
    const trimmed = line.trim();
    return /^[^\s]+:\d+:\d+:\s+[A-Z0-9]+/.test(trimmed);
  });

  if (findings.length > 0) {
    const isLossy = findings.length > 30;
    const out = findings.slice(0, 30);
    if (isLossy) {
      out.push(`... and ${findings.length - 30} more ruff findings`);
    }
    return { text: out.join("\n"), lossy: isLossy };
  }

  return { text: raw, lossy: false };
}

function filterGenericLinter(raw: string, isError: boolean): ParsedOutput {
  const lines = raw.split("\n");
  const findings = lines.filter((l) => {
    const trimmed = l.trim();
    return /\b(error|warning|err|warn)\b/i.test(trimmed) && !trimmed.startsWith("hint:");
  });

  if (findings.length > 0) {
    const isLossy = findings.length > 30;
    const out = findings.slice(0, 30);
    if (isLossy) {
      out.push(`... and ${findings.length - 30} more errors/warnings`);
    }
    return { text: out.join("\n"), lossy: isLossy };
  }

  return { text: raw, lossy: false };
}
