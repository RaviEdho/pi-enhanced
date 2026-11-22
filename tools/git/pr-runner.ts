import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
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
export async function handlePrCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const cwd = ctx.cwd;
  const report = (message: string, level: "info" | "warning" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  };
  const setProgress = (message?: string) => {
    // The outer session is idle while the isolated PR agent works.
    if (ctx.hasUI) ctx.ui.setWidget("git-pr", message ? [message] : undefined);
  };

  if (!(await isGitRepository(cwd))) {
    report("Current directory is not inside a git repository. Run '/git init' first.", "error");
    return;
  }

  const baseBranch = args.trim() || await getDefaultBranch(cwd);
  const branchSummary = await getBranchDiffSummary(baseBranch, cwd);
  if (branchSummary.error) {
    report(`Cannot generate PR: ${branchSummary.error}. To choose another base, run /git pr <base-branch>.`, "warning");
    return;
  }
  if (branchSummary.commits.length === 0 && !branchSummary.diffStat) {
    report(`No committed changes on ${branchSummary.currentBranch || "HEAD"} to propose against ${baseBranch}. Check out your feature branch and pass the target branch as /git pr <base-branch>.`, "info");
    return;
  }

  const model = ctx.model;
  if (!model) {
    report("No active model selected in Pi session.", "error");
    return;
  }

  let finalProposal: PullRequestProposal | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  setProgress(`Drafting PR: ${branchSummary.currentBranch || "HEAD"} → ${baseBranch}…`);
  try {
    const tools = createPrTools(baseBranch, cwd, (pr) => { finalProposal = pr; });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager });
    ({ session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      modelRuntime: (ctx.modelRegistry as any)?.runtime,
      model,
      tools: tools.map((tool) => tool.name),
      customTools: tools,
    }));

    await session.prompt(
      `Please inspect the branch commits and diff relative to base branch "${baseBranch}". ` +
      `Generate an impactful PR title, summary, key changes, and testing instructions. Call propose_pr.\n\n` +
      PR_AGENT_SYSTEM_PROMPT,
    );
    if (!finalProposal) {
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (last?.stopReason === "error") throw new Error(last.errorMessage || "Model error");
    }
  } catch (err) {
    report(`PR generation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  } finally {
    setProgress();
    session?.dispose();
  }

  if (!finalProposal) {
    report("The model did not produce a PR draft. Retry or choose another model.", "warning");
    return;
  }

  const { title } = finalProposal;
  let markdown = finalProposal.markdown;
  if (!ctx.hasUI) {
    process.stdout.write(`\n=== PR Proposal ===\nTitle: ${title}\n\n${markdown}\n\n`);
    return;
  }

  const edit = "View / edit PR body";
  const print = "Print to chat output";
  const create = "Create PR via GitHub CLI (gh pr create)";
  const options = [edit, print, ...((await hasGitHubCli()) ? [create] : [])];
  while (true) {
    const choice = await ctx.ui.select(`Pull Request: ${title}\n${branchSummary.currentBranch || "HEAD"} → ${baseBranch}`, options);
    if (choice === edit) {
      const edited = await ctx.ui.editor(`PR: ${title}`, markdown);
      if (edited !== undefined) markdown = edited;
      continue;
    }
    if (choice === print) {
      if (ctx.mode === "tui") pi.appendEntry("git-pr", { title, summary: markdown });
      else report(`${title}\n\n${markdown}`, "info");
    } else if (choice === create) {
      setProgress("Creating pull request via GitHub CLI…");
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { stdout } = await promisify(execFile)("gh", [
          "pr", "create",
          "--base", baseBranch,
          "--title", title,
          "--body", markdown,
        ], { cwd });
        report(`PR created: ${stdout.trim()}`, "info");
      } catch (err: any) {
        report(`gh pr create failed: ${err?.stderr?.trim() || err?.message || String(err)}`, "error");
        continue;
      } finally {
        setProgress();
      }
    }
    return;
  }
}
