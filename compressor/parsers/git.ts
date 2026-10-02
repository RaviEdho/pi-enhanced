import type { ParsedOutput, ParserResult } from "../types.js";

const LOCKFILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|flake\.lock|poetry\.lock|mix\.lock)$/i;

const GENERATED_PATTERN =
  /\.(?:min\.js|min\.css|map|bundle\.js)$/i;

const MAX_FILE_HUNK_LINES = 100;
const MAX_TOTAL_DIFF_LINES = 250;
const MAX_LOG_COMMITS = 30;

/**
 * If the shell command is chained (e.g. `git add . && git commit -m "..."`),
 * resolve to the primary or trailing git subcommand that produced stdout.
 */
function extractRelevantGitCommand(command: string): string {
  if (command.includes("&&") || command.includes(";") || command.includes("||")) {
    const parts = command.split(/\s*(?:&&|;|\|\|)\s*/);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i].trim();
      if (/\bgit\b/.test(part)) {
        return part;
      }
    }
  }
  return command;
}

export function filterGitCommand(command: string, raw: string, isError: boolean): ParserResult {
  if (!/\bgit\b/.test(command)) {
    return null;
  }

  // If error, don't over-filter so diagnostic information is preserved
  if (isError) {
    return filterGitError(raw);
  }

  const relevantCmd = extractRelevantGitCommand(command);

  // Dispatch from specific to general commands
  if (/\bgit\s+rebase\b/.test(relevantCmd)) {
    return filterGitRebase(raw);
  }

  if (/\bgit\s+commit\b/.test(relevantCmd)) {
    return filterGitCommit(raw);
  }

  if (/\bgit\s+status\b/.test(relevantCmd)) {
    return filterGitStatus(raw);
  }

  if (/\bgit\s+diff\b/.test(relevantCmd)) {
    return filterGitDiff(raw);
  }

  if (/\bgit\s+show\b/.test(relevantCmd)) {
    return filterGitShow(raw);
  }

  if (/\bgit\s+log\b/.test(relevantCmd)) {
    return filterGitLog(raw);
  }

  if (/\bgit\s+push\b/.test(relevantCmd)) {
    return filterGitPush(raw);
  }

  if (/\bgit\s+(pull|fetch)\b/.test(relevantCmd)) {
    return filterGitPull(raw);
  }

  if (/\bgit\s+branch\b/.test(relevantCmd)) {
    return filterGitBranch(raw);
  }

  if (/\bgit\s+(checkout|switch)\b/.test(relevantCmd)) {
    return filterGitCheckout(raw);
  }

  if (/\bgit\s+(reset|restore)\b/.test(relevantCmd)) {
    return filterGitReset(raw);
  }

  if (/\bgit\s+tag\b/.test(relevantCmd)) {
    return filterGitTag(raw);
  }

  if (/\bgit\s+add\b/.test(relevantCmd)) {
    return filterGitAdd(raw);
  }

  return null;
}

/**
 * Lossless compaction of `git status`.
 * Strips instructional hints and guidance while preserving 100% of files,
 * branches, ahead/behind tracking, and change classifications.
 */
function filterGitStatus(raw: string): ParsedOutput {
  const lines = raw.split("\n");
  const filtered: string[] = [];
  let onBranch = "";
  let branchTracking = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Working tree clean check
    if (trimmed.includes("nothing to commit, working tree clean")) {
      return { text: "clean: working tree clean", lossy: false };
    }

    // Branch headers
    if (trimmed.startsWith("On branch ")) {
      onBranch = trimmed;
      continue;
    }
    if (trimmed.startsWith("Your branch is up to date with ")) {
      continue;
    }
    if (trimmed.startsWith("Your branch is ahead of ")) {
      const match = trimmed.match(/by (\d+) commit/);
      branchTracking = match ? `(ahead ${match[1]})` : "(ahead)";
      continue;
    }
    if (trimmed.startsWith("Your branch is behind ")) {
      const match = trimmed.match(/by (\d+) commit/);
      branchTracking = match ? `(behind ${match[1]})` : "(behind)";
      continue;
    }
    if (trimmed.includes("have diverged")) {
      branchTracking = "(diverged)";
      continue;
    }

    // Drop interactive guidance & hints
    if (
      trimmed.startsWith("(") &&
      (trimmed.endsWith(")") || trimmed.includes("use \"git") || trimmed.includes("commit -a"))
    ) {
      continue;
    }
    if (trimmed.startsWith("no changes added to commit")) continue;
    if (trimmed.startsWith("nothing added to commit but untracked files present")) continue;

    if (trimmed.length > 0) {
      // Normalize indentation: replace leading tabs or deep indentation with 2 spaces
      const formatted = line.replace(/^\t+/, "  ").replace(/^\s{4,}/, "  ").trimEnd();
      filtered.push(formatted);
    }
  }

  const out: string[] = [];
  if (onBranch) {
    out.push(branchTracking ? `${onBranch} ${branchTracking}` : onBranch);
  }
  out.push(...filtered);

  return { text: out.join("\n"), lossy: false };
}

