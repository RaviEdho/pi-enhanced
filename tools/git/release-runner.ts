import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  execGit,
  getCommitsSinceTag,
  getLatestTag,
  isGitRepository,
} from "./git.js";
import { RELEASE_AGENT_SYSTEM_PROMPT } from "./smart-prompts.js";

/**
 * Handles changelog & release note generation.
 */
export async function handleReleaseCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
    return;
  }

  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model selected in Pi session.", "error");
    return;
  }

  let tagArg = args.trim();
  let latestTag = tagArg || (await getLatestTag(cwd));

  const commits = await getCommitsSinceTag(latestTag, cwd);
  if (commits.length === 0) {
    ctx.ui.notify(`No commits found since ${latestTag || "initial commit"}.`, "info");
    return;
  }

  ctx.ui.setWorkingMessage?.(`Analyzing ${commits.length} commits since ${latestTag || "beginning"}…`);

  try {
    const { complete } = await import("@earendil-works/pi-ai/compat");
    const res = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: `Here are the git commits since ${latestTag || "the start"}:\n\n${commits.join("\n")}\n\nPlease generate a release note in markdown categorizing the changes.`,
            timestamp: Date.now(),
          },
        ],
      },
      { systemPrompt: RELEASE_AGENT_SYSTEM_PROMPT }
    );

    const firstMsg = res.content?.[0];
    const markdown = firstMsg && firstMsg.type === "text" ? firstMsg.text : "";
    if (!markdown) {
      ctx.ui.notify("No release notes were generated.", "warning");
      return;
    }

    if (ctx.hasUI) {
      await ctx.ui.editor(`Release Notes (${latestTag || "vInitial"} → HEAD)`, markdown);
    } else {
      process.stdout.write(`\n=== Release Notes ===\n\n${markdown}\n\n`);
    }
  } catch (err: any) {
    ctx.ui.notify(`Release drafting failed: ${err?.message}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}
