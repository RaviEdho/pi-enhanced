import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { readGitStatus, type GitStatus } from "../../ux/usage/git-status.js";
import {
  execGit,
  getCurrentBranch,
  isGitRepository,
  pushCommit,
} from "./git.js";
import { confirmGitReview, selectGitMenu } from "./review-dialog.js";
import { gitStatusActions, readMenuContext } from "./status-menu.js";
import { readTagPushWorkflow, type TagPushWorkflow } from "./tag-workflows.js";

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
    const confirmed = await confirmGitReview(ctx, "Confirm Discard Changes", [message], "Discard changes");
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
      const confirm = await confirmGitReview(ctx, "Confirm Undo Commit", [
        "Undo last commit? Changes will remain in working tree.", "", lastCommit,
      ], "Undo commit");
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

function gitMenuRows(status: GitStatus | undefined, tagPush: TagPushWorkflow): Array<[label: string, value: string]> {
  const warnings: Array<[string, string]> = tagPush === "found" || status?.unborn ? [] : [["Release tag",
    tagPush === "missing" ? "No tag-push workflow found in local HEAD" : "Could not check tag-push workflows in local HEAD"]];
  if (!status) return [["Status", "Repository details unavailable"], ...warnings];
  const { branch, detached, unborn, upstream, ahead, behind, staged, unstaged, untracked, conflicts } = status;
  const head = detached ? `Detached HEAD at ${branch.slice(1)}` : `${branch}${unborn ? " (no commits yet)" : ""}`;
  const sync = !upstream ? "None configured"
    : ahead === undefined || behind === undefined ? `${upstream} · comparison unavailable`
    : ahead || behind ? `${upstream} · ${ahead} ahead, ${behind} behind (local)`
    : `${upstream} · locally up to date`;
  const changes = staged || unstaged || untracked || conflicts
    ? `${staged} staged · ${unstaged} unstaged · ${untracked} untracked${conflicts ? ` · ${conflicts} conflicted` : ""}`
    : "Working tree clean";
  const rows: Array<[string, string]> = [["Branch", head]];
  if (!detached) rows.push(["Upstream", sync]);
  rows.push(["Changes", changes], ...warnings);
  return rows;
}

export async function handleStatusCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    if (ctx.hasUI) {
      const choice = await selectGitMenu(ctx, "Git Status", [["Status", "Not a Git repository"]], [
        ["Initialize Git repository", "/git init"],
      ]);
      if (choice === "/git init") {
        await handleInitCommand(ctx);
      }
    } else {
      process.stdout.write("Current directory is not inside a git repository. Run '/git init' or 'git init' first.\n");
    }
    return;
  }

  if (ctx.hasUI) {
    const [root, status, local, tagPush] = await Promise.all([
      execGit(["rev-parse", "--show-toplevel"], cwd).then(out => out.trimEnd()),
      readGitStatus(cwd).catch(() => undefined),
      readMenuContext(cwd),
      readTagPushWorkflow(cwd),
    ]);
    const actions = gitStatusActions({
      ...local,
      status,
      hasModel: Boolean(ctx.model),
      isTui: ctx.mode === "tui",
      npmWorkflow: existsSync(resolve(root, ".github/workflows/npm-release.yml")),
      planMode: PlanModeManager.getInstance().isEnabled(),
      trusted: ctx.isProjectTrusted(),
    });
    const choice = await selectGitMenu(ctx, "Git Status", gitMenuRows(status, tagPush), actions);

    if (choice === "/git resolve") {
      const { handleResolveCommand } = await import("./resolve-runner.js");
      await handleResolveCommand("", ctx);
    } else if (choice === "/git summary staged" || choice === "/git summary unstaged") {
      const { handleSummaryCommand } = await import("./summary-runner.js");
      const instruction = await handleSummaryCommand(ctx, pi, choice === "/git summary staged" ? "staged" : "unstaged");
      if (instruction) {
        const { handleCommitCommand } = await import("./runner.js");
        await handleCommitCommand(instruction, ctx);
      }
    } else if (choice === "/git release ship") {
      const { handleReleaseWorkflow } = await import("./release-workflow.js");
      await handleReleaseWorkflow("ship", "", ctx, pi.exec.bind(pi));
    } else if (choice === "/git release npm") {
      const { handleNpmReleaseCommand } = await import("./npm-release-runner.js");
      await handleNpmReleaseCommand(ctx);
    } else if (choice === "/git commit") {
      const { handleCommitCommand } = await import("./runner.js");
      await handleCommitCommand("", ctx);
    } else if (choice === "/git unstage") {
      await handleUnstageCommand(ctx);
    } else if (choice === "/git sync") {
      await handleSyncCommand(ctx);
    } else if (choice === "/git pr") {
      const { handlePrCommand } = await import("./pr-runner.js");
      await handlePrCommand("", ctx, pi);
    } else if (choice === "/git pr review") {
      const { handlePrReviewCommand } = await import("./pr-review-runner.js");
      await handlePrReviewCommand("", ctx, pi);
    } else if (choice === "/git branches") {
      const { handleBranchesMenu } = await import("./branch-menu.js");
      await handleBranchesMenu(ctx, pi);
    } else if (choice === "/git undo") {
      await handleUndoCommand(ctx);
    } else if (choice === "/git discard") {
      await handleDiscardCommand(ctx);
    }
  } else {
    const [branch, statusRaw, lastCommits] = await Promise.all([
      getCurrentBranch(cwd),
      execGit(["status", "-sb"], cwd),
      execGit(["log", "-3", "--oneline"], cwd).catch(() => "(No commits yet)"),
    ]);
    const summary = `Branch: ${branch || "unborn"}\n\n${statusRaw.trim()}\n\nRecent Commits:\n${lastCommits.trim()}`;
    process.stdout.write(`\n=== Git Status ===\n${summary}\n\n`);
  }
}
