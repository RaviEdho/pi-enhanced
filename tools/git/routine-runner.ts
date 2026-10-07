import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  execGit,
  getCurrentBranch,
  isGitRepository,
  pushCommit,
} from "./git.js";

/**
 * Quick local git helpers that require 0 LLM tokens and run instantly.
 */
export async function handleSyncCommand(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
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

export async function handleUndoCommand(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
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

export async function handleStatusCommand(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
    return;
  }

  const [branch, statusRaw, lastCommits] = await Promise.all([
    getCurrentBranch(cwd),
    execGit(["status", "-sb"], cwd),
    execGit(["log", "-3", "--oneline"], cwd),
  ]);

  const summary = `Branch: ${branch}\n\n${statusRaw.trim()}\n\nRecent Commits:\n${lastCommits.trim()}`;

  if (ctx.hasUI) {
    const choice = await ctx.ui.select(`Git Status (${branch})`, [
      "Commit changes (/git commit)",
      "Sync with remote (/git sync)",
      "Create Pull Request (/git pr)",
      "Smart Branching (/git branch)",
      "Undo last commit (/git undo)",
      "Close",
    ]);

    if (choice?.includes("Commit")) {
      const { handleCommitCommand } = await import("./runner.js");
      await handleCommitCommand("", ctx);
    } else if (choice?.includes("Sync")) {
      await handleSyncCommand(ctx);
    } else if (choice?.includes("Pull Request")) {
      const { handlePrCommand } = await import("./pr-runner.js");
      await handlePrCommand("", ctx);
    } else if (choice?.includes("Branch")) {
      const { handleBranchCommand } = await import("./branch-runner.js");
      await handleBranchCommand("", ctx);
    } else if (choice?.includes("Undo")) {
      await handleUndoCommand(ctx);
    }
  } else {
    process.stdout.write(`\n=== Git Status ===\n${summary}\n\n`);
  }
}
