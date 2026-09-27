export function filterLintCommand(command: string, raw: string, isError: boolean): string | null {
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

function filterTsc(raw: string, isError: boolean): string {
  if (!isError && raw.trim().length === 0) {
    return "ok tsc: no errors";
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
    const out = errors.slice(0, 35);
    if (errors.length > 35) {
      out.push(`... and ${errors.length - 35} more TypeScript errors`);
    }
    if (summaryLine) {
      out.push(`\n${summaryLine}`);
    }
    return out.join("\n");
  }

  return raw;
}

function filterJsLinters(raw: string, isError: boolean): string {
  if (!isError && (raw.trim().length === 0 || raw.includes("0 errors"))) {
    return "ok lint: no errors";
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
    const out = findings.slice(0, 30);
    if (summary) {
      out.push(`\n${summary}`);
    }
    return out.join("\n");
  }

  return raw;
}

function filterRuff(raw: string, isError: boolean): string {
  if (!isError && (raw.trim().length === 0 || raw.includes("All checks passed"))) {
    return "ok ruff: all checks passed";
  }

  const lines = raw.split("\n");
  const issues: string[] = [];
  let summary = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Found ") && trimmed.includes("error")) {
      summary = trimmed;
    } else if (/:[0-9]+:[0-9]+:\s+[A-Z0-9]+/.test(trimmed)) {
      issues.push(trimmed);
    }
  }

  if (issues.length > 0) {
    const out = issues.slice(0, 30);
    if (summary) out.push(`\n${summary}`);
    return out.join("\n");
  }

  return raw;
}

function filterGenericLinter(raw: string, isError: boolean): string {
  if (!isError && raw.trim().length === 0) {
    return "ok: no lint errors";
  }

  const lines = raw.split("\n");
  // Keep lines that have file references (containing `:` or `error`)
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (t.length === 0) return false;
    if (/^[│^~\\/|\-_=]+$/.test(t)) return false;
    return true;
  });

  return kept.length > 0 ? kept.slice(0, 40).join("\n") : raw;
}