/**
 * Smart git diff filter:
 * - Strips git plumbing headers (index, similarity, mode) losslessly.
 * - Collapses large lockfiles and minified bundles into addition/deletion summaries (lossy).
 * - Imposes per-file hunk and overall diff line ceilings to prevent context explosion (lossy).
 */
function filterGitDiff(raw: string): ParsedOutput {
  const hasDiffGit = raw.includes("diff --git ");
  if (!hasDiffGit) {
    // Diff without standard file headers
    const lines = raw.split("\n");
    const cleaned: string[] = [];
    for (const line of lines) {
      if (/^index [0-9a-f]+(\.\.[0-9a-f]+)?( \d+)?$/i.test(line)) continue;
      if (/^similarity index \d+%/i.test(line)) continue;
      if (/^(old|new) mode \d+$/i.test(line)) continue;
      cleaned.push(line);
    }

    if (cleaned.length > MAX_TOTAL_DIFF_LINES) {
      const kept = cleaned.slice(0, MAX_TOTAL_DIFF_LINES);
      kept.push(`... [${cleaned.length - MAX_TOTAL_DIFF_LINES} diff lines omitted]`);
      return { text: kept.join("\n"), lossy: true };
    }

    return { text: cleaned.join("\n"), lossy: false };
  }

  // Split into per-file chunks
  const fileChunks = raw.split(/(?=^diff --git )/m);
  const processedChunks: string[] = [];
  let isLossy = false;

  for (const chunk of fileChunks) {
    if (!chunk.trim()) continue;

    const firstLine = chunk.split("\n")[0] || "";
    const fileMatch = firstLine.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    const filePath = fileMatch ? fileMatch[2] : "";

    // Check for lockfiles and generated artifacts
    if (filePath && (LOCKFILE_PATTERN.test(filePath) || GENERATED_PATTERN.test(filePath))) {
      let additions = 0;
      let deletions = 0;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
      isLossy = true;
      processedChunks.push(
        `diff --git a/${filePath} b/${filePath}\n[collapsed lockfile diff: +${additions} lines, -${deletions} lines]`
      );
      continue;
    }

    // Standard source file
    const lines = chunk.split("\n");
    const cleanedLines: string[] = [];
    let hunkLinesCount = 0;
    let fileTruncated = false;

    for (const line of lines) {
      // Strip metadata lines
      if (/^index [0-9a-f]+(\.\.[0-9a-f]+)?( \d+)?$/i.test(line)) continue;
      if (/^similarity index \d+%/i.test(line)) continue;
      if (/^(old|new) mode \d+$/i.test(line)) continue;

      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        hunkLinesCount++;
        if (hunkLinesCount > MAX_FILE_HUNK_LINES) {
          fileTruncated = true;
          continue;
        }
      }

      cleanedLines.push(line);
    }

    if (fileTruncated) {
      isLossy = true;
      cleanedLines.push(`... [${hunkLinesCount - MAX_FILE_HUNK_LINES} lines omitted for ${filePath || "file"}]`);
    }

    processedChunks.push(cleanedLines.join("\n"));
  }

  const allLines = processedChunks.join("\n").split("\n");
  if (allLines.length > MAX_TOTAL_DIFF_LINES) {
    const kept = allLines.slice(0, MAX_TOTAL_DIFF_LINES);
    kept.push(`... [${allLines.length - MAX_TOTAL_DIFF_LINES} diff lines omitted]`);
    return { text: kept.join("\n"), lossy: true };
  }

  return { text: processedChunks.join("\n"), lossy: isLossy };
}

