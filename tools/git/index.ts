import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { GIT_COMMAND_FINISHED } from "./events.js";

/**
 * Registers both /git and /commit commands.
 * /commit remains a direct first-class alias to the autonomous commit sub-agent.
 * /git provides access to the full suite of smart workflow operations and routine helpers.
 */
export function registerGitCommands(pi: ExtensionAPI): void {
  let isGitBusy = false;

  // Durable transcript output without adding the draft or summary to the model's context.
  for (const type of ["git-summary", "git-pr"]) {
    pi.registerEntryRenderer<{ title: string; summary: string }>(type, (entry, _options, theme) => {
      if (!entry.data) return undefined;
      const content = new Container();
      content.addChild(new Text(theme.fg("accent", theme.bold(entry.data.title)), 1, 0));
      content.addChild(new Markdown(entry.data.summary, 1, 1, getMarkdownTheme()));
      return content;
    });
  }

  // Direct first-class /commit command (backward-compatible)
  pi.registerCommand("commit", {
    description: "Autonomously inspect git changes and propose commits; /commit <instruction> selects relevant files/hunks (-u, -s, -m)",
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
        pi.events.emit(GIT_COMMAND_FINISHED, undefined);
      }
    },
  });

  // Comprehensive /git command suite
  pi.registerCommand("git", {
    description: "Intelligent Git assistant: init, commit, pr, branch, worktree, resolve, release, sync, undo, unstage, discard, status, summary",
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
          case "init": {
            const { handleInitCommand } = await import("./routine-runner.js");
            await handleInitCommand(ctx, subArgs);
            break;
          }
          case "commit": {
            const { handleCommitCommand } = await import("./runner.js");
            await handleCommitCommand(subArgs, ctx);
            break;
          }
          case "pr": {
            const { handlePrCommand } = await import("./pr-runner.js");
            await handlePrCommand(subArgs, ctx, pi);
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
            if (sub === "release" && /^npm(?:\s|$)/.test(subArgs)) {
              const npmArgs = subArgs.slice(3).trim();
              if (!npmArgs) {
                const { handleNpmReleaseCommand } = await import("./npm-release-runner.js");
                await handleNpmReleaseCommand(ctx);
              } else if (/^bump(?:\s|$)/.test(npmArgs)) {
                const { handleNpmVersionCommand } = await import("./npm-version-runner.js");
                await handleNpmVersionCommand(ctx, npmArgs.slice(4));
              } else {
                ctx.ui.notify("Usage: /git release npm [bump [patch|minor|major]]", "warning");
              }
              break;
            }
            const { handleReleaseCommand } = await import("./release-runner.js");
            await handleReleaseCommand(subArgs, ctx);
            break;
          }
          case "summary": {
            const { handleSummaryCommand } = await import("./summary-runner.js");
            const instruction = await handleSummaryCommand(ctx, pi, subArgs);
            if (instruction) {
              // Same dispatch as /git commit <instruction>, without re-entering the busy guard.
              const { handleCommitCommand } = await import("./runner.js");
              await handleCommitCommand(instruction, ctx);
            }
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
          case "unstage": {
            const { handleUnstageCommand } = await import("./routine-runner.js");
            await handleUnstageCommand(ctx, subArgs);
            break;
          }
          case "discard": {
            const { handleDiscardCommand } = await import("./routine-runner.js");
            await handleDiscardCommand(ctx, subArgs);
            break;
          }
          case "status":
          case "": {
            const { handleStatusCommand } = await import("./routine-runner.js");
            await handleStatusCommand(ctx, pi);
            break;
          }
          default: {
            ctx.ui.notify(
              `Unknown git subcommand '${sub}'. Valid: init, commit, pr, branch, worktree, resolve, release, sync, undo, unstage, discard, status, summary`,
              "warning"
            );
            break;
          }
        }
      } finally {
        isGitBusy = false;
        pi.events.emit(GIT_COMMAND_FINISHED, undefined);
      }
    },
  });
}

export function registerCommitCommand(pi: ExtensionAPI): void {
  registerGitCommands(pi);
}
