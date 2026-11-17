import type { ParsedOutput, ParserResult } from "../types.js";

/** Keep unknown output rather than guessing a green result or a failure tail. */
function compact(lines: string[], noise: (line: string) => boolean): ParsedOutput {
  const kept = lines.filter((line) => !noise(line.trim()));
  return { text: kept.join("\n"), lossy: kept.length !== lines.length };
}

export function filterTestCommand(command: string, raw: string, isError: boolean): ParserResult {
  const lines = raw.split("\n");
  if (/^go test$/.test(command)) return filterGoTest(lines, raw);
  if (/^cargo test$/.test(command)) {
    // Every crate/doc-test summary survives; panics and compiler errors are not
    // contingent on finding a particular `failures:` heading.
    return compact(lines, (t) => /^test .+ \.\.\. (?:ok|ignored)$/.test(t) ||
      /^(?:Compiling |Finished |Running )|^running \d+ tests?$/.test(t));
  }
  if (/^pytest\b/.test(command)) return filterPytest(lines);
  if (/^bun test$/.test(command)) return filterBun(lines, raw, isError);
  if (/^deno test$/.test(command)) return filterDeno(lines, raw, isError);
  if (/^(?:(?:npm|pnpm|yarn|rake) test|vitest(?: run)?|jest|rspec)$/.test(command)) {
    // Never select just assertion keywords: their continuation, file headings,
    // snapshots, warnings and stack frames carry the actual cause.
    return compact(lines, (t) => /^PASS\s/.test(t) || /^[✓✔]\s/.test(t) ||
      /^(?:RUN|DEV)\s+v\d/.test(t));
  }
  return null;
}

function filterGoTest(lines: string[], raw: string): ParsedOutput {
  // Structured streams are reduced only when every record is recognizable.
  // Otherwise keep mixed/unrecognized records, including truncated NDJSON.
  if (lines.some((line) => line.trimStart().startsWith("{"))) {
    const records: Array<{ raw: string; event: { Action: string; Package?: string; Test?: string; Output?: string } }> = [];
    try {
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (!event || typeof event.Action !== "string" ||
            !["start", "run", "pause", "cont", "pass", "bench", "skip", "fail", "output", "build-output", "build-fail"].includes(event.Action) ||
            (event.Output !== undefined && typeof event.Output !== "string")) return { text: raw };
        records.push({ raw: line, event });
      }
    } catch { return { text: raw }; }
    const failures = new Set(records.filter(({ event: e }) => e.Action === "fail" || e.Action === "build-fail")
      .map(({ event: e }) => e.Package));
    const kept: string[] = [];
    for (const { raw: record, event: e } of records) {
      if (failures.has(e.Package)) {
        // Preserve all output for a failing package, including details emitted
        // before its fail event or outside the failing test's own event group.
        if (e.Output) kept.push(e.Output.replace(/\n$/, ""));
        else if (e.Action === "fail" || e.Action === "build-fail") kept.push(record);
      } else if (!e.Test && ["pass", "skip"].includes(e.Action)) {
        kept.push(record);
      } else if (e.Action === "bench" || e.Action.startsWith("build-")) {
        kept.push(record);
      }
    }
    return kept.length ? { text: kept.join("\n"), lossy: true } : { text: raw };
  }
  return compact(lines, (t) => /^(?:=== (?:RUN|PAUSE|CONT)\s|--- (?:PASS|SKIP):)/.test(t));
}

function filterPytest(lines: string[]): ParsedOutput {
  let diagnostics = false;
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Shortened `_ test_name _` headings and E lines need no special casing:
    // retain the complete diagnostic section through warnings/xfail reports.
    if (/^=+\s*(?:FAILURES|ERRORS|warnings summary|short test summary info)\s*=+$/.test(t)) diagnostics = true;
    if (diagnostics || !(/^(?:=+ test session starts =+|platform |rootdir:|configfile:|plugins:|collected \d+ items?)/.test(t) ||
      /^(?:\S+\.(?:py|pyi)\s+[.sFxXE]+\s*(?:\[\s*\d+%\])?|[.s]+\s*\[\s*\d+%\])$/.test(t))) kept.push(line);
  }
  return { text: kept.join("\n"), lossy: kept.length !== lines.length };
}

function filterBun(lines: string[], raw: string, isError: boolean): ParsedOutput {
  const fail = /^(?:\(fail\)|✗)\s.+\[[\d.]+(?:µ|m)?s\]$/;
  const pass = /^\((?:pass|skip|todo)\)\s/;
  const footer = /^(?:\d+ (?:pass|fail|skip|todo)|Ran \d+ tests? across|Bailed out after \d+ failure|snapshots:|\d+ snapshots?,)/;
  const kept: string[] = [];
  let pending: string[] | undefined;
  let trusted = false;
  let evidence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === "# Unhandled error between tests") {
      trusted = true;
      evidence = true;
      if (pending) kept.push(...pending);
      pending = undefined;
    }
    if (t.startsWith("error:") && !trusted) {
      // An error-looking line may be a passing test's own stdout. Buffer it
      // until the runner's duration-bearing failure marker claims the block.
      pending ??= [];
      pending.push(line);
    } else if (fail.test(t)) {
      evidence = true;
      if (pending) kept.push(...pending);
      pending = undefined;
      kept.push(line);
    } else if (pass.test(t)) {
      pending = undefined;
    } else if (footer.test(t)) {
      // A module/load error can reach the footer without a per-test marker.
      // Do not discard its buffered diagnostic merely because counts follow.
      if (pending) return { text: raw };
      kept.push(line);
      if (/^(?:\d+ fail\b|Bailed out)/.test(t) && !/^0 fail\b/.test(t)) evidence = true;
    } else if (pending) {
      pending.push(line);
    } else if (!/^bun test v/.test(t)) {
      kept.push(line);
    }
  }
  // Module/load failures may have neither marker nor summary. Preserve them.
  if (pending || (isError && !evidence)) return { text: raw };
  return { text: kept.join("\n"), lossy: kept.join("\n") !== raw };
}

function filterDeno(lines: string[], raw: string, isError: boolean): ParsedOutput {
  let stdout = false;
  let diagnostics = false;
  let evidence = false;
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^-{5,} .*output.* -{5,}$/.test(t)) {
      stdout = !t.includes("output end");
      continue;
    }
    if (!stdout && /^(?:ERRORS|FAILURES)$/.test(t)) { diagnostics = true; evidence = true; }
    if (!stdout && /^TS\d+ \[ERROR\]:/.test(t)) { diagnostics = true; evidence = true; }
    if (stdout) continue;
    if (diagnostics || !(/^(?:Check |running \d+ tests? from |.+ \.\.\. (?:ok|ignored)(?:\s|$))/.test(t))) kept.push(line);
  }
  if (stdout || (isError && !evidence)) return { text: raw };
  return { text: kept.join("\n"), lossy: kept.join("\n") !== raw };
}