/**
 * Filters `git show`: retains commit metadata and cleans or budgets diff content.
 */
function filterGitShow(raw: string): ParsedOutput {
  const lines = raw.split("\n");
  const diffIndex = lines.findIndex((l) => l.startsWith("diff --git "));

  if (diffIndex === -1) {
    // `git show --stat` or metadata only
    const cleanLines = lines.filter((l) => {
      const trimmed = l.trim();
      return !trimmed.startsWith("AuthorDate:") && !trimmed.startsWith("CommitDate:");
    });
    return { text: cleanLines.join("\n"), lossy: false };
  }

  const headerLines = lines.slice(0, diffIndex);
  const diffBody = lines.slice(diffIndex).join("\n");
  const diffResult = filterGitDiff(diffBody);

  const cleanHeader = headerLines
    .filter((l) => {
      const trimmed = l.trim();
      return !trimmed.startsWith("AuthorDate:") && !trimmed.startsWith("CommitDate:");
    })
    .join("\n")
    .trimEnd();

  return {
    text: `${cleanHeader}\n\n${diffResult.text}`,
    lossy: diffResult.lossy,
  };
}

/**
 * Lossless push cleaner: strips object count/pack progress, preserves branch updates.
 */
function filterGitPush(raw: string): ParsedOutput {
  if (raw.includes("Everything up-to-date") || raw.includes("Everything up to date")) {
    return { text: "ok up-to-date", lossy: false };
  }

  const matches: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Counting objects:") ||
      trimmed.startsWith("Compressing objects:") ||
      trimmed.startsWith("Writing objects:") ||
      trimmed.startsWith("Total ") ||
      trimmed.startsWith("remote: Resolving deltas:")
    ) {
      continue;
    }
    if (trimmed.includes("->")) {
      const match = trimmed.match(/([^\s]+)\s+->\s+([^\s]+)(\s+\([^)]+\))?/);
      if (match) {
        matches.push(match[0]);
      }
    } else if (trimmed.startsWith("[new branch]") || trimmed.startsWith("[new tag]")) {
      matches.push(trimmed);
    }
  }

  if (matches.length > 0) {
    return { text: `ok ${matches.join(", ")}`, lossy: false };
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    text: lines.length > 0 ? `ok ${lines[lines.length - 1]}` : "ok push",
    lossy: false,
  };
}

/**
 * Lossless commit cleaner: captures `[branch hash] title (stat)` format.
 */
function filterGitCommit(raw: string): ParsedOutput {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const statLine = lines.find((l) => l.includes("changed") || l.includes("insertion") || l.includes("deletion"));

  if (firstLine.startsWith("[")) {
    return {
      text: statLine ? `${firstLine} (${statLine})` : firstLine,
      lossy: false,
    };
  }

  return { text: raw, lossy: false };
}

/**
 * Lossless pull cleaner: strips transfer progress, captures fast-forward stats.
 */
