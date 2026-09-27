import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStagedOverview } from "./types.js";

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
