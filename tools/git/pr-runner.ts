import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  execGit,
  getDefaultBranch,
  getBranchDiffSummary,
  hasGitHubCli,
  isGitRepository,
} from "./git.js";
import { PR_AGENT_SYSTEM_PROMPT } from "./smart-prompts.js";
import { createPrTools, type PullRequestProposal } from "./smart-tools.js";

/**
 * Executes the PR generation workflow.
 */
export async function handlePrCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
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

  let baseBranch = args.trim();
  if (!baseBranch) {
    baseBranch = await getDefaultBranch(cwd);
  }

  const branchSummary = await getBranchDiffSummary(baseBranch, cwd);
  if (branchSummary.error) {
    ctx.ui.notify(
      `Cannot generate PR: ${branchSummary.error}. Pass an explicit base branch: /git pr <base>`,
      "warning"
    );
    return;
  }
  if (branchSummary.commits.length === 0 && !branchSummary.diffStat) {
    ctx.ui.notify(`Branch is identical to ${baseBranch}; no commits or diffs found.`, "info");
    return;
  }

  ctx.ui.setWorkingMessage?.(`Analyzing diff against ${baseBranch} to generate PR…`);

  let finalProposal: PullRequestProposal | undefined;

  const tools = createPrTools(baseBranch, cwd, (pr) => {
    finalProposal = pr;
  });

  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
  });

  const modelRuntime = (ctx.modelRegistry as any)?.runtime;
  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime,
    model,
    tools: ["git_branch_overview", "git_branch_diff", "propose_pr"],
    customTools: tools,
  });

  try {
    const promptText =
      `Please inspect the branch commits and diff relative to base branch "${baseBranch}". ` +
      `Generate an impactful PR title, summary, key changes, and testing instructions. Call propose_pr.\n\n` +
      PR_AGENT_SYSTEM_PROMPT;

    await session.prompt(promptText);
  } catch (err: any) {
    ctx.ui.notify(`PR generation failed: ${err?.message || String(err)}`, "error");
    return;
  } finally {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    ctx.ui.setWorkingMessage?.();
  }

  if (!finalProposal) {
    ctx.ui.notify("Sub-agent did not produce a PR proposal.", "warning");
    return;
  }

  const ghAvailable = await hasGitHubCli();

  // If running in interactive UI
  if (ctx.hasUI) {
    const options: string[] = [
      "View / edit markdown in editor",
      "Print to chat output",
    ];
    if (ghAvailable) {
      options.unshift("Create PR via GitHub CLI (gh pr create)");
    }

    const choice = await ctx.ui.select(
      `Pull Request: ${finalProposal.title}\n(${branchSummary.commits.length} commits, compared to ${baseBranch})`,
      options
    );

    if (choice === undefined) {
      return;
    }

    if (choice.includes("gh pr create")) {
      ctx.ui.setWorkingMessage?.("Opening GitHub CLI PR create…");
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("gh", [
          "pr", "create",
          "--base", baseBranch,
          "--title", finalProposal.title,
          "--body", finalProposal.markdown,
        ], { cwd });
        ctx.ui.notify(`PR created: ${stdout.trim()}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`gh pr create failed: ${err?.stderr?.trim() || err?.message || String(err)}`, "error");
      } finally {
        ctx.ui.setWorkingMessage?.();
      }
      return;
    }

    if (choice.includes("editor")) {
      const edited = await ctx.ui.editor(`PR: ${finalProposal.title}`, `# ${finalProposal.title}\n\n${finalProposal.markdown}`);
      if (edited) {
        ctx.ui.notify("PR markdown saved.", "info");
      }
      return;
    }
  }

  // Fallback print
  process.stdout.write(`\n=== PR Proposal ===\nTitle: ${finalProposal.title}\n\n${finalProposal.markdown}\n\n`);
  ctx.ui.notify(`Generated PR: "${finalProposal.title}"`, "info");
}
