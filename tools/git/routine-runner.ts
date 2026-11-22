import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  execGit,
  getCurrentBranch,
  isGitRepository,
  pushCommit,
} from "./git.js";

/** Unstage the entire repository without changing files, HEAD, or operation metadata. */
export async function handleUnstageCommand(ctx: ExtensionCommandContext, args = ""): Promise<void> {
  if (args.trim()) {
    ctx.ui.notify("Usage: /git unstage (unstages all staged changes)", "warning");
    return;
  }
  if (!(await isGitRepository(ctx.cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  ctx.ui.setWorkingMessage?.("Unstaging all changes…");
  try {
    const staged = (await execGit(["diff", "--cached", "--name-only", "-z"], ctx.cwd)).split("\0").filter(Boolean);
    if (!staged.length) {
      ctx.ui.notify("No staged changes to unstage.", "info");
      return;
    }
    // Path-limited reset only updates the index, preserving merge/rebase metadata.
    // The root pathspec includes every path even when invoked from a subdirectory.
    // With an unborn HEAD, Git resets these entries against the empty tree.
    await execGit(["reset", "--", ":/"], ctx.cwd);
    ctx.ui.notify("Unstaged all changes. Working-tree files were left unchanged.", "info");
  } catch (err) {
    ctx.ui.notify(`Unstage failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

/**
 * Quick local git helpers that require 0 LLM tokens and run instantly.
 */
export async function handleSyncCommand(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  ctx.ui.setWorkingMessage?.("Syncing with remote (pull --rebase & push)…");
  try {
    const pullOut = (await execGit(["pull", "--rebase"], cwd)).trim();
    const pushOut = await pushCommit(cwd);
    ctx.ui.notify(`Synced: ${pullOut || "Up to date"} • ${pushOut || "Pushed"}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Sync failed: ${err?.message}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    const out = (await execGit(["rev-parse", "--verify", "-q", ref], cwd)).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

async function hasGitState(cwd: string, name: string): Promise<boolean> {
  try {
    const gitPath = (await execGit(["rev-parse", "--git-path", name], cwd)).trim();
    return gitPath.length > 0 && existsSync(resolve(cwd, gitPath));
  } catch {
    return false;
  }
}

/**
 * Discards uncommitted changes in the working tree and index.
 * Tracked changes are always discarded; untracked files are only removed with --untracked.
 */
export async function handleDiscardCommand(ctx: ExtensionCommandContext, args = ""): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  const flag = args.trim();
  if (flag && !/^(?:--untracked|-u)$/i.test(flag)) {
    ctx.ui.notify("Usage: /git discard [--untracked]", "warning");
    return;
  }
  const includeUntracked = flag.length > 0;

  // Never rewrite history mid-operation; the user should finish or abort it first.
  const inProgress: string[] = [];
  if (await hasGitState(cwd, "MERGE_HEAD")) inProgress.push("merge");
  if (await hasGitState(cwd, "CHERRY_PICK_HEAD")) inProgress.push("cherry-pick");
  if (await hasGitState(cwd, "REVERT_HEAD")) inProgress.push("revert");
  if ((await hasGitState(cwd, "rebase-merge")) || (await hasGitState(cwd, "rebase-apply"))) inProgress.push("rebase");
  if (await hasGitState(cwd, "BISECT_LOG")) inProgress.push("bisect");
  if (inProgress.length > 0) {
    ctx.ui.notify(
      `Cannot discard changes during an in-progress ${inProgress.join("/")}. Finish or abort it first.`,
      "error"
    );
    return;
  }

  let statusRaw: string;
  try {
    statusRaw = await execGit(["status", "--porcelain"], cwd);
  } catch (err: any) {
    ctx.ui.notify(`Failed to inspect working tree: ${err?.message}`, "error");
    return;
  }

  const lines = statusRaw.split("\n").filter((line) => line.trim().length > 0);
  const untracked = lines.filter((line) => line.startsWith("??"));
  const tracked = lines.filter((line) => !line.startsWith("??"));
  const trackedStaged = tracked.filter((line) => line[0] !== " ");
  const trackedUnstaged = tracked.filter((line) => line[1] !== " ");

  if (tracked.length === 0 && (!includeUntracked || untracked.length === 0)) {
    if (!includeUntracked && untracked.length > 0) {
      ctx.ui.notify(
        `No tracked changes to discard. ${untracked.length} untracked file${untracked.length === 1 ? "" : "s"} preserved; pass --untracked to delete them.`,
        "info"
      );
    } else {
      ctx.ui.notify("Working tree clean; nothing to discard.", "info");
    }
    return;
  }

  const hasHead = await hasRef(cwd, "HEAD");
  const headSubject = hasHead ? await execGit(["log", "-1", "--oneline"], cwd).catch(() => "") : "";
  const detailLines: string[] = [];
  if (trackedStaged.length) detailLines.push(`Staged: ${trackedStaged.length} file${trackedStaged.length === 1 ? "" : "s"}`);
  if (trackedUnstaged.length) detailLines.push(`Unstaged: ${trackedUnstaged.length} file${trackedUnstaged.length === 1 ? "" : "s"}`);
  if (includeUntracked && untracked.length) {
    detailLines.push(`Untracked to delete: ${untracked.length} file${untracked.length === 1 ? "" : "s"}`);
  } else if (untracked.length) {
    detailLines.push(`Untracked preserved: ${untracked.length} file${untracked.length === 1 ? "" : "s"} (use --untracked to delete)`);
  }
  const scope = hasHead
    ? `Restore the working tree to:\n${headSubject.trim()}\n\n`
    : "No commits yet; staged entries will be unstaged and file contents kept.\n\n";
  const warning = !hasHead
    ? "Nothing exists in history to restore from, so only the index is reset."
    : includeUntracked
      ? "This permanently discards tracked changes and deletes untracked files. Ignored files are kept."
      : "This permanently discards tracked changes. Untracked files are kept.";
  const message = `${scope}${detailLines.join("\n")}\n\n${warning}\nThis cannot be undone.`;

  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Confirm Discard Changes", message);
    if (!confirmed) {
      ctx.ui.notify("Discard cancelled.", "info");
      return;
    }
  }

  ctx.ui.setWorkingMessage?.("Discarding uncommitted changes…");
  try {
    if (hasHead) {
      await execGit(["reset", "--hard", "HEAD"], cwd);
    } else {
      // Unborn branch: nothing exists in history to restore from, so only unstage.
      await execGit(["rm", "-r", "--cached", "--quiet", "."], cwd).catch(() => {});
    }

    let removedUntracked = 0;
    if (includeUntracked && untracked.length > 0) {
      removedUntracked = untracked.length;
      await execGit(["clean", "-fd"], cwd);
    }

    const parts = hasHead
      ? [`Discarded ${tracked.length} tracked change${tracked.length === 1 ? "" : "s"}`]
      : [`Unstaged ${trackedStaged.length} staged entr${trackedStaged.length === 1 ? "y" : "ies"}`];
    if (removedUntracked > 0) {
      parts.push(`removed ${removedUntracked} untracked entr${removedUntracked === 1 ? "y" : "ies"}`);
    }
    ctx.ui.notify(`${parts.join(" • ")}.`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Discard failed: ${err?.message}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

export async function handleUndoCommand(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  try {
    const lastCommit = (await execGit(["log", "-1", "--oneline"], cwd)).trim();
    if (ctx.hasUI) {
      const confirm = await ctx.ui.confirm(
        "Confirm Undo Commit",
        `Undo last commit? Changes will remain in working tree.\n\n${lastCommit}`
      );
      if (!confirm) return;
    }

    await execGit(["reset", "--soft", "HEAD~1"], cwd);
    ctx.ui.notify(`Undid commit: ${lastCommit} (changes retained in index)`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Undo failed: ${err?.message}`, "error");
  }
}

/**
 * Initializes a new git repository in the current working directory.
 */
export async function handleInitCommand(ctx: ExtensionCommandContext, args?: string): Promise<void> {
  const cwd = ctx.cwd;
  if (await isGitRepository(cwd)) {
    ctx.ui.notify("Git repository is already initialized.", "info");
    return;
  }

  ctx.ui.setWorkingMessage?.("Initializing git repository…");
  try {
    const extraArgs = args ? args.trim().split(/\s+/).filter(Boolean) : [];
    const out = (await execGit(["init", ...extraArgs], cwd)).trim();
    ctx.ui.notify(out || "Initialized empty Git repository.", "info");
  } catch (err: any) {
    ctx.ui.notify(`Failed to initialize git repository: ${err?.message}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

export async function handleStatusCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    if (ctx.hasUI) {
      const choice = await ctx.ui.select("Git (Not Initialized)", [
        "Initialize Git repository (/git init)",
      ]);
      if (choice?.includes("Initialize")) {
        await handleInitCommand(ctx);
      }
    } else {
      process.stdout.write("Current directory is not inside a git repository. Run '/git init' or 'git init' first.\n");
    }
    return;
  }

  const [branch, statusRaw, lastCommits] = await Promise.all([
    getCurrentBranch(cwd),
    execGit(["status", "-sb"], cwd),
    execGit(["log", "-3", "--oneline"], cwd).catch(() => "(No commits yet)"),
  ]);

  const summary = `Branch: ${branch || "unborn"}\n\n${statusRaw.trim()}\n\nRecent Commits:\n${lastCommits.trim()}`;

  if (ctx.hasUI) {
    const root = (await execGit(["rev-parse", "--show-toplevel"], cwd)).trim();
    const { getSummaryChanges } = await import("./summary-runner.js");
    const changes = await getSummaryChanges(root);
    const stageNpm = "Stage npm release (/git release npm)";
    const bumpNpm = "Prepare npm version commit (/git release npm bump)";
    const choice = await ctx.ui.select(`Git Status (${branch || "main"})`, [
      ...(changes.staged.length ? ["Summarize staged changes (/git summary staged)"] : []),
      ...(changes.unstaged.length || changes.untracked.length ? ["Summarize unstaged and untracked changes (/git summary unstaged)"] : []),
      "Commit changes (/git commit)",
      ...(changes.staged.length ? ["Unstage all changes (/git unstage)"] : []),
      "Sync with remote (/git sync)",
      "Draft Pull Request (/git pr)",
      ...(existsSync(resolve(root, ".github/workflows/npm-release.yml")) ? [bumpNpm, stageNpm] : []),
      "Smart Branching (/git branch)",
      "Undo last commit (/git undo)",
      ...(changes.staged.length || changes.unstaged.length || changes.untracked.length
        ? ["Discard uncommitted changes (/git discard)"]
        : []),
    ]);

    if (choice?.startsWith("Summarize")) {
      const { handleSummaryCommand } = await import("./summary-runner.js");
      const instruction = await handleSummaryCommand(ctx, pi, choice.startsWith("Summarize staged") ? "staged" : "unstaged");
      if (instruction) {
        const { handleCommitCommand } = await import("./runner.js");
        await handleCommitCommand(instruction, ctx);
      }
    } else if (choice === bumpNpm) {
      const { handleNpmVersionCommand } = await import("./npm-version-runner.js");
      await handleNpmVersionCommand(ctx);
    } else if (choice === stageNpm) {
      const { handleNpmReleaseCommand } = await import("./npm-release-runner.js");
      await handleNpmReleaseCommand(ctx);
    } else if (choice?.includes("Commit")) {
      const { handleCommitCommand } = await import("./runner.js");
      await handleCommitCommand("", ctx);
    } else if (choice?.startsWith("Unstage")) {
      await handleUnstageCommand(ctx);
    } else if (choice?.includes("Sync")) {
      await handleSyncCommand(ctx);
    } else if (choice?.includes("Pull Request")) {
      const { handlePrCommand } = await import("./pr-runner.js");
      await handlePrCommand("", ctx, pi);
    } else if (choice?.includes("Branch")) {
      const { handleBranchCommand } = await import("./branch-runner.js");
      await handleBranchCommand("", ctx);
    } else if (choice?.includes("Undo")) {
      await handleUndoCommand(ctx);
    } else if (choice?.includes("Discard")) {
      await handleDiscardCommand(ctx);
    }
  } else {
    process.stdout.write(`\n=== Git Status ===\n${summary}\n\n`);
  }
}
