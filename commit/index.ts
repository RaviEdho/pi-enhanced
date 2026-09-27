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
  executeMultiCommit,
  getStagedOverview,
  getWorkingTreeStatus,
  isGitRepository,
  pushCommit,
  stageAllFiles,
} from "./git.js";
import { BlockingCommitEditor, CommitStatusBroadcaster } from "./editor.js";
import { CommitConfirmationDialog } from "./dialog.js";
import {
  formatCost,
  formatCostBadge,
  formatDuration,
  formatPlanForEditor,
  parsePlanFromEditor,
} from "./format.js";
import { COMMIT_AGENT_SYSTEM_PROMPT } from "./prompt.js";
import { createCommitTools } from "./tools.js";
import type {
  CommitConfirmationResult,
  CommitPlanProposal,
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
      let activeSession: any = undefined;
      const abortController = new AbortController();

      const handleAbort = async () => {
        abortController.abort();
        if (activeSession) {
          try {
            await activeSession.abort();
          } catch {
            // ignore
          }
        }
      };

      if (ctx.hasUI && typeof ctx.ui.setEditorComponent === "function") {
        ctx.ui.setEditorComponent((tui, editorTheme) => {
          activeEditor = new BlockingCommitEditor(
            tui,
            editorTheme,
            broadcaster,
            () => {
              void handleAbort();
            },
            ctx.ui.theme
          );
          return activeEditor;
        });
      }

      let plan: CommitPlanProposal | null = null;
      const diffedFiles: string[] = [];
      const tools = createCommitTools({
        cwd,
        onPropose: (propPlan) => {
          plan = propPlan;
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
          tools: ["git_overview", "git_file_diff", "propose_commit", "propose_commits"],
          customTools: tools,
        });
        activeSession = session;

        unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_start") {
            turnCount++;
          } else if (event.type === "tool_execution_start") {
            if (event.toolName === "git_overview") {
              broadcaster.update("Fetching git overview…");
            } else if (event.toolName === "git_file_diff") {
              const file = (event.args as any)?.filePath || "file";
              broadcaster.update(`Inspecting diff for ${file}…`);
            } else if (event.toolName === "propose_commit" || event.toolName === "propose_commits") {
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

        let userPrompt = "Inspect staged changes and propose conventional commit(s).";
        if (args.trim()) {
          const isSingle = /\b(--single|-s)\b/i.test(args);
          const isMulti = /\b(--multi|-m)\b/i.test(args);
          const cleanArgs = args.replace(/\b(--single|-s|--multi|-m)\b/gi, "").trim();

          userPrompt = cleanArgs
            ? `User hint/instructions: "${cleanArgs}". Inspect staged changes and propose conventional commit(s).`
            : userPrompt;

          if (isSingle) {
            userPrompt += " Please consolidate all staged changes into a single conventional commit proposal (propose_commit).";
          } else if (isMulti) {
            userPrompt += " Please split staged changes into logical atomic commits (propose_commits).";
          }
        }

        broadcaster.update("Inspecting git diffs…");
        await session.prompt(userPrompt);
        session.dispose();
        activeSession = undefined;
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

      if (abortController.signal.aborted) {
        ctx.ui.notify("Commit cancelled by user.", "info");
        return;
      }

      // 5. Verify captured proposal
      const capturedPlan = plan as CommitPlanProposal | null;
      if (!capturedPlan || capturedPlan.stages.length === 0) {
        ctx.ui.notify("Commit agent completed without proposing a message.", "warning");
        return;
      }
      const commitPlan: CommitPlanProposal = capturedPlan;

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

      // Refetch overview for updated details
      overview = await getStagedOverview(cwd);

      const isMultiStage = commitPlan.isMultiStage && commitPlan.stages.length > 1;

      // Primary header line for display
      const firstStage = commitPlan.stages[0];
      const firstType = firstStage.type.trim().toLowerCase();
      const firstScope = firstStage.scope?.trim().toLowerCase();
      const firstSubject = firstStage.subject.trim().replace(/\.$/, "");
      const firstHeaderLine = firstScope ? `${firstType}(${firstScope}): ${firstSubject}` : `${firstType}: ${firstSubject}`;

      // Helper function to execute the commits and optional push
      const executeCommitSequence = async (stages: CommitProposal[], shouldPush: boolean) => {
        if (stages.length === 1) {
          const single = stages[0];
          const type = single.type.trim().toLowerCase();
          const scope = single.scope?.trim().toLowerCase();
          const subject = single.subject.trim().replace(/\.$/, "");
          const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
          const fullMsg = single.body?.trim() ? `${header}\n\n${single.body.trim()}` : header;

          try {
            await createCommit(fullMsg, cwd);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Commit failed: ${msg}`, "error");
            return;
          }

          if (shouldPush) {
            try {
              ctx.ui.setWorkingMessage?.("Pushing commit to remote…");
              await pushCommit(cwd);
              ctx.ui.notify(`Committed and pushed: ${header} • ${costBadge}`, "info");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Committed, but push failed: ${msg}`, "error");
            } finally {
              ctx.ui.setWorkingMessage?.();
            }
          } else {
            ctx.ui.notify(`Committed: ${header} • ${costBadge}`, "info");
          }
        } else {
          try {
            ctx.ui.setWorkingMessage?.(`Committing 1/${stages.length} stages…`);
            const res = await executeMultiCommit(stages, cwd, (stageIdx, total, header) => {
              ctx.ui.setWorkingMessage?.(`Committing stage ${stageIdx}/${total}: ${header}…`);
            });

            if (shouldPush) {
              try {
                ctx.ui.setWorkingMessage?.("Pushing commits to remote…");
                await pushCommit(cwd);
                ctx.ui.notify(`Committed (${res.committedCount} stages) and pushed • ${costBadge}`, "info");
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.ui.notify(`Committed ${res.committedCount} stages, but push failed: ${msg}`, "error");
              } finally {
                ctx.ui.setWorkingMessage?.();
              }
            } else {
              ctx.ui.notify(`Committed ${res.committedCount} atomic commit(s) • ${costBadge}`, "info");
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Multi-stage commit failed: ${msg}`, "error");
          } finally {
            ctx.ui.setWorkingMessage?.();
          }
        }
      };

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

        if (isMultiStage) {
          process.stdout.write(`[commit] Planned ${commitPlan.stages.length} atomic stages:\n`);
          for (let i = 0; i < commitPlan.stages.length; i++) {
            const s = commitPlan.stages[i];
            const h = s.scope ? `${s.type}(${s.scope}): ${s.subject}` : `${s.type}: ${s.subject}`;
            const f = s.files?.length ? ` (${s.files.length} file${s.files.length === 1 ? "" : "s"})` : "";
            process.stdout.write(`  ${i + 1}. ${h}${f}\n`);
          }
          process.stdout.write("\n");
          try {
            const res = await executeMultiCommit(commitPlan.stages, cwd, (idx, total, h) => {
              process.stdout.write(`[commit] (${idx}/${total}) Committed: ${h}\n`);
            });
            process.stdout.write(`Completed ${res.committedCount} atomic commit(s).\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Multi-stage commit failed: ${msg}\n`);
          }
        } else {
          const single = commitPlan.stages[0];
          const fullMessage = single.body?.trim() ? `${firstHeaderLine}\n\n${single.body.trim()}` : firstHeaderLine;
          process.stdout.write(`[commit] Message:\n  ${fullMessage.split("\n").join("\n  ")}\n\n`);
          try {
            await createCommit(fullMessage, cwd);
            process.stdout.write(`Committed: ${firstHeaderLine}\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Commit failed: ${msg}\n`);
          }
        }
        return;
      }

      // 7. Interactive UI Mode
      const costBadge = formatCostBadge(usage);

      let userChoice: CommitConfirmationResult | undefined;
      let customUIAttempted = false;

      if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        customUIAttempted = true;
        try {
          userChoice = await ctx.ui.custom<CommitConfirmationResult>((tui, theme, keybindings, done) => {
            return new CommitConfirmationDialog(
              tui,
              theme,
              {
                plan: commitPlan,
                actions: broadcaster.recentActions,
                overview,
                diffedFiles,
                usage,
                onDone: (res) => done(res),
              },
              keybindings
            );
          });
        } catch {
          customUIAttempted = false;
          userChoice = undefined;
        }
      }

      // If custom UI was used, cancel immediately on escape or cancel action
      if (customUIAttempted) {
        if (!userChoice || userChoice.action === "cancel") {
          ctx.ui.notify(`Commit cancelled (${costBadge} used).`, "info");
          return;
        }
      } else {
        // Fallback selector ONLY if custom UI is not available
        let actionCommit: string;
        let actionPush: string;
        const actionEdit = isMultiStage ? "Edit commit plan" : "Edit commit message";
        const actionCancel = "Cancel";

        if (isMultiStage) {
          actionCommit = `Commit all ${commitPlan.stages.length} stages (${costBadge})`;
          actionPush = `Commit & Push all ${commitPlan.stages.length} stages (${costBadge})`;
        } else {
          actionCommit = `Commit: "${firstHeaderLine}" (${costBadge})`;
          actionPush = `Commit & Push: "${firstHeaderLine}" (${costBadge})`;
        }

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
          userChoice = { action: "edit", stages: commitPlan.stages };
        } else if (choice === actionPush) {
          userChoice = { action: "commit-and-push", stages: commitPlan.stages };
        } else {
          userChoice = { action: "commit", stages: commitPlan.stages };
        }
      }

      if (userChoice.action === "cancel") {
        ctx.ui.notify(`Commit cancelled (${costBadge} used).`, "info");
        return;
      }

      if (userChoice.action === "edit") {
        const stagesToEdit = userChoice.stages || commitPlan.stages;
        const editBuffer = isMultiStage
          ? formatPlanForEditor(stagesToEdit)
          : (stagesToEdit[0]?.body?.trim() ? `${firstHeaderLine}\n\n${stagesToEdit[0].body.trim()}` : firstHeaderLine);

        let edited: string | undefined;
        if (typeof ctx.ui.editor === "function") {
          edited = await ctx.ui.editor(isMultiStage ? "Edit commit plan" : "Edit commit message", editBuffer);
        } else {
          edited = await ctx.ui.input(isMultiStage ? "Edit commit plan" : "Edit commit message", editBuffer);
        }

        if (!edited || !edited.trim()) {
          ctx.ui.notify("Empty message/plan; commit cancelled.", "info");
          return;
        }

        const newStages = parsePlanFromEditor(edited);
        if (newStages.length === 0) {
          ctx.ui.notify("No valid commits found in edited text; commit cancelled.", "warning");
          return;
        }

        const commitLabel = newStages.length === 1
          ? `Commit: "${newStages[0].subject}"`
          : `Commit all ${newStages.length} stages`;
        const pushLabel = newStages.length === 1
          ? `Commit & Push: "${newStages[0].subject}"`
          : `Commit & Push all ${newStages.length} stages`;

        const postEditChoice = await ctx.ui.select("Action for edited commit(s)", [
          commitLabel,
          pushLabel,
          "Cancel",
        ]);

        if (!postEditChoice || postEditChoice === "Cancel") {
          ctx.ui.notify("Commit cancelled.", "info");
          return;
        }

        await executeCommitSequence(newStages, postEditChoice === pushLabel);
        return;
      }

      const stagesToRun = userChoice.stages || commitPlan.stages;
      await executeCommitSequence(stagesToRun, userChoice.action === "commit-and-push");
    },
  });
}
