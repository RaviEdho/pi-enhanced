import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommitProposal, GitStagedOverview } from "./types.js";

const execFileAsync = promisify(execFile);

export const LOCKFILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb?$/,
  /deno\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /composer\.lock$/,
  /Gemfile\.lock$/,
  /poetry\.lock$/,
  /flake\.lock$/,
];

export const MAX_FILE_DIFF_CHARS = 4000;

export async function execGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const res = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return res.trim() === "true";
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const res = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return res.trim();
  } catch {
    return "";
  }
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = (await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)).trim();
    if (ref) return ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    // ignore
  }

  // Check common default branch names locally or on origin
  for (const name of ["main", "master"]) {
    try {
      await execGit(["rev-parse", "--verify", `origin/${name}`], cwd);
      return name;
    } catch {
      // try local
      try {
        await execGit(["rev-parse", "--verify", name], cwd);
        return name;
      } catch {
        // ignore
      }
    }
  }

  return "main";
}

export async function hasGitHubCli(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export interface BranchCommitSummary {
  baseBranch: string;
  currentBranch: string;
  commits: string[];
  diffStat: string;
}

export async function getBranchDiffSummary(baseBranch: string, cwd: string): Promise<BranchCommitSummary> {
  const currentBranch = await getCurrentBranch(cwd);
  
  // Resolve base ref (prefer origin/base if exists, else local base)
  let baseRef = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `origin/${baseBranch}`], cwd);
    baseRef = `origin/${baseBranch}`;
  } catch {
    // use local baseBranch as is
  }

  let commits: string[] = [];
  try {
    const logOutput = await execGit(["log", `${baseRef}..HEAD`, "--oneline", "--no-merges"], cwd);
    commits = logOutput.split("\n").map(l => l.trim()).filter(Boolean);
  } catch {
    commits = [];
  }

  let diffStat = "";
  try {
    diffStat = (await execGit(["diff", `${baseRef}...HEAD`, "--stat"], cwd)).trim();
  } catch {
    diffStat = "";
  }

  return {
    baseBranch,
    currentBranch,
    commits,
    diffStat,
  };
}

export async function getBranchFullDiff(baseBranch: string, cwd: string, maxChars = 24000): Promise<string> {
  let baseRef = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `origin/${baseBranch}`], cwd);
    baseRef = `origin/${baseBranch}`;
  } catch {
    // use baseBranch
  }

  try {
    const diff = await execGit(["diff", `${baseRef}...HEAD`], cwd);
    if (diff.length > maxChars) {
      return `${diff.slice(0, maxChars)}\n\n[...diff truncated: exceeded ${maxChars} characters]`;
    }
    return diff;
  } catch (err: any) {
    return `(Error reading diff: ${err?.message || String(err)})`;
  }
}

export async function getLatestTag(cwd: string): Promise<string | undefined> {
  try {
    const tag = (await execGit(["describe", "--tags", "--abbrev=0"], cwd)).trim();
    return tag || undefined;
  } catch {
    return undefined;
  }
}

