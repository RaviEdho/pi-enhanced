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
  getStagedOverview,
  getWorkingTreeStatus,
  isGitRepository,
  pushCommit,
  stageAllFiles,
} from "./git.js";
import { BlockingCommitEditor, CommitStatusBroadcaster } from "./editor.js";
import { CommitConfirmationDialog } from "./dialog.js";
import { formatCost, formatCostBadge, formatDuration } from "./format.js";
import { COMMIT_AGENT_SYSTEM_PROMPT } from "./prompt.js";
import { createCommitTools } from "./tools.js";
import type {
  CommitConfirmationResult,
  CommitProposal,
  CommitUsageCost,
} from "./types.js";

export function registerCommitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("commit", {
    description: "Autonomously inspect git diff and generate a commit",
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

      const isSub =
        model.provider === "openai-codex" ||
        model.provider === "google-antigravity" ||
        model.provider === "kimi-coding" ||
        model.provider === "github-copilot" ||
        (ctx.modelRegistry as any)?.isUsingSubscription?.(model.provider) === true;

      const modelIdString = `${model.provider}/${model.id}`;
      const broadcaster = new CommitStatusBroadcaster("Fetching git overview…", modelIdString);
      broadcaster.setIsSubscription(isSub);
      broadcaster.addAction({
        type: "overview",
        description: `Detected ${staged.length} staged file${staged.length === 1 ? "" : "s"}`,
      });

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
      const diffedFiles: string[] = [];
      const tools = createCommitTools({
        cwd,
        onPropose: (prop) => {
          proposal = prop;
        },
        onAction: (action) => {
          broadcaster.addAction(action);
        },
        diffedFiles,
      });

      let turnCount = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let totalTokens = 0;
      let totalCost = 0;
      const startTime = Date.now();

      let unsubscribe: (() => void) | undefined;
      let overview = await getStagedOverview(cwd);

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
          if (event.type === "turn_start") {
            turnCount++;
          } else if (event.type === "tool_execution_start") {
            if (event.toolName === "git_overview") {
              broadcaster.update("Fetching git overview…");
            } else if (event.toolName === "git_file_diff") {
              const file = (event.args as any)?.filePath || "file";
              broadcaster.update(`Inspecting diff for ${file}…`);
            } else if (event.toolName === "propose_commit") {
              broadcaster.update("Formulating commit proposal…");
            }
          } else if (event.type === "message_end") {
            if (event.message.role === "assistant" && event.message.usage) {
              const u = event.message.usage;
              inputTokens += u.input || 0;
              outputTokens += u.output || 0;
              reasoningTokens += u.reasoning || 0;
              cacheReadTokens += u.cacheRead || 0;
              cacheWriteTokens += u.cacheWrite || 0;
              totalTokens += u.totalTokens || ((u.input || 0) + (u.output || 0));

              if (u.cost && typeof u.cost.total === "number" && u.cost.total > 0) {
                totalCost += u.cost.total;
              } else if (model.cost) {
                const turnCost =
                  ((u.input || 0) / 1_000_000) * (model.cost.input || 0) +
                  ((u.output || 0) / 1_000_000) * (model.cost.output || 0) +
                  ((u.cacheRead || 0) / 1_000_000) * (model.cost.cacheRead || 0) +
                  ((u.cacheWrite || 0) / 1_000_000) * (model.cost.cacheWrite || 0);
                totalCost += turnCost;
              }
              broadcaster.updateUsage(totalTokens, totalCost);
            }
          }
        });

        const userPrompt = args.trim()
          ? `User hint/instructions: "${args.trim()}". Inspect staged changes and propose commit.`
          : "Inspect staged changes and propose commit.";

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

      // Fallback calculation for totalCost if model has rates but was not populated
      if (totalCost === 0 && model.cost && (model.cost.input > 0 || model.cost.output > 0)) {
        totalCost =
          (inputTokens / 1_000_000) * (model.cost.input || 0) +
          (outputTokens / 1_000_000) * (model.cost.output || 0) +
          (cacheReadTokens / 1_000_000) * (model.cost.cacheRead || 0) +
          (cacheWriteTokens / 1_000_000) * (model.cost.cacheWrite || 0);
      }

      const durationMs = Date.now() - startTime;
      const usage: CommitUsageCost = {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        totalCost,
        turns: Math.max(1, turnCount),
        durationMs,
        modelId: modelIdString,
        provider: model.provider,
        isSubscription: isSub,
      };

      const prop = proposal as CommitProposal;
      const type = prop.type.trim().toLowerCase();
      const scope = prop.scope?.trim().toLowerCase();
      const subject = prop.subject.trim().replace(/\.$/, "");
      const headerLine = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;

      const fullMessage = prop.body?.trim()
        ? `${headerLine}\n\n${prop.body.trim()}`
        : headerLine;

      // Refetch overview for updated details
      overview = await getStagedOverview(cwd);

      // 6. Non-interactive CLI mode
      if (!ctx.hasUI) {
        process.stdout.write(`\n[commit] Actions Summary:\n`);
        process.stdout.write(`  • Staged: ${overview.stagedFiles.length} file(s) (${overview.statSummary || "changes"})\n`);
        if (diffedFiles.length > 0) {
          process.stdout.write(`  • Diffed: ${diffedFiles.join(", ")}\n`);
        }
        process.stdout.write(`[commit] Cost & Usage:\n`);
        process.stdout.write(`  • Model: ${usage.modelId} (${usage.turns} turn${usage.turns === 1 ? "" : "s"} in ${formatDuration(usage.durationMs)})\n`);
        process.stdout.write(`  • Tokens: ${usage.totalTokens.toLocaleString()} total (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()})\n`);
        const costStr = usage.totalCost > 0
          ? `$${formatCost(usage.totalCost)}`
          : (usage.isSubscription ? "Included with subscription" : "$0.00");
        process.stdout.write(`  • Cost: ${costStr}\n`);
        process.stdout.write(`[commit] Message:\n  ${fullMessage.split("\n").join("\n  ")}\n\n`);

        try {
          await createCommit(fullMessage, cwd);
          process.stdout.write(`Committed: ${headerLine}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Commit failed: ${msg}\n`);
        }
        return;
      }

      // 7. Interactive UI Mode
      const costBadge = formatCostBadge(usage);

      let userChoice: CommitConfirmationResult | undefined;
      if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        try {
          userChoice = await ctx.ui.custom<CommitConfirmationResult>((tui, theme, _keybindings, done) => {
            return new CommitConfirmationDialog(tui, theme, {
              proposal: prop,
              actions: broadcaster.recentActions,
              overview,
              diffedFiles,
              usage,
              onDone: (res) => done(res),
            });
          });
        } catch {
          userChoice = undefined;
        }
      }

      // Fallback selector if custom UI is not available
      if (!userChoice) {
        const actionCommit = `Commit: "${headerLine}" (${costBadge})`;
        const actionPush = `Commit & Push: "${headerLine}" (${costBadge})`;
        const actionEdit = "Edit commit message";
        const actionCancel = "Cancel";

        const choice = await ctx.ui.select(`Commit Proposal (${costBadge})`, [
          actionCommit,
          actionPush,
          actionEdit,
          actionCancel,
        ]);

        if (!choice || choice === actionCancel) {
          ctx.ui.notify(`Commit cancelled (${costBadge} used).`, "info");
          return;
        }

        if (choice === actionEdit) {
          userChoice = { action: "edit", message: fullMessage };
        } else if (choice === actionPush) {
          userChoice = { action: "commit-and-push", message: fullMessage };
        } else {
          userChoice = { action: "commit", message: fullMessage };
        }
      }

      if (userChoice.action === "cancel") {
        ctx.ui.notify(`Commit cancelled (${costBadge} used).`, "info");
        return;
      }

      if (userChoice.action === "edit") {
        let edited: string | undefined;
        if (typeof ctx.ui.editor === "function") {
          edited = await ctx.ui.editor("Edit commit message", fullMessage);
        } else {
          edited = await ctx.ui.input("Edit commit message", fullMessage);
        }

        if (!edited || !edited.trim()) {
          ctx.ui.notify("Empty message; commit cancelled.", "info");
          return;
        }

        const trimmed = edited.trim();
        const firstLine = trimmed.split("\n")[0];

        const postEditChoice = await ctx.ui.select("Action for edited commit", [
          `Commit: "${firstLine}"`,
          `Commit & Push: "${firstLine}"`,
          "Cancel",
        ]);

        if (!postEditChoice || postEditChoice === "Cancel") {
          ctx.ui.notify("Commit cancelled.", "info");
          return;
        }

        const shouldPush = postEditChoice.startsWith("Commit & Push");

        try {
          await createCommit(trimmed, cwd);
          ctx.ui.notify(`Committed: ${firstLine} • ${costBadge}`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Commit failed: ${msg}`, "error");
          return;
        }

        if (shouldPush) {
          try {
            ctx.ui.setWorkingMessage?.("Pushing to remote…");
            await pushCommit(cwd);
            ctx.ui.notify("Pushed commit to remote.", "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Committed, but push failed: ${msg}`, "error");
          } finally {
            ctx.ui.setWorkingMessage?.();
          }
        }
        return;
      }

      if (userChoice.action === "commit-and-push") {
        try {
          await createCommit(fullMessage, cwd);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Commit failed: ${msg}`, "error");
          return;
        }

        try {
          ctx.ui.setWorkingMessage?.("Pushing to remote…");
          await pushCommit(cwd);
          ctx.ui.notify(`Committed and pushed: ${headerLine} • ${costBadge}`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Committed, but push failed: ${msg}`, "error");
        } finally {
          ctx.ui.setWorkingMessage?.();
        }
        return;
      }

      // userChoice.action === "commit"
      try {
        await createCommit(fullMessage, cwd);
        ctx.ui.notify(`Committed: ${headerLine} • ${costBadge}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Commit failed: ${msg}`, "error");
      }
    },
  });
}
