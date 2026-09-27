export function filterTestCommand(command: string, raw: string, isError: boolean): string | null {
  const isTestRunner =
    /\b(vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test|bun\s+test|pnpm\s+test|yarn\s+test|deno\s+test|rake\s+test|rspec)\b/.test(
      command
    );

  if (!isTestRunner) return null;

  const lines = raw.split("\n");

  // Determine if it was cargo test
  if (/\bcargo\s+test\b/.test(command)) {
    return filterCargoTest(lines, isError);
  }

  // Determine if it was go test
  if (/\bgo\s+test\b/.test(command)) {
    return filterGoTest(lines, isError);
  }

  // Determine if it was pytest
  if (/\bpytest\b/.test(command)) {
    return filterPytest(lines, isError);
  }

  // General JS / TS test runner (vitest, jest, npm test, etc.)
  return filterJsTest(lines, isError);
}

function filterCargoTest(lines: string[], isError: boolean): string {
  const failedTests: string[] = [];
  let summaryLine = "";
  let inFailuresSection = false;
  const failureDetails: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("test result:")) {
      summaryLine = trimmed;
    } else if (trimmed.startsWith("failures:") && !inFailuresSection) {
      inFailuresSection = true;
    } else if (trimmed.startsWith("test ") && trimmed.endsWith("... FAILED")) {
      failedTests.push(trimmed);
    } else if (inFailuresSection) {
      // Capture failure details until next test result
      if (!trimmed.startsWith("test result:")) {
        failureDetails.push(line);
      }
    }
  }

  if (!isError && !summaryLine.includes("FAILED") && failedTests.length === 0) {
    return summaryLine ? `✓ cargo test: ${summaryLine}` : "✓ cargo test: all passed";
  }

  const out: string[] = [];
  if (failedTests.length > 0) {
    out.push("FAILED TESTS:");
    out.push(...failedTests);
  }
  if (failureDetails.length > 0) {
    out.push("\nDETAILS:");
    out.push(...failureDetails.slice(0, 40));
  }
  if (summaryLine) {
    out.push(`\n${summaryLine}`);
  }

  return out.length > 0 ? out.join("\n") : lines.slice(-20).join("\n");
}

function filterGoTest(lines: string[], isError: boolean): string {
  const failedRuns: string[] = [];
  let finalStatus = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--- FAIL:") || trimmed.startsWith("FAIL\t")) {
      failedRuns.push(line);
    } else if (trimmed === "PASS" || trimmed === "FAIL") {
      finalStatus = trimmed;
    }
  }

  if (!isError && failedRuns.length === 0) {
    return "✓ go test: PASS (all packages passed)";
  }

  return [...failedRuns.slice(0, 30), finalStatus ? `\nStatus: ${finalStatus}` : ""].join("\n");
}

function filterPytest(lines: string[], isError: boolean): string {
  const failureBlocks: string[] = [];
  let summaryLine = "";
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("=" ) && (trimmed.includes("passed") || trimmed.includes("failed"))) {
      summaryLine = trimmed;
    } else if (trimmed.startsWith("FAILED ") || trimmed.startsWith("ERROR ")) {
      failureBlocks.push(line);
    } else if (trimmed.startsWith("___") && trimmed.endsWith("___")) {
      inFailure = true;
      failureBlocks.push(line);
    } else if (inFailure) {
      if (trimmed.startsWith("=" ) && trimmed.endsWith("=" )) {
        inFailure = false;
      } else {
        failureBlocks.push(line);
      }
    }
  }

  if (!isError && failureBlocks.length === 0 && summaryLine && !summaryLine.includes("failed")) {
    return `✓ pytest: ${summaryLine}`;
  }

  const result: string[] = [];
  if (failureBlocks.length > 0) {
    result.push(...failureBlocks.slice(0, 60));
  }
  if (summaryLine) {
    result.push(`\n${summaryLine}`);
  }

  return result.length > 0 ? result.join("\n") : lines.slice(-25).join("\n");
}

function filterJsTest(lines: string[], isError: boolean): string {
  const failedBlocks: string[] = [];
  let summaryLine = "";
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Look for summary lines
    if (
      trimmed.startsWith("Tests:") ||
      trimmed.startsWith("Test Suites:") ||
      trimmed.includes("passed") && trimmed.includes("tests")
    ) {
      summaryLine = trimmed;
    }

    // Identify start of failure block
    if (
      trimmed.startsWith("FAIL ") ||
      trimmed.startsWith("✕ ") ||
      trimmed.startsWith("✗ ") ||
      trimmed.includes("AssertionError") ||
      trimmed.includes("Expected:") ||
      trimmed.includes("Received:")
    ) {
      inFailure = true;
    }

    if (inFailure) {
      // Strip noisy internal node_modules stack frames
      if (
        !line.includes("node_modules/") &&
        !line.includes("/internal/process/") &&
        !line.includes("at async Promise.all")
      ) {
        failedBlocks.push(line);
      }
    }

    // Stop failure block at next test or end of assertion
    if (trimmed.startsWith("PASS ") || (inFailure && trimmed.startsWith("Test Suites:"))) {
      inFailure = false;
    }
  }

  // All tests passed
  if (!isError && failedBlocks.length === 0 && summaryLine && !summaryLine.includes("failed")) {
    return `✓ All tests passed: ${summaryLine}`;
  }

  // Failures occurred
  if (failedBlocks.length > 0) {
    const output = [...failedBlocks.slice(0, 50)];
    if (summaryLine) {
      output.push(`\n${summaryLine}`);
    }
    return output.join("\n");
  }

  return lines.slice(-25).join("\n");
}
