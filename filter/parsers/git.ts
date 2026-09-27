export function filterGitCommand(command: string, raw: string, isError: boolean): string | null {
  if (!/\bgit\b/.test(command)) {
    return null;
  }

  // If error, don't over-filter so diagnostic information is preserved
  if (isError) {
    return filterGitError(raw);
  }

  // git push
  if (/\bgit\s+push\b/.test(command)) {
    return filterGitPush(raw);
  }

  // git status
  if (/\bgit\s+status\b/.test(command)) {
    return filterGitStatus(raw);
  }

  // git commit
  if (/\bgit\s+commit\b/.test(command)) {
    return filterGitCommit(raw);
  }

  // git add
  if (/\bgit\s+add\b/.test(command)) {
    if (raw.trim().length === 0) return "ok";
    return raw.trim();
  }

  // git pull
  if (/\bgit\s+pull\b/.test(command)) {
    return filterGitPull(raw);
  }

  // git log
  if (/\bgit\s+log\b/.test(command)) {
    return filterGitLog(raw);
  }

  // git diff
  if (/\bgit\s+diff\b/.test(command)) {
    return filterGitDiff(raw);
  }

  return null;
}

function filterGitPush(raw: string): string {
  if (raw.includes("Everything up-to-date") || raw.includes("Everything up to date")) {
    return "ok up-to-date";
  }

  // Find updated branch references (e.g. `main -> main` or `[new branch] feature -> feature`)
  const matches: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("->")) {
      const match = trimmed.match(/([^\s]+)\s+->\s+([^\s]+)/);
      if (match) {
        matches.push(match[0]);
      }
    } else if (trimmed.startsWith("[new branch]") || trimmed.startsWith("[new tag]")) {
      matches.push(trimmed);
    }
  }

  if (matches.length > 0) {
    return `ok ${matches.join(", ")}`;
  }

  // If no specific branch line was found, take the last non-empty line
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? `ok ${lines[lines.length - 1]}` : "ok push";
}

function filterGitStatus(raw: string): string {
  const lines = raw.split("\n");
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Drop git instructional guidance and hints
    if (trimmed.startsWith("(") && (trimmed.endsWith(")") || trimmed.includes("use \"git") || trimmed.includes("commit -a"))) continue;
    if (trimmed.startsWith("no changes added to commit")) continue;
    if (trimmed.startsWith("On branch")) {
      filtered.push(trimmed);
      continue;
    }
    if (trimmed.includes("nothing to commit, working tree clean")) {
      return "clean: working tree clean";
    }
    if (trimmed.length > 0) {
      filtered.push(line.trimEnd());
    }
  }

  return filtered.join("\n");
}

function filterGitCommit(raw: string): string {
  // Typical output: `[main a1b2c3d] commit title\n 1 file changed, 2 insertions(+)`
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const statLine = lines.find((l) => l.includes("changed") || l.includes("insertion") || l.includes("deletion"));

  if (firstLine.startsWith("[")) {
    return statLine ? `${firstLine} (${statLine})` : firstLine;
  }

  return raw;
}

function filterGitPull(raw: string): string {
  if (raw.includes("Already up to date") || raw.includes("Already up-to-date")) {
    return "ok Already up to date";
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const statLine = lines.find((l) => l.includes("files changed") || l.includes("file changed"));
  const fastForward = lines.find((l) => l.includes("Fast-forward"));

  if (statLine) {
    return fastForward ? `ok Fast-forward: ${statLine}` : `ok ${statLine}`;
  }

  return lines.slice(0, 5).join("\n");
}

function filterGitLog(raw: string): string {
  // If git log was executed without --oneline, it outputs 4-6 lines per commit.
  // Compact multi-line commit blocks into single-line formats.
  const lines = raw.split("\n");
  const hasCommitBlocks = lines.some((l) => l.startsWith("commit "));

  if (!hasCommitBlocks) return raw;

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

  return onelineCommits.length > 0 ? onelineCommits.slice(0, 30).join("\n") : raw;
}

function filterGitDiff(raw: string): string {
  const lines = raw.split("\n");
  const condensed: string[] = [];

  for (const line of lines) {
    // Strip verbose diff metadata lines
    if (line.startsWith("index ") && line.includes("..")) continue;
    if (line.startsWith("similarity index ")) continue;
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) continue;
    condensed.push(line);
  }

  return condensed.join("\n");
}

function filterGitError(raw: string): string {
  const lines = raw.split("\n");
  // Keep error, fatal, and warning lines, and strip hint boilerplate
  const filtered = lines.filter((l) => {
    const trimmed = l.trim();
    return !trimmed.startsWith("hint:");
  });
  return filtered.join("\n");
}
