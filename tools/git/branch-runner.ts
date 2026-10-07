import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  execGit,
  getCurrentBranch,
  getWorkingTreeStatus,
  isGitRepository,
} from "./git.js";

/**
 * Handles smart branching: name suggestion, switching, creation.
 */
export async function handleBranchCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
    return;
  }

  const trimmed = args.trim();
  const currentBranch = await getCurrentBranch(cwd);

  // If argument is provided and looks like a branch name, switch or create it
  if (trimmed && !trimmed.includes(" ")) {
    const branchName = trimmed;
    try {
      // Check if branch exists
      const branchList = (await execGit(["branch", "--list", branchName], cwd)).trim();
      if (branchList) {
        await execGit(["switch", branchName], cwd);
        ctx.ui.notify(`Switched to branch '${branchName}'`, "info");
      } else {
        await execGit(["switch", "-c", branchName], cwd);
        ctx.ui.notify(`Created and switched to new branch '${branchName}'`, "info");
      }
      return;
    } catch (err: any) {
      ctx.ui.notify(`Branch switch failed: ${err?.stderr?.trim() || err?.message}`, "error");
      return;
    }
  }

  // If user provided a descriptive task or requested suggestions:
  const model = ctx.model;
  if (!model) {
    // Just list local branches
    const branches = (await execGit(["branch", "--sort=-committerdate"], cwd))
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

    if (ctx.hasUI) {
      const selected = await ctx.ui.select(`Current branch: ${currentBranch}. Switch to:`, branches);
      if (selected) {
        const cleanName = selected.replace(/^\*\s*/, "").trim();
        await execGit(["switch", cleanName], cwd);
        ctx.ui.notify(`Switched to '${cleanName}'`, "info");
      }
    } else {
      process.stdout.write(`Current branch: ${currentBranch}\n\n${branches.join("\n")}\n`);
    }
    return;
  }

  // AI-assisted branch name suggestion based on description or uncommitted diff
  let description = trimmed;
  if (!description) {
    const { staged, unstaged } = await getWorkingTreeStatus(cwd);
    if (staged.length === 0 && unstaged.length === 0) {
      // No diff and no prompt -> interactive branch picker
      const rawBranches = (await execGit(["branch", "--sort=-committerdate"], cwd))
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);

      if (ctx.hasUI && rawBranches.length > 0) {
        const selected = await ctx.ui.select(`Switch branch (current: ${currentBranch}):`, rawBranches);
        if (selected) {
          const cleanName = selected.replace(/^\*\s*/, "").trim();
          await execGit(["switch", cleanName], cwd);
          ctx.ui.notify(`Switched to '${cleanName}'`, "info");
        }
      }
      return;
    }
    const diffStat = (await execGit(["diff", "HEAD", "--stat"], cwd)).trim();
    description = `Changes in working tree:\n${diffStat}`;
  }

  ctx.ui.setWorkingMessage?.("Generating branch name recommendations…");

  let suggestedBranches: string[] = [];
  try {
    const { complete } = await import("@earendil-works/pi-ai/compat");
    const res = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: `Recommend 3 concise Git branch names (e.g. feat/add-logging, fix/auth-token) for the following task or diff:\n\n${description}\n\nRespond ONLY with 3 lines, each line containing just the branch name.`,
            timestamp: Date.now(),
          },
        ],
      },
      {}
    );

    const firstMsg = res.content?.[0];
    const textOut = firstMsg && firstMsg.type === "text" ? firstMsg.text : "";
    suggestedBranches = textOut
      .split("\n")
      .map((b: string) => b.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((b: string) => b && !b.includes(" "));
  } catch (err: any) {
    ctx.ui.notify(`Suggestion failed: ${err?.message}`, "warning");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }

  if (suggestedBranches.length === 0) {
    return;
  }

  if (ctx.hasUI) {
    const chosen = await ctx.ui.select("Choose branch to create & switch:", suggestedBranches);
    if (chosen) {
      try {
        await execGit(["switch", "-c", chosen], cwd);
        ctx.ui.notify(`Created and switched to '${chosen}'`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err?.stderr?.trim() || err?.message}`, "error");
      }
    }
  } else {
    process.stdout.write(`Suggested branches:\n${suggestedBranches.map((b) => `  • ${b}`).join("\n")}\n`);
  }
}

/**
 * Handles worktree inspection and creation.
 */
export async function handleWorktreeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    const worktreeList = await execGit(["worktree", "list"], cwd);
    if (ctx.hasUI) {
      await ctx.ui.editor("Git Worktrees", worktreeList);
    } else {
      process.stdout.write(worktreeList);
    }
    return;
  }

  const [subAction, pathArg, branchArg] = trimmed.split(/\s+/);

  if (subAction === "add" && pathArg) {
    const branchFlag = branchArg ? ["-b", branchArg] : [];
    try {
      await execGit(["worktree", "add", ...branchFlag, pathArg], cwd);
      ctx.ui.notify(`Created worktree at ${pathArg}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Worktree add failed: ${err?.stderr?.trim() || err?.message}`, "error");
    }
    return;
  }

  if (subAction === "remove" && pathArg) {
    try {
      await execGit(["worktree", "remove", pathArg], cwd);
      ctx.ui.notify(`Removed worktree at ${pathArg}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Worktree remove failed: ${err?.stderr?.trim() || err?.message}`, "error");
    }
    return;
  }

  ctx.ui.notify("Usage: /git worktree [list | add <path> [branch] | remove <path>]", "warning");
}