function filterGitPull(raw: string): ParsedOutput {
  if (raw.includes("Already up to date") || raw.includes("Already up-to-date")) {
    return { text: "ok Already up to date", lossy: false };
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const statLine = lines.find((l) => l.includes("files changed") || l.includes("file changed"));
  const fastForward = lines.find((l) => l.includes("Fast-forward"));

  if (statLine) {
    return {
      text: fastForward ? `ok Fast-forward: ${statLine}` : `ok ${statLine}`,
      lossy: false,
    };
  }

  const refs = lines.filter((l) => l.includes("->") || l.startsWith("[new"));
  if (refs.length > 0) {
    return { text: `ok ${refs.join(", ")}`, lossy: false };
  }

  return { text: lines.slice(0, 5).join("\n"), lossy: false };
}

/**
 * Compacts multi-line commit blocks into single-line formats.
 * Lossless if <= 30 commits; caps at 30 if deep log is printed.
 */
function filterGitLog(raw: string): ParsedOutput {
  const lines = raw.split("\n");
  const hasCommitBlocks = lines.some((l) => l.startsWith("commit "));

  if (hasCommitBlocks) {
    const onelineCommits: string[] = [];
    let currentHash = "";
    let currentAuthor = "";
    let currentSubject = "";

    const flush = () => {
      if (currentHash) {
        const shortHash = currentHash.slice(0, 7);
        const authorPart = currentAuthor ? ` (${currentAuthor})` : "";
        onelineCommits.push(`${shortHash}${authorPart} ${currentSubject.trim()}`);
      }
      currentHash = "";
      currentAuthor = "";
      currentSubject = "";
    };

    for (const line of lines) {
      if (line.startsWith("commit ")) {
        flush();
        currentHash = line.slice(7).trim();
      } else if (line.startsWith("Author: ")) {
        const match = line.match(/Author:\s+([^<]+)/);
        currentAuthor = match ? match[1].trim() : "";
      } else if (line.startsWith("Date: ")) {
        // Skip date line
      } else if (line.trim().length > 0 && !currentSubject) {
        currentSubject = line.trim();
      }
    }
    flush();

    if (onelineCommits.length > MAX_LOG_COMMITS) {
      const kept = onelineCommits.slice(0, MAX_LOG_COMMITS);
      kept.push(`... [${onelineCommits.length - MAX_LOG_COMMITS} earlier commits omitted]`);
      return { text: kept.join("\n"), lossy: true };
    }

    return { text: onelineCommits.join("\n"), lossy: false };
  }

  // Already formatted or --oneline
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length > MAX_LOG_COMMITS) {
    const kept = nonEmpty.slice(0, MAX_LOG_COMMITS);
    kept.push(`... [${nonEmpty.length - MAX_LOG_COMMITS} earlier commits omitted]`);
    return { text: kept.join("\n"), lossy: true };
  }

  return { text: lines.join("\n"), lossy: false };
}

/**
 * Lossless rebase cleaner: captures current step, commit title, or conflict details.
 */
function filterGitRebase(raw: string): ParsedOutput {
  if (raw.includes("is up to date") || raw.includes("Successfully rebased")) {
    const successLine = raw.split("\n").find((l) => l.includes("Successfully rebased") || l.includes("up to date"));
    return { text: `ok ${successLine?.trim() ?? "rebase complete"}`, lossy: false };
  }

  const lines = raw.split("\n");
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("(") &&
      (trimmed.includes("git rebase") || trimmed.includes("fix conflicts") || trimmed.includes("use \"git"))
    ) {
      continue;
    }
    if (trimmed.startsWith("You can amend the commit")) continue;
    if (trimmed.startsWith("Resolve all conflicts manually")) continue;
    if (trimmed.length > 0) {
      filtered.push(trimmed);
    }
  }

  return { text: filtered.join("\n"), lossy: false };
}

function filterGitAdd(raw: string): ParsedOutput {
  if (raw.trim().length === 0) {
    return { text: "ok", lossy: false };
  }
  return { text: raw.trim(), lossy: false };
}

function filterGitBranch(raw: string): ParsedOutput {
  const lines = raw.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  return { text: lines.join("\n"), lossy: false };
}

function filterGitCheckout(raw: string): ParsedOutput {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const clean = lines.filter((l) => {
    return !l.startsWith("Your branch is up to date") && !l.startsWith("Your branch is behind");
  });
  return { text: clean.join("\n") || "ok", lossy: false };
}

function filterGitReset(raw: string): ParsedOutput {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const clean = lines.filter((l) => !l.startsWith("(use \"git"));
  return { text: clean.join("\n") || "ok", lossy: false };
}

function filterGitTag(raw: string): ParsedOutput {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return { text: lines.join("\n"), lossy: false };
}

function filterGitError(raw: string): ParsedOutput {
  const lines = raw.split("\n");
  const filtered = lines.filter((l) => {
    const trimmed = l.trim();
    return !trimmed.startsWith("hint:");
  });
  return { text: filtered.join("\n"), lossy: false };
}
