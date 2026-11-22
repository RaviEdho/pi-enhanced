import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getCommitsSinceTag,
  getLatestTag,
  isGitRepository,
} from "./git.js";
import { draftReleaseNotes } from "./release-notes.js";

/**
 * Handles changelog & release note generation.
 */
export async function handleReleaseCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model selected in Pi session.", "error");
    return;
  }

  const latestTag = args.trim() || (await getLatestTag(cwd));

  const commits = await getCommitsSinceTag(latestTag, cwd);
  if (commits.length === 0) {
    ctx.ui.notify(`No commits found since ${latestTag || "initial commit"}.`, "info");
    return;
  }

  try {
    const markdown = await draftReleaseNotes(ctx, commits);
    if (!markdown) {
      ctx.ui.notify("No release notes were generated.", "warning");
      return;
    }

    if (ctx.hasUI) {
      await ctx.ui.editor(`Release Notes (${latestTag || "vInitial"} → HEAD)`, markdown);
    } else {
      process.stdout.write(`\n=== Release Notes ===\n\n${markdown}\n\n`);
    }
  } catch {
    ctx.ui.notify("Could not draft release notes. Check your selected model and try again.", "error");
  }
}
