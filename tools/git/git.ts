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

export async function execGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
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
    const branch = res.trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // ignore
  }

  // Fallback for unborn HEAD (e.g. freshly initialized repository)
  try {
    const ref = (await execGit(["symbolic-ref", "--short", "HEAD"], cwd)).trim();
    if (ref) return ref;
  } catch {
    // ignore
  }

  return "";
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
  /** Set when the base ref could not be resolved; commits/diffStat are then meaningless. */
  error?: string;
}

/**
 * Expands a `git status --porcelain` path field, turning rename arrows
 * ("old -> new") into the individual paths so downstream git commands
 * receive valid pathspecs.
 */
function unquotePath(p: string): string {
  if (p.startsWith("\"") && p.endsWith("\"") && p.length > 1) return p.slice(1, -1);
  return p;
}

function expandPorcelainPath(rawPath: string): string[] {
  const trimmed = rawPath.trim();
  if (!trimmed.includes(" -> ")) return [unquotePath(trimmed)];
  const [oldPath, newPath] = trimmed.split(" -> ").map((p) => unquotePath(p.trim()));
  if (!oldPath || !newPath) return [unquotePath(trimmed)];
  return [oldPath, newPath];
}

export async function getBranchDiffSummary(baseBranch: string, cwd: string): Promise<BranchCommitSummary> {
  const currentBranch = await getCurrentBranch(cwd);

  // Resolve base ref (prefer origin/base if exists, else local base)
  let baseRef: string | null = null;
  try {
    await execGit(["rev-parse", "--verify", `origin/${baseBranch}`], cwd);
    baseRef = `origin/${baseBranch}`;
  } catch {
    try {
      await execGit(["rev-parse", "--verify", baseBranch], cwd);
      baseRef = baseBranch;
    } catch {
      baseRef = null;
    }
  }

  if (!baseRef) {
    return {
      baseBranch,
      currentBranch,
      commits: [],
      diffStat: "",
      error: `Base branch "${baseBranch}" was not found locally or on origin`,
    };
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
    const paths = expandPorcelainPath(line.slice(3));

    // Expand rename pairs ("old -> new") into both the deleted old path and the
    // added new path so staging/restore commands receive valid pathspecs.
    for (const path of paths) {
      if (x !== " " && x !== "?") {
        staged.push(path);
      }
      if (x === "?" || y !== " ") {
        unstaged.push(path);
      }
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
  // --no-renames: report the deleted old path and the added new path of a staged
  // rename as separate entries so unstaging + re-staging by path list cannot
  // silently split a rename into "added file + dangling deletion".
  const output = await execGit(["diff", "--cached", "--name-only", "--no-renames"], cwd);
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

export interface SelectiveDiffSnapshot {
  files: string[];
  patches: Map<string, string>;
  hunkCounts: Map<string, number>;
  statSummary: string;
  head: string | undefined;
  indexTree: string;
}

const LITERAL_EMPTY_STRING = ":(literal)";

function parseNulSeparatedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function getPatchHunks(patch: string): string[][] {
  const lines = patch.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^@@\s/.test(lines[i])) starts.push(i);
  }
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
}

async function createCandidateIndex(cwd: string, directory: string): Promise<{ indexPath: string; head?: string }> {
  const indexPath = path.join(directory, "index");
  let head: string | undefined;
  try {
    head = (await execGit(["rev-parse", "--verify", "HEAD"], cwd)).trim() || undefined;
  } catch {
    // An unborn branch has no HEAD; start from an empty index.
  }

  const env = { GIT_INDEX_FILE: indexPath };
  if (head) await execGit(["read-tree", head], cwd, env);
  else await execGit(["read-tree", "--empty"], cwd, env);
  await execGit(["add", "-A"], cwd, env);
  return { indexPath, head };
}

export async function getSelectiveDiffSnapshot(cwd: string): Promise<SelectiveDiffSnapshot> {
  const indexTree = (await execGit(["write-tree"], cwd)).trim();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-enhanced-commit-"));
  try {
    const { indexPath, head } = await createCandidateIndex(cwd, directory);
    const env = { GIT_INDEX_FILE: indexPath };
    const baseArgs = head ? [head] : [];
    const paths = parseNulSeparatedPaths(
      await execGit(["diff", "--cached", "--name-only", "--no-renames", "-z", ...baseArgs], cwd, env)
    );
    const patches = new Map<string, string>();
    const hunkCounts = new Map<string, number>();

    for (const file of paths) {
      const patch = await execGit(
        ["diff", "--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-color", "--unified=0", ...baseArgs, "--", `${LITERAL_EMPTY_STRING}${file}`],
        cwd,
        env
      );
      if (!patch) continue;
      patches.set(file, patch);
      hunkCounts.set(file, getPatchHunks(patch).length);
    }

    const statSummary = await execGit(["diff", "--cached", "--stat", ...baseArgs], cwd, env);
    return {
      files: [...patches.keys()],
      patches,
      hunkCounts,
      statSummary: statSummary.trim(),
      head,
      indexTree,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function formatSelectiveFileDiff(snapshot: SelectiveDiffSnapshot, filePath: string): string {
  const patch = snapshot.patches.get(filePath);
  if (!patch) return `(No changes found for ${filePath})`;
  const lines = patch.split("\n");
  let hunkIndex = 0;
  const annotated = lines.map((line) => {
    if (/^@@\s/.test(line)) {
      hunkIndex++;
      return `[HUNK ${hunkIndex}] ${line}`;
    }
    return line;
  });
  return annotated.join("\n");
}

export async function assertSelectiveSnapshotUnchanged(
  snapshot: SelectiveDiffSnapshot,
  cwd: string
): Promise<void> {
  const current = await getSelectiveDiffSnapshot(cwd);
  const sameFiles = snapshot.files.length === current.files.length &&
    snapshot.files.every((file, index) => file === current.files[index]);
  const samePatches = sameFiles && snapshot.files.every((file) => snapshot.patches.get(file) === current.patches.get(file));
  if (!samePatches || snapshot.head !== current.head || snapshot.indexTree !== current.indexTree) {
    throw new Error("Working changes changed while the commit was being prepared. Run /commit again to review the latest changes.");
  }
}

async function reconcileSelectiveIndex(snapshot: SelectiveDiffSnapshot, cwd: string): Promise<void> {
  const currentIndexTree = (await execGit(["write-tree"], cwd)).trim();
  if (currentIndexTree !== snapshot.indexTree) {
    throw new Error("The git index changed during the commit; it was left untouched to avoid overwriting newer staging changes.");
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-enhanced-index-merge-"));
  try {
    const indexPath = path.join(directory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const newHead = (await execGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
    await execGit(["read-tree", newHead], cwd, env);

    let oldTree: string;
    if (snapshot.head) {
      oldTree = (await execGit(["rev-parse", `${snapshot.head}^{tree}`], cwd)).trim();
    } else {
      await execGit(["read-tree", "--empty"], cwd, env);
      oldTree = (await execGit(["write-tree"], cwd, env)).trim();
      await execGit(["read-tree", newHead], cwd, env);
    }

    const stagedPatch = await execGit(["diff", "--binary", "--no-renames", oldTree, snapshot.indexTree], cwd);
    if (stagedPatch.trim()) {
      const patchPath = path.join(directory, "original-staged.patch");
      await fs.writeFile(patchPath, stagedPatch, "utf8");
      await execGit(["apply", "--3way", "--cached", "--binary", patchPath], cwd, env);
    }

    const unmerged = await execGit(["ls-files", "-u"], cwd, env);
    if (unmerged.trim()) {
      throw new Error("The committed changes overlap staged changes and Git could not cleanly preserve the remaining staged state.");
    }

    const mergedTree = (await execGit(["write-tree"], cwd, env)).trim();
    const latestIndexTree = (await execGit(["write-tree"], cwd)).trim();
    if (latestIndexTree !== snapshot.indexTree) {
      throw new Error("The git index changed during the commit; it was left untouched to avoid overwriting newer staging changes.");
    }
    await execGit(["read-tree", mergedTree], cwd);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

export async function createCommit(message: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await execGit(["commit", "-m", message], cwd, env);
}

export async function unstageAllFiles(cwd: string): Promise<void> {
  await execGit(["reset"], cwd);
}

export async function stageFiles(files: string[], cwd: string): Promise<void> {
  if (files.length === 0) return;
  await execGit(["add", "--", ...files], cwd);
}

function buildSelectedHunkPatch(patch: string, hunkIds: number[], filePath: string): string {
  const lines = patch.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^@@\s/.test(lines[i])) starts.push(i);
  }

  const requested = [...new Set(hunkIds)].sort((a, b) => a - b);
  if (requested.some((id) => !Number.isInteger(id) || id < 1 || id > starts.length)) {
    throw new Error(`Invalid hunk selection for ${filePath}; available hunks: ${starts.length}.`);
  }
  if (starts.length === 0) {
    throw new Error(`No selectable text hunks exist for ${filePath}; select the whole file instead.`);
  }

  const header = lines.slice(0, starts[0]).join("\n");
  const selected = requested.map((id) => {
    const start = starts[id - 1];
    return lines.slice(start, starts[id] ?? lines.length).join("\n");
  });
  return `${header}\n${selected.join("\n")}\n`;
}

interface ValidatedSelectiveStage {
  files: string[];
  hunks: Map<string, number[]>;
}

function validateSelectiveStages(
  stages: CommitProposal[],
  snapshot: SelectiveDiffSnapshot
): ValidatedSelectiveStage[] {
  const available = new Set(snapshot.files);
  const wholeFiles = new Set<string>();
  const hunkFiles = new Set<string>();
  const assignedHunks = new Map<string, number>();

  return stages.map((stage, stageIndex) => {
    const files = [...new Set(stage.files ?? [])];
    const hunks = new Map<string, number[]>();
    if (files.length === 0 && (stage.hunks?.length ?? 0) === 0) {
      throw new Error(`Commit stage ${stageIndex + 1} does not specify files or hunks to include.`);
    }

    for (const file of files) {
      if (!available.has(file)) throw new Error(`Commit stage ${stageIndex + 1} selected a file not present in the reviewed diff: ${file}`);
      if (wholeFiles.has(file) || hunkFiles.has(file)) {
        throw new Error(`The selected changes in ${file} appear in more than one commit stage.`);
      }
      if ((stage.hunks ?? []).some((selection) => selection.filePath === file)) {
        throw new Error(`Commit stage ${stageIndex + 1} selects both the whole file and individual hunks from ${file}.`);
      }
      wholeFiles.add(file);
    }

    for (const selection of stage.hunks ?? []) {
      const file = selection.filePath;
      if (!available.has(file)) throw new Error(`Commit stage ${stageIndex + 1} selected a file not present in the reviewed diff: ${file}`);
      if (wholeFiles.has(file)) throw new Error(`The whole file ${file} is already assigned to another commit stage.`);
      const count = snapshot.hunkCounts.get(file) ?? 0;
      const ids = [...new Set(selection.hunkIds ?? [])];
      if (ids.length === 0) throw new Error(`Commit stage ${stageIndex + 1} has an empty hunk selection for ${file}.`);
      const existing = new Set(hunks.get(file) ?? []);
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 1 || id > count) {
          throw new Error(`Invalid hunk ${id} for ${file}; available hunks: ${count}.`);
        }
        const key = `${file}:${id}`;
        const assignedStage = assignedHunks.get(key);
        if (assignedStage !== undefined && assignedStage !== stageIndex) {
          throw new Error(`Hunk ${id} in ${file} appears in more than one commit stage.`);
        }
        assignedHunks.set(key, stageIndex);
        existing.add(id);
      }
      hunks.set(file, [...existing]);
      hunkFiles.add(file);
    }

    return { files, hunks };
  });
}

export function validateSelectiveCommitPlan(stages: CommitProposal[], snapshot: SelectiveDiffSnapshot): void {
  validateSelectiveStages(stages, snapshot);
}

export async function executeSelectiveCommits(
  stages: CommitProposal[],
  snapshot: SelectiveDiffSnapshot,
  cwd: string,
  onProgress?: (stageIndex: number, total: number, header: string) => void
): Promise<{ committedCount: number; headers: string[] }> {
  await assertSelectiveSnapshotUnchanged(snapshot, cwd);

  const selections = validateSelectiveStages(stages, snapshot);
  const headers: string[] = [];
  let commitError: unknown;

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const { files, hunks: groupedHunks } = selections[i];
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-enhanced-selective-commit-"));
      try {
        const indexPath = path.join(directory, "index");
        const env = { GIT_INDEX_FILE: indexPath };
        let head: string | undefined;
        try {
          head = (await execGit(["rev-parse", "--verify", "HEAD"], cwd)).trim() || undefined;
        } catch {
          // Unborn branch.
        }
        if (head) await execGit(["read-tree", head], cwd, env);
        else await execGit(["read-tree", "--empty"], cwd, env);

        if (files.length > 0) {
          await execGit(["add", "-A", "--", ...files.map((file) => `${LITERAL_EMPTY_STRING}${file}`)], cwd, env);
        }

        let patchIndex = 0;
        for (const [file, ids] of groupedHunks) {
          const patch = buildSelectedHunkPatch(snapshot.patches.get(file) ?? "", ids, file);
          const patchPath = path.join(directory, `hunks-${patchIndex++}.patch`);
          await fs.writeFile(patchPath, patch, "utf8");
          await execGit(["apply", "--cached", "--binary", "--unidiff-zero", patchPath], cwd, env);
        }

        const stagedFiles = await execGit(["diff", "--cached", "--name-only", "--no-renames"], cwd, env);
        if (!stagedFiles.trim()) throw new Error(`Commit stage ${i + 1} produced no changes to commit.`);

        const type = stage.type.trim().toLowerCase();
        const scope = stage.scope?.trim().toLowerCase();
        const subject = stage.subject.trim().replace(/\.$/, "");
        const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
        const message = stage.body?.trim() ? `${header}\n\n${stage.body.trim()}` : header;
        onProgress?.(i + 1, stages.length, header);
        await createCommit(message, cwd, env);
        headers.push(header);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  } catch (err) {
    commitError = err;
  }

  if (headers.length > 0) {
    try {
      await reconcileSelectiveIndex(snapshot, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Created ${headers.length} commit(s), but could not fully preserve the previous staged state: ${msg}`);
    }
  }
  if (commitError) {
    const msg = commitError instanceof Error ? commitError.message : String(commitError);
    if (headers.length > 0) {
      throw new Error(`Created ${headers.length} commit(s), then a later stage failed: ${msg}`);
    }
    throw commitError;
  }

  return { committedCount: headers.length, headers };
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

  // Renames/copies make "commit only unstaged changes" ambiguous (the staged side
  // is a deletion + an addition pair). Refuse before mutating anything so the
  // user's staged state is never mangled by the stash/restore dance.
  const hasRenameOrCopy = statusOutput.split("\n").some((line) => {
    if (!line.trim()) return false;
    const x = line[0];
    return x === "R" || x === "C";
  });
  if (hasRenameOrCopy) {
    throw new Error(
      "Staged renames/copies cannot be split from unstaged changes. Commit the staged rename first (or stage it together with the unstaged edits)."
    );
  }

  const purelyStaged: string[] = [];
  const partiallyStaged: string[] = [];

  for (const line of statusOutput.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    const paths = expandPorcelainPath(line.slice(3));
    // Expand rename pairs so restore pathspecs are valid ("old -> new" is not).
    for (const filePath of paths) {
      if (x !== " " && x !== "?") {
        if (y === " ") {
          purelyStaged.push(filePath);
        } else {
          partiallyStaged.push(filePath);
        }
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

export interface RestoreStashResult {
  conflicts: string[];
}

export async function restoreStashedChanges(
  state: StashedState,
  cwd: string
): Promise<RestoreStashResult> {
  const conflicts: string[] = [];

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

  // 2. Restore decoupled files using 3-way merge:
  // The newly committed HEAD contains the latter unstaged changes.
  // We perform a 3-way merge:
  // - Base: state.stashSha^1:<file> (original HEAD before any commits)
  // - Current: worktree <file> (which has the newly committed HEAD version)
  // - Other: state.stashSha^2:<file> (the older, staged changes)
  if (state.decoupledFiles.length > 0) {
    let tempDir = "";
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-merge-"));
    } catch {
      tempDir = "";
    }

    try {
      for (const file of state.decoupledFiles) {
        let baseContent = "";
        try {
          baseContent = await execGit(["show", `${state.stashSha}^1:${file}`], cwd);
        } catch {
          baseContent = "";
        }

        let stagedContent = "";
        try {
          stagedContent = await execGit(["show", `${state.stashSha}^2:${file}`], cwd);
        } catch {
          stagedContent = "";
        }

        if (!tempDir) {
          // Fallback if tempDir failed: restore worktree from stashSha
          await execGit(["restore", "-s", state.stashSha, "--worktree", "--", file], cwd);
          await execGit(["add", "--", file], cwd);
          continue;
        }

        const baseFile = path.join(tempDir, `base_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        const stagedFile = path.join(tempDir, `staged_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        await fs.writeFile(baseFile, baseContent, "utf8");
        await fs.writeFile(stagedFile, stagedContent, "utf8");

        const targetFilePath = path.isAbsolute(file) ? file : path.join(cwd, file);

        let hasConflict = false;
        try {
          await execGit(
            ["merge-file", "-L", "HEAD", "-L", "base", "-L", "staged", targetFilePath, baseFile, stagedFile],
            cwd
          );
        } catch {
          // git merge-file exits with positive integer (conflict count) if conflicts occur
          hasConflict = true;
          conflicts.push(file);
        }

        if (!hasConflict) {
          // Re-stage the cleanly merged changes so the older staged changes are staged against new HEAD!
          await execGit(["add", "--", file], cwd);
        }

        try {
          await fs.unlink(baseFile);
          await fs.unlink(stagedFile);
        } catch {
          // ignore
        }
      }
    } finally {
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  // 3. Drop stash entry
  try {
    await execGit(["stash", "drop", "-q", "stash@{0}"], cwd);
  } catch {
    // ignore
  }

  return { conflicts };
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

