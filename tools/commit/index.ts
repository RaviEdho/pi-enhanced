import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerCommitCommand(pi: ExtensionAPI): void {
  let isCommitActive = false;

  pi.registerCommand("commit", {
    description: "Autonomously inspect git diff and generate a commit (-u/--unstaged, -s/--single, -m/--multi)",
    handler: async (args, ctx) => {
      if (isCommitActive) {
        ctx.ui.notify("A commit operation is already in progress.", "warning");
        return;
      }
      isCommitActive = true;
      try {
        const { handleCommitCommand } = await import("./runner.js");
        await handleCommitCommand(args, ctx);
      } finally {
        isCommitActive = false;
      }
    },
  });
}
