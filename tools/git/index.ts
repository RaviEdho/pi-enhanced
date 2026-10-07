import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers both /git and /commit commands.
 * /commit remains a direct first-class alias to the autonomous commit sub-agent.
 * /git provides access to the full suite of smart workflow operations and routine helpers.
 */
export function registerGitCommands(pi: ExtensionAPI): void {
  let isGitBusy = false;

  // Direct first-class /commit command (backward-compatible)
  pi.registerCommand("commit", {
    description: "Autonomously inspect git diff and generate an atomic commit (-u/--unstaged, -s/--single, -m/--multi)",
    handler: async (args, ctx) => {
      if (isGitBusy) {
        ctx.ui.notify("A git operation is already in progress.", "warning");
        return;
      }
      isGitBusy = true;
      try {
        const { handleCommitCommand } = await import("./runner.js");
        await handleCommitCommand(args, ctx);
      } finally {
        isGitBusy = false;
      }
    },
  });

  // Comprehensive /git command suite
  pi.registerCommand("git", {
    description: "Intelligent Git assistant: commit, pr, branch, worktree, resolve, release, sync, undo, status",
    handler: async (args, ctx) => {
      if (isGitBusy) {
        ctx.ui.notify("A git operation is already in progress.", "warning");
        return;
      }

      const trimmed = args.trim();
      const firstSpace = trimmed.indexOf(" ");
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const subArgs = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      isGitBusy = true;
      try {
        switch (sub) {
          case "commit": {
            const { handleCommitCommand } = await import("./runner.js");
            await handleCommitCommand(subArgs, ctx);
            break;
          }
          case "pr": {
            const { handlePrCommand } = await import("./pr-runner.js");
            await handlePrCommand(subArgs, ctx);
            break;
          }
          case "resolve": {
            const { handleResolveCommand } = await import("./resolve-runner.js");
            await handleResolveCommand(subArgs, ctx);
            break;
          }
          case "branch":
          case "switch": {
            const { handleBranchCommand } = await import("./branch-runner.js");
            await handleBranchCommand(subArgs, ctx);
            break;
          }
          case "worktree": {
            const { handleWorktreeCommand } = await import("./branch-runner.js");
            await handleWorktreeCommand(subArgs, ctx);
            break;
          }
          case "release":
          case "changelog": {
            const { handleReleaseCommand } = await import("./release-runner.js");
            await handleReleaseCommand(subArgs, ctx);
            break;
          }
          case "sync": {
            const { handleSyncCommand } = await import("./routine-runner.js");
            await handleSyncCommand(ctx);
            break;
          }
          case "undo": {
            const { handleUndoCommand } = await import("./routine-runner.js");
            await handleUndoCommand(ctx);
            break;
          }
          case "status":
          case "": {
            const { handleStatusCommand } = await import("./routine-runner.js");
            await handleStatusCommand(ctx);
            break;
          }
          default: {
            ctx.ui.notify(
              `Unknown git subcommand '${sub}'. Valid: commit, pr, branch, worktree, resolve, release, sync, undo, status`,
              "warning"
            );
            break;
          }
        }
      } finally {
        isGitBusy = false;
      }
    },
  });
}

export function registerCommitCommand(pi: ExtensionAPI): void {
  registerGitCommands(pi);
}
