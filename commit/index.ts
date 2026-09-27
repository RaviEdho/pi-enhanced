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
  getStagedFiles,
  getWorkingTreeStatus,
  isGitRepository,
  stageAllFiles,
} from "./git.js";
import { BlockingCommitEditor, CommitStatusBroadcaster } from "./editor.js";
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

      // 2. Check working tree status (staged and unstaged)
      let { staged, unstaged } = await getWorkingTreeStatus(cwd);
      if (staged.length === 0 && unstaged.length === 0) {
        ctx.ui.notify("Working tree clean; no changes to commit.", "info");
        return;
      }

      // 3. Staging resolution:
      if (staged.length === 0) {
        // Nothing is staged yet
        if (!ctx.hasUI) {
          try {
            await stageAllFiles(cwd);
            const refreshed = await getWorkingTreeStatus(cwd);
            staged = refreshed.staged;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Failed to stage files: ${msg}\n`);
            return;
          }
        } else {
          const shouldStage = await ctx.ui.confirm(
            "Stage Changes",
            `No changes are currently staged (${unstaged.length} unstaged). Stage all files (git add -A)?`
          );
          if (!shouldStage) {
            ctx.ui.notify("Commit aborted (no staged changes).", "info");
            return;
          }

          try {
            await stageAllFiles(cwd);
            const refreshed = await getWorkingTreeStatus(cwd);
            staged = refreshed.staged;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to stage files: ${msg}`, "error");
            return;
          }
        }
      } else if (unstaged.length > 0) {
        // Both staged AND unstaged changes exist: ask user preference
        if (ctx.hasUI) {
          const optOnlyStaged = `Commit only staged changes (${staged.length} file${staged.length === 1 ? "" : "s"})`;
          const optStageAll = `Stage all and commit everything (${staged.length} staged + ${unstaged.length} unstaged)`;
          const optCancel = "Cancel";

          const choice = await ctx.ui.select(
            "Staged and unstaged changes detected",
            [optOnlyStaged, optStageAll, optCancel]
          );

          if (!choice || choice === optCancel) {
            ctx.ui.notify("Commit cancelled.", "info");
            return;
          }

          if (choice === optStageAll) {
            try {
              await stageAllFiles(cwd);
              const refreshed = await getWorkingTreeStatus(cwd);
              staged = refreshed.staged;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Failed to stage all files: ${msg}`, "error");
              return;
            }
          }
          // If optOnlyStaged was chosen, leave `staged` as-is
        }
      }

      if (staged.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("No changes detected to commit.", "warning");
        } else {
          process.stderr.write("No changes detected to commit.\n");
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

      const broadcaster = new CommitStatusBroadcaster("Fetching git overview…");
      let activeEditor: BlockingCommitEditor | undefined;
      const abortController = new AbortController();

      if (ctx.hasUI && typeof ctx.ui.setEditorComponent === "function") {
        ctx.ui.setEditorComponent((tui, editorTheme) => {
          activeEditor = new BlockingCommitEditor(tui, editorTheme, broadcaster, () => {
            abortController.abort();
          });
          return activeEditor;
        });
      }

      let proposal: CommitProposal | null = null;
      const tools = createCommitTools({
        cwd,
        onPropose: (prop) => {
          proposal = prop;
        },
      });

      let unsubscribe: (() => void) | undefined;
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

        unsubscribe = session.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            if (event.toolName === "git_overview") {
              broadcaster.update("Fetching git overview…");
            } else if (event.toolName === "git_file_diff") {
              const file = (event.args as any)?.filePath || "file";
              broadcaster.update(`Inspecting diff for ${file}…`);
            } else if (event.toolName === "propose_commit") {
              broadcaster.update("Formulating conventional commit…");
            }
          }
        });

        const userPrompt = args.trim()
          ? `User hint/instructions: "${args.trim()}". Inspect staged changes and propose conventional commit.`
          : "Inspect staged changes and propose conventional commit.";

        broadcaster.update("Inspecting git diffs…");
        await session.prompt(userPrompt);
        session.dispose();
      } catch (err) {
        if (abortController.signal.aborted) {
          ctx.ui.notify("Commit cancelled by user.", "info");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Commit agent failed: ${msg}`, "error");
        return;
      } finally {
        unsubscribe?.();
        activeEditor?.dispose();
        if (ctx.hasUI && typeof ctx.ui.setEditorComponent === "function") {
          ctx.ui.setEditorComponent(undefined);
        }
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
