import type { ParsedOutput, ParserResult } from "../types.js";

export function filterTestCommand(command: string, raw: string, isError: boolean): ParserResult {
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

function filterCargoTest(lines: string[], isError: boolean): ParsedOutput {
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
    return {
      text: summaryLine ? `✓ cargo test: ${summaryLine}` : "✓ cargo test: all passed",
      lossy: false,
    };
  }

  const out: string[] = [];
  if (failedTests.length > 0) {
    out.push("FAILED TESTS:");
    out.push(...failedTests);
  }
  let isLossy = false;
  if (failureDetails.length > 0) {
    out.push("\nDETAILS:");
    if (failureDetails.length > 40) {
      isLossy = true;
      out.push(...failureDetails.slice(0, 40));
      out.push(`... [${failureDetails.length - 40} failure lines omitted]`);
    } else {
      out.push(...failureDetails);
    }
  }
  if (summaryLine) {
    out.push(`\n${summaryLine}`);
  }

  return {
    text: out.length > 0 ? out.join("\n") : lines.slice(-20).join("\n"),
    lossy: isLossy,
  };
}

function filterGoTest(lines: string[], isError: boolean): ParsedOutput {
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
    return {
      text: "✓ go test: PASS (all packages passed)",
      lossy: false,
    };
  }

  const isLossy = failedRuns.length > 30;
  const kept = failedRuns.slice(0, 30);
  if (isLossy) {
    kept.push(`... [${failedRuns.length - 30} failed package lines omitted]`);
  }
  if (finalStatus) {
    kept.push(`\nStatus: ${finalStatus}`);
  }

  return {
    text: kept.join("\n"),
    lossy: isLossy,
  };
}

function filterPytest(lines: string[], isError: boolean): ParsedOutput {
  const failureBlocks: string[] = [];
  let summaryLine = "";
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("=") && (trimmed.includes("passed") || trimmed.includes("failed"))) {
      summaryLine = trimmed;
    } else if (trimmed.startsWith("FAILED ") || trimmed.startsWith("ERROR ")) {
      failureBlocks.push(line);
    } else if (trimmed.startsWith("___") && trimmed.endsWith("___")) {
      inFailure = true;
      failureBlocks.push(line);
    } else if (inFailure) {
      if (trimmed.startsWith("=") && trimmed.endsWith("=")) {
        inFailure = false;
      } else {
        failureBlocks.push(line);
      }
    }
  }

  if (!isError && failureBlocks.length === 0 && summaryLine && !summaryLine.includes("failed")) {
    return {
      text: `✓ pytest: ${summaryLine}`,
      lossy: false,
    };
  }

  const isLossy = failureBlocks.length > 60;
  const result: string[] = [];
  if (failureBlocks.length > 0) {
    result.push(...failureBlocks.slice(0, 60));
    if (isLossy) {
      result.push(`... [${failureBlocks.length - 60} failure lines omitted]`);
    }
  }
  if (summaryLine) {
    result.push(`\n${summaryLine}`);
  }

  return {
    text: result.length > 0 ? result.join("\n") : lines.slice(-25).join("\n"),
    lossy: isLossy,
  };
}

function filterJsTest(lines: string[], isError: boolean): ParsedOutput {
  const failedBlocks: string[] = [];
  let summaryLine = "";
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Look for summary lines
    if (
      trimmed.startsWith("Tests:") ||
      trimmed.startsWith("Test Suites:") ||
      (trimmed.includes("passed") && trimmed.includes("tests"))
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

  // All tests passed (lossless summarization)
  if (!isError && failedBlocks.length === 0 && summaryLine && !summaryLine.includes("failed")) {
    return {
      text: `✓ All tests passed: ${summaryLine}`,
      lossy: false,
    };
  }

  // Failures occurred
  if (failedBlocks.length > 0) {
    const isLossy = failedBlocks.length > 50;
    const output = [...failedBlocks.slice(0, 50)];
    if (isLossy) {
      output.push(`... [${failedBlocks.length - 50} failure lines omitted]`);
    }
    if (summaryLine) {
      output.push(`\n${summaryLine}`);
    }
    return {
      text: output.join("\n"),
      lossy: isLossy,
    };
  }

  return {
    text: lines.slice(-25).join("\n"),
    lossy: lines.length > 25,
  };
}