export async function getCommitsSinceTag(tag: string | undefined, cwd: string): Promise<string[]> {
  try {
    const range = tag ? `${tag}..HEAD` : "HEAD";
    const log = await execGit(["log", range, "--oneline", "--no-merges"], cwd);
    return log.split("\n").map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface ConflictHunk {
  file: string;
  ours: string;
  theirs: string;
  base?: string;
  startLine: number;
}

export interface ConflictFile {
  path: string;
  content: string;
  hunkCount: number;
}

export async function getConflictFiles(cwd: string): Promise<ConflictFile[]> {
  const status = await execGit(["status", "--porcelain"], cwd);
  const conflictPaths: string[] = [];

  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    // UU = both modified, AA = both added, etc.
    if (code === "UU" || code === "AA" || code === "DD" || code === "AU" || code === "UA" || code === "DU" || code === "UD") {
      conflictPaths.push(filePath);
    }
  }

  const result: ConflictFile[] = [];
  for (const relPath of conflictPaths) {
    try {
      const fullPath = path.resolve(cwd, relPath);
      const content = await fs.readFile(fullPath, "utf-8");
      const hunkCount = (content.match(/<<<<<<< /g) || []).length;
      result.push({ path: relPath, content, hunkCount });
    } catch {
      // ignore
    }
  }

  return result;
}

export interface WorkingTreeStatus {
  staged: string[];
  unstaged: string[];
}

export async function getWorkingTreeStatus(cwd: string): Promise<WorkingTreeStatus> {
  const output = await execGit(["status", "--porcelain"], cwd);
  if (!output.trim()) return { staged: [], unstaged: [] };

  const staged: string[] = [];
  const unstaged: string[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3).trim();

    if (x !== " " && x !== "?") {
      staged.push(path);
    }
    if (x === "?" || y !== " ") {
      unstaged.push(path);
    }
  }

  return { staged, unstaged };
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const output = await execGit(["status", "--porcelain"], cwd);
  if (!output.trim()) return [];
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getStagedFiles(cwd: string): Promise<string[]> {
  const output = await execGit(["diff", "--cached", "--name-only"], cwd);
  if (!output.trim()) return [];
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function stageAllFiles(cwd: string): Promise<void> {
  await execGit(["add", "-A"], cwd);
}

export async function getStagedOverview(cwd: string): Promise<GitStagedOverview> {
  const [stagedFiles, statSummary] = await Promise.all([
    getStagedFiles(cwd),
    execGit(["diff", "--cached", "--stat"], cwd),
  ]);
  return {
    stagedFiles,
    statSummary: statSummary.trim(),
  };
}

export async function getFileDiff(filePath: string, cwd: string): Promise<string> {
  if (!filePath || typeof filePath !== "string") {
    return "(Invalid file path)";
  }

  if (LOCKFILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return "(Diff omitted: lock/generated file)";
  }

  const rawDiff = await execGit(["diff", "--cached", "--", filePath], cwd);
  if (!rawDiff.trim()) {
    return "(No textual diff for file)";
  }

  if (rawDiff.length > MAX_FILE_DIFF_CHARS) {
    return `${rawDiff.slice(0, MAX_FILE_DIFF_CHARS)}\n... [diff truncated: exceeded ${MAX_FILE_DIFF_CHARS} chars]`;
  }

  return rawDiff;
}

export async function createCommit(message: string, cwd: string): Promise<void> {
  await execGit(["commit", "-m", message], cwd);
}

export async function unstageAllFiles(cwd: string): Promise<void> {
  await execGit(["reset"], cwd);
}

export async function stageFiles(files: string[], cwd: string): Promise<void> {
  if (files.length === 0) return;
  await execGit(["add", "--", ...files], cwd);
}

export interface StashedState {
  stashSha: string;
  purelyStaged: string[];
  decoupledFiles: string[];
  overlappingCollisions: string[];
}

export async function stashStagedChanges(
  cwd: string,
  message: string = "pi-commit: manual staged changes"
): Promise<StashedState | null> {
  const statusOutput = await execGit(["status", "--porcelain"], cwd);
  if (!statusOutput.trim()) return null;

  const purelyStaged: string[] = [];
  const partiallyStaged: string[] = [];

  for (const line of statusOutput.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3).trim();
    if (x !== " " && x !== "?") {
      if (y === " ") {
        purelyStaged.push(filePath);
      } else {
        partiallyStaged.push(filePath);
      }
    }
  }

  // 1. Create a stash commit representing full working tree & index without mutating worktree
  const stashShaRaw = await execGit(["stash", "create", message], cwd);
  const stashSha = stashShaRaw.trim();
  if (!stashSha) {
    return null;
  }

  // 2. Store stash commit in git stash list (stash@{0})
  await execGit(["stash", "store", "-m", message, stashSha], cwd);

  // 3. Revert purely staged files to HEAD in both index and worktree
  if (purelyStaged.length > 0) {
    await execGit(
      ["restore", "-s", "HEAD", "--staged", "--worktree", "--", ...purelyStaged],
      cwd
    );
  }

  // 4. For partially staged files (MM), perform zero-context forward decoupling
  const decoupledFiles: string[] = [];
  const overlappingCollisions: string[] = [];

  if (partiallyStaged.length > 0) {
    let tempDir = "";
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-decouple-"));
    } catch {
      tempDir = "";
    }

    for (const file of partiallyStaged) {
      let unstagedDiff = "";
      try {
        unstagedDiff = await execGit(["diff", "-U0", "--", file], cwd);
      } catch {
        unstagedDiff = "";
      }

      if (!unstagedDiff.trim() || !tempDir) {
        // No unstaged content, keep at HEAD
        await execGit(["restore", "-s", "HEAD", "--staged", "--worktree", "--", file], cwd);
        purelyStaged.push(file);
        continue;
      }

      const patchFile = path.join(tempDir, `unstaged_${Date.now()}_${Math.random().toString(36).slice(2)}.patch`);
      await fs.writeFile(patchFile, unstagedDiff, "utf8");

      // Revert file to HEAD so we can project only the unstaged changes onto HEAD
      await execGit(["restore", "-s", "HEAD", "--staged", "--worktree", "--", file], cwd);

      let canApply = false;
      try {
        await execGit(["apply", "--unidiff-zero", "-C0", patchFile], cwd);
        canApply = true;
      } catch {
        canApply = false;
      }

      if (canApply) {
        // Successfully projected only the unstaged changes onto HEAD!
        decoupledFiles.push(file);
      } else {
        // Exact same line collision. Restore original worktree from stash so all edits are preserved.
        await execGit(["restore", "-s", stashSha, "--worktree", "--", file], cwd);
        overlappingCollisions.push(file);
      }

      try {
        await fs.unlink(patchFile);
      } catch {
        // ignore
      }
    }

    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  return { stashSha, purelyStaged, decoupledFiles, overlappingCollisions };
}

export async function restoreStashedChanges(
  state: StashedState,
  cwd: string
): Promise<void> {
  // 1. Restore purely staged files from stash index ($stashSha^2)
  if (state.purelyStaged.length > 0) {
    try {
      await execGit(
        ["restore", "-s", `${state.stashSha}^2`, "--staged", "--worktree", "--", ...state.purelyStaged],
        cwd
      );
    } catch (err: any) {
      const cleanErr = err?.stderr?.trim() || err?.message || String(err);
      throw new Error(cleanErr);
    }
  }

  // 2. Restore decoupled files:
  // The newly committed HEAD contains the bugfix.
  // Restore the original worktree content from stashSha, and re-stage the remaining unfinalized feature work!
  if (state.decoupledFiles.length > 0) {
    try {
      await execGit(["restore", "-s", state.stashSha, "--worktree", "--", ...state.decoupledFiles], cwd);
      await execGit(["add", "--", ...state.decoupledFiles], cwd);
    } catch (err: any) {
      const cleanErr = err?.stderr?.trim() || err?.message || String(err);
      throw new Error(cleanErr);
    }
  }

  // 3. Drop stash entry
  try {
    await execGit(["stash", "drop", "-q", "stash@{0}"], cwd);
  } catch {
    // ignore
  }
}

export async function rollbackStashedChanges(
  state: StashedState,
  cwd: string
): Promise<void> {
  try {
    await execGit(["reset", "-q"], cwd);
    await execGit(["checkout", state.stashSha, "--", "."], cwd);
    await execGit(["read-tree", `${state.stashSha}^2`], cwd);
    await execGit(["stash", "drop", "-q", "stash@{0}"], cwd);
  } catch (err: any) {
    const cleanErr = err?.stderr?.trim() || err?.message || String(err);
    throw new Error(cleanErr);
  }
}

export function matchStagedFiles(
  patterns: string[] | undefined,
  allStagedFiles: string[],
  alreadyCommitted: Set<string>
): string[] {
  const available = allStagedFiles.filter((f) => !alreadyCommitted.has(f));
  if (!patterns || patterns.length === 0) {
    return available;
  }

  const matched = new Set<string>();

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().replace(/^\.\//, "");
    if (!pattern) continue;

    // Check glob prefix e.g. "providers/*", "providers/**", "providers/"
    if (pattern.endsWith("/*") || pattern.endsWith("/**") || pattern.endsWith("/")) {
      const prefix = pattern.replace(/(\/\*+|\/)$/, "");
      for (const file of available) {
        if (file === prefix || file.startsWith(`${prefix}/`)) {
          matched.add(file);
        }
      }
      continue;
    }

    // Exact match
    for (const file of available) {
      if (file === pattern || file.toLowerCase() === pattern.toLowerCase()) {
        matched.add(file);
      } else if (file.endsWith(`/${pattern}`) || pattern.endsWith(`/${file}`)) {
        matched.add(file);
      }
    }
  }

  return Array.from(matched);
}

export async function executeMultiCommit(
  stages: CommitProposal[],
  cwd: string,
  onProgress?: (stageIndex: number, total: number, header: string) => void
): Promise<{ committedCount: number; headers: string[] }> {
  const allStaged = await getStagedFiles(cwd);
  if (allStaged.length === 0) {
    throw new Error("No files staged to commit.");
  }

  // Unstage everything first so we can stage per commit
  await unstageAllFiles(cwd);

  const alreadyCommitted = new Set<string>();
  const headers: string[] = [];

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const isLastStage = i === stages.length - 1;

      let targetFiles = matchStagedFiles(stage.files, allStaged, alreadyCommitted);

      // If this is the last stage and some original files are still uncommitted,
      // include them so nothing from the original staged set is omitted
      if (isLastStage) {
        const remaining = allStaged.filter((f) => !alreadyCommitted.has(f) && !targetFiles.includes(f));
        if (remaining.length > 0) {
          targetFiles = [...targetFiles, ...remaining];
        }
      }

      if (targetFiles.length === 0) {
        continue;
      }

      await stageFiles(targetFiles, cwd);

      const type = stage.type.trim().toLowerCase();
      const scope = stage.scope?.trim().toLowerCase();
      const subject = stage.subject.trim().replace(/\.$/, "");
      const headerLine = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
      const fullMessage = stage.body?.trim()
        ? `${headerLine}\n\n${stage.body.trim()}`
        : headerLine;

      onProgress?.(i + 1, stages.length, headerLine);
      await createCommit(fullMessage, cwd);

      for (const file of targetFiles) {
        alreadyCommitted.add(file);
      }
      headers.push(headerLine);
    }

    // Check if any files from the original staged set were somehow not committed
    const uncommitted = allStaged.filter((f) => !alreadyCommitted.has(f));
    if (uncommitted.length > 0) {
      await stageFiles(uncommitted, cwd);
      const fallbackHeader = "chore: commit remaining staged changes";
      await createCommit(fallbackHeader, cwd);
      headers.push(fallbackHeader);
    }
  } catch (err) {
    // Re-stage any remaining uncommitted files so the working tree isn't left unindexed
    const uncommitted = allStaged.filter((f) => !alreadyCommitted.has(f));
    if (uncommitted.length > 0) {
      try {
        await stageFiles(uncommitted, cwd);
      } catch {
        // ignore
      }
    }
    throw err;
  }

  return { committedCount: headers.length, headers };
}

export async function pushCommit(cwd: string): Promise<string> {
  const runPush = async (args: string[]) => {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return (stdout || stderr).trim();
  };

  try {
    return await runPush(["push"]);
  } catch (err: any) {
    const errorMsg = `${err?.stderr || ""} ${err?.message || ""}`;
    if (errorMsg.includes("no upstream branch") || errorMsg.includes("--set-upstream")) {
      const remotes = (await execGit(["remote"], cwd)).trim().split("\n").filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      const branch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      if (remote && branch && branch !== "HEAD") {
        return await runPush(["push", "--set-upstream", remote, branch]);
      }
    }
    const cleanErr = err?.stderr?.trim() || err?.message || String(err);
    throw new Error(cleanErr);
  }
}

