import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createCommit,
  getChangedFiles,
  getStagedFiles,
  isGitRepository,
  stageAllFiles,
} from "./git.js";
import { COMMIT_AGENT_SYSTEM_PROMPT } from "./prompt.js";
import { createCommitTools } from "./tools.js";
import type { CommitProposal } from "./types.js";

export function registerCommitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("commit", {
    description: "Autonomously inspect git diff and generate a conventional commit",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;

      // 1. Verify git repository
      const isRepo = await isGitRepository(cwd);
      if (!isRepo) {
        ctx.ui.notify("Current directory is not inside a git repository.", "error");
        return;
      }

      // 2. Check changed files
      const changed = await getChangedFiles(cwd);
      if (changed.length === 0) {
        ctx.ui.notify("Working tree clean; no changes to commit.", "info");
        return;
      }

      // 3. Check staged files, prompt to stage all if index is empty
      let staged = await getStagedFiles(cwd);
      if (staged.length === 0) {
        if (!ctx.hasUI) {
          try {
            await stageAllFiles(cwd);
            staged = await getStagedFiles(cwd);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Failed to stage files: ${msg}\n`);
            return;
          }
        } else {
          const shouldStage = await ctx.ui.confirm(
            "Stage Changes",
            "No changes are currently staged. Stage all modified and untracked files (git add -A)?"
          );
          if (!shouldStage) {
            ctx.ui.notify("Commit aborted (no staged changes).", "info");
            return;
          }

          try {
            await stageAllFiles(cwd);
            staged = await getStagedFiles(cwd);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to stage files: ${msg}`, "error");
            return;
          }
        }
      }

      if (staged.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("No changes detected after staging.", "warning");
        } else {
          process.stderr.write("No changes detected after staging.\n");
        }
        return;
      }

      // 4. Ensure an active model is available
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) {
          ctx.ui.notify("No active model selected in Pi session.", "error");
        } else {
          process.stderr.write("No active model selected in Pi session.\n");
        }
        return;
      }

      ctx.ui.setWorkingMessage("Autonomous commit agent analyzing changes…");

      let proposal: CommitProposal | null = null;
      const tools = createCommitTools({
        cwd,
        onPropose: (prop) => {
          proposal = prop;
        },
      });

      try {
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          systemPrompt: COMMIT_AGENT_SYSTEM_PROMPT,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        });
        await resourceLoader.reload();

        const modelRuntime = (ctx.modelRegistry as any)?.runtime;
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          settingsManager,
          modelRuntime,
          model,
          thinkingLevel: ctx.thinkingLevel ?? "off",
          sessionManager: SessionManager.inMemory(cwd),
          resourceLoader,
          tools: ["git_overview", "git_file_diff", "propose_commit"],
          customTools: tools,
        });

        const userPrompt = args.trim()
          ? `User hint/instructions: "${args.trim()}". Inspect staged changes and propose conventional commit.`
          : "Inspect staged changes and propose conventional commit.";

        await session.prompt(userPrompt);
        session.dispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Commit agent failed: ${msg}`, "error");
        return;
      } finally {
        ctx.ui.setWorkingMessage(undefined);
      }

      // 5. Verify captured proposal
      if (!proposal) {
        ctx.ui.notify("Commit agent completed without proposing a message.", "warning");
        return;
      }

      const prop = proposal as CommitProposal;
      const type = prop.type.trim().toLowerCase();
      const scope = prop.scope?.trim().toLowerCase();
      const subject = prop.subject.trim().replace(/\.$/, "");
      const headerLine = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;

      const fullMessage = prop.body?.trim()
        ? `${headerLine}\n\n${prop.body.trim()}`
        : headerLine;

      // 6. Interactive confirmation and execution
      if (!ctx.hasUI) {
        try {
          await createCommit(fullMessage, cwd);
          process.stdout.write(`Committed: ${headerLine}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Commit failed: ${msg}\n`);
        }
        return;
      }

      const actionCommit = `Commit: "${headerLine}"`;
      const actionEdit = "Edit commit message";
      const actionCancel = "Cancel";

      const choice = await ctx.ui.select("Conventional Commit Proposal", [
        actionCommit,
        actionEdit,
        actionCancel,
      ]);

      if (!choice || choice === actionCancel) {
        ctx.ui.notify("Commit cancelled.", "info");
        return;
      }

      if (choice === actionEdit) {
        const edited = await ctx.ui.input("Edit commit message", fullMessage);
        if (!edited || !edited.trim()) {
          ctx.ui.notify("Empty message; commit cancelled.", "info");
          return;
        }

        try {
          await createCommit(edited.trim(), cwd);
          ctx.ui.notify(`Committed: ${edited.split("\n")[0]}`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Commit failed: ${msg}`, "error");
        }
        return;
      }

      // Default: actionCommit
      try {
        await createCommit(fullMessage, cwd);
        ctx.ui.notify(`Committed: ${headerLine}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Commit failed: ${msg}`, "error");
      }
    },
  });
}
