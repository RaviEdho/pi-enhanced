import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createCommit,
  execGit,
  executeMultiCommit,
  getStagedOverview,
  getWorkingTreeStatus,
  isGitRepository,
  pushCommit,
  restoreStashedChanges,
  rollbackStashedChanges,
  stageAllFiles,
  stashStagedChanges,
  unstageAllFiles,
  type StashedState,
} from "./git.js";
import { CommitStatusBroadcaster } from "./editor.js";
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
        const cwd = ctx.cwd;

      const isSingle = /\b(--single|-s)\b/i.test(args);
      const isMulti = /\b(--multi|-m)\b/i.test(args);
      const isUnstaged = /\b(--unstaged|-u|--only-unstaged)\b/i.test(args);
      const cleanArgs = args
        .replace(/\b(--single|-s|--multi|-m|--unstaged|-u|--only-unstaged)\b/gi, "")
        .trim();

      // 1. Verify git repository
      const isRepo = await isGitRepository(cwd);
      if (!isRepo) {
        ctx.ui.notify("Current directory is not inside a git repository.", "error");
        return;
      }

      // 2. Ensure an active model is available
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) {
          ctx.ui.notify("No active model selected in Pi session.", "error");
        } else {
          process.stderr.write("No active model selected in Pi session.\n");
        }
        return;
      }

      // 3. Check working tree status (staged and unstaged)
      let { staged, unstaged } = await getWorkingTreeStatus(cwd);
      if (staged.length === 0 && unstaged.length === 0) {
        ctx.ui.notify("Working tree clean; no changes to commit.", "info");
        return;
      }

      type StagingAction =
        | { type: "none" }
        | { type: "stashed"; state: StashedState }
        | { type: "staged-all-from-clean" }
        | { type: "staged-all-with-existing"; initialIndexTree: string };

      let stagingAction: StagingAction = { type: "none" };

      const rollbackStagingIfNeeded = async (): Promise<string | undefined> => {
        const action = stagingAction;
        stagingAction = { type: "none" };

        if (action.type === "stashed") {
          try {
            await rollbackStashedChanges(action.state, cwd);
            return "Restored original staged and unstaged state.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const warnMsg = `Warning: Failed to restore stashed changes on abort: ${msg}. Your changes are preserved in 'git stash'.`;
            if (ctx.hasUI) ctx.ui.notify(warnMsg, "warning");
            else process.stderr.write(`[commit] ${warnMsg}\n`);
            return undefined;
          }
        } else if (action.type === "staged-all-from-clean") {
          try {
            await unstageAllFiles(cwd);
            return "Unstaged automatically staged changes.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[commit] Failed to unstage changes on cancel: ${msg}\n`);
            return undefined;
          }
        } else if (action.type === "staged-all-with-existing") {
          try {
            await execGit(["reset", "-q"], cwd);
            await execGit(["read-tree", action.initialIndexTree], cwd);
            return "Restored original staged and unstaged state.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[commit] Failed to restore original staging on cancel: ${msg}\n`);
            return undefined;
          }
        }
        return undefined;
      };

      const cancelCommit = async (msg: string) => {
        const rollbackMsg = await rollbackStagingIfNeeded();
        if (ctx.hasUI) {
          ctx.ui.notify(rollbackMsg ? `${msg}\n${rollbackMsg}` : msg, "info");
        } else {
          process.stdout.write(`[commit] ${msg}\n`);
          if (rollbackMsg) process.stdout.write(`[commit] ${rollbackMsg}\n`);
        }
      };

      const restoreStashOnSuccess = async (): Promise<string | undefined> => {
        const action = stagingAction;
        stagingAction = { type: "none" };

        if (action.type === "stashed") {
          try {
            await restoreStashedChanges(action.state, cwd);
            let msg = "Restored unfinalized staged changes.";
            if (action.state.decoupledFiles.length > 0) {
              const fileList = action.state.decoupledFiles.join(", ");
              msg += ` Re-staged unfinalized changes in ${fileList} on top of the new commit.`;
            }
            return msg;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const warnMsg = `Warning: Committed unstaged changes, but failed to restore stashed changes cleanly: ${msg}. Preserved in 'git stash'.`;
            if (ctx.hasUI) ctx.ui.notify(warnMsg, "warning");
            else process.stderr.write(`[commit] ${warnMsg}\n`);
            return undefined;
          }
        }
        return undefined;
      };

      // 4. Staging resolution:
      if (isUnstaged) {
        if (unstaged.length === 0) {
          if (ctx.hasUI) {
            ctx.ui.notify("No unstaged changes detected to commit.", "warning");
          } else {
            process.stderr.write("No unstaged changes detected to commit.\n");
          }
          return;
        }

        if (staged.length > 0) {
          try {
            const state = await stashStagedChanges(cwd);
            if (state) {
              if (ctx.hasUI && state.overlappingCollisions.length > 0) {
                const fileList = state.overlappingCollisions.join(", ");
                const proceed = await ctx.ui.confirm(
                  "Exact Line Collision Detected",
                  `"${fileList}" has edits on the exact same line in both staged and unstaged sets and cannot be cleanly separated.\n\nCommit all changes in "${fileList}" (keeping other staged files stashed)?`
                );
                if (!proceed) {
                  await rollbackStashedChanges(state, cwd);
                  ctx.ui.notify("Commit cancelled (overlapping line collision).", "info");
                  return;
                }
              }
              stagingAction = { type: "stashed", state };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const errMsg = `Failed to stash staged changes: ${msg}`;
            if (ctx.hasUI) ctx.ui.notify(errMsg, "error");
            else process.stderr.write(`${errMsg}\n`);
            return;
          }
        } else {
          stagingAction = { type: "staged-all-from-clean" };
        }

        try {
          await stageAllFiles(cwd);
          const refreshed = await getWorkingTreeStatus(cwd);
          staged = refreshed.staged;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const errMsg = `Failed to stage unstaged files: ${msg}`;
          if (ctx.hasUI) ctx.ui.notify(errMsg, "error");
          else process.stderr.write(`${errMsg}\n`);
          await rollbackStagingIfNeeded();
          return;
        }
      } else if (staged.length === 0) {
        // Nothing is staged yet
        if (!ctx.hasUI) {
          try {
            await stageAllFiles(cwd);
            stagingAction = { type: "staged-all-from-clean" };
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
            stagingAction = { type: "staged-all-from-clean" };
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
          const optOnlyUnstaged = `Commit only unstaged changes (${unstaged.length} file${unstaged.length === 1 ? "" : "s"}, stash staged)`;
          const optStageAll = `Stage all and commit everything (${staged.length} staged + ${unstaged.length} unstaged)`;
          const optCancel = "Cancel";

          const choice = await ctx.ui.select(
            "Staged and unstaged changes detected",
            [optOnlyStaged, optOnlyUnstaged, optStageAll, optCancel]
          );

          if (!choice || choice === optCancel) {
            ctx.ui.notify("Commit cancelled.", "info");
            return;
          }

          if (choice === optOnlyUnstaged) {
            try {
              const state = await stashStagedChanges(cwd);
              if (state) {
                if (state.overlappingCollisions.length > 0) {
                  const fileList = state.overlappingCollisions.join(", ");
                  const proceed = await ctx.ui.confirm(
                    "Exact Line Collision Detected",
                    `"${fileList}" has edits on the exact same line in both staged and unstaged sets and cannot be cleanly separated.\n\nCommit all changes in "${fileList}" (keeping other staged files stashed)?`
                  );
                  if (!proceed) {
                    await rollbackStashedChanges(state, cwd);
                    ctx.ui.notify("Commit cancelled (overlapping line collision).", "info");
                    return;
                  }
                }
                stagingAction = { type: "stashed", state };
              }
              await stageAllFiles(cwd);
              const refreshed = await getWorkingTreeStatus(cwd);
              staged = refreshed.staged;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Failed to isolate unstaged changes: ${msg}`, "error");
              await rollbackStagingIfNeeded();
              return;
            }
          } else if (choice === optStageAll) {
            try {
              const initialIndexTree = (await execGit(["write-tree"], cwd)).trim();
              await stageAllFiles(cwd);
              stagingAction = { type: "staged-all-with-existing", initialIndexTree };
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
        await rollbackStagingIfNeeded();
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
      if (stagingAction.type === "stashed") {
        let desc = "Stashed unfinalized staged changes to commit unstaged changes first";
        if (stagingAction.state.decoupledFiles.length > 0) {
          desc += ` (decoupled unstaged changes in ${stagingAction.state.decoupledFiles.join(", ")})`;
        }
        broadcaster.addAction({
          type: "info",
          description: desc,
        });
      }
      broadcaster.addAction({
        type: "overview",
        description: `Detected ${staged.length} staged file${staged.length === 1 ? "" : "s"}`,
      });

      let activeSession: any = undefined;
      const abortController = new AbortController();
      let isAborting = false;

      const handleAbort = async () => {
        if (isAborting) return;
        isAborting = true;
        abortController.abort();
        broadcaster.update("Cancelling commit agent…");
        if (activeSession) {
          try {
            await activeSession.abort();
          } catch {
            // ignore
          }
        }
      };

      const startTime = Date.now();
      const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let frameIndex = 0;
      let transientWarningTimer: NodeJS.Timeout | undefined;
      let transientWarningText: string | undefined;

      const triggerTransientWarning = (msg: string) => {
        transientWarningText = msg;
        if (transientWarningTimer) {
          clearTimeout(transientWarningTimer);
        }
        updateWorkingIndicator();
        transientWarningTimer = setTimeout(() => {
          transientWarningText = undefined;
          transientWarningTimer = undefined;
          updateWorkingIndicator();
        }, 3000);
        transientWarningTimer.unref?.();
      };

      const updateWorkingIndicator = () => {
        if (!ctx.hasUI) return;

        let line: string;
        if (transientWarningText) {
          const warnIcon = ctx.ui.theme?.fg ? ctx.ui.theme.fg("warning", "⚠") : "⚠";
          const warnMsg = ctx.ui.theme?.fg ? ctx.ui.theme.fg("warning", transientWarningText) : transientWarningText;
          line = `  ${warnIcon} ${warnMsg}`;
        } else {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const spinner = ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("accent", SPINNER_FRAMES[frameIndex])
            : SPINNER_FRAMES[frameIndex];
          const statusText = ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("text", broadcaster.status)
            : broadcaster.status;
          const elapsedText = ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("dim", `(${elapsed}s)`)
            : `(${elapsed}s)`;
          const cancelHint = ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("dim", "• Esc to cancel")
            : "• Esc to cancel";

          line = `  ${spinner} ${statusText} ${elapsedText}  ${cancelHint}`;
          frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
        }

        if (typeof ctx.ui.setWidget === "function") {
          ctx.ui.setWidget("commit", [line]);
        }
      };

      updateWorkingIndicator();
      const workingTimer = setInterval(updateWorkingIndicator, 80);
      workingTimer.unref?.();
      const unsubBroadcaster = broadcaster.subscribe(updateWorkingIndicator);

      const unsubTerminalInput = typeof ctx.ui.onTerminalInput === "function"
        ? ctx.ui.onTerminalInput((data) => {
            if (
              matchesKey(data, "escape") ||
              matchesKey(data, "esc") ||
              matchesKey(data, "ctrl+c") ||
              data === "\x1b" ||
              data === "\x03"
            ) {
              void handleAbort();
              return { consume: true };
            }
            if (matchesKey(data, "enter")) {
              triggerTransientWarning("Commit in progress. Press Esc to cancel it first.");
              return { consume: true };
            }
            return undefined;
          })
        : undefined;

      const cleanupWorkingIndicator = () => {
        if (transientWarningTimer) {
          clearTimeout(transientWarningTimer);
          transientWarningTimer = undefined;
        }
        clearInterval(workingTimer);
        unsubBroadcaster();
        unsubTerminalInput?.();
        if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
          ctx.ui.setWidget("commit", undefined);
        }
      };

      if (abortController.signal.aborted) {
        cleanupWorkingIndicator();
        await cancelCommit("Commit cancelled by user.");
        return;
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
        signal: abortController.signal,
      });

      let turnCount = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let totalTokens = 0;
      let totalCost = 0;

      let unsubscribe: (() => void) | undefined;
      let overview = await getStagedOverview(cwd);

      if (abortController.signal.aborted) {
        cleanupWorkingIndicator();
        await cancelCommit("Commit cancelled by user.");
        return;
      }

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

        if (abortController.signal.aborted) {
          await cancelCommit("Commit cancelled by user.");
          return;
        }

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

        if (abortController.signal.aborted) {
          try {
            session.dispose();
          } catch {
            // ignore
          }
          activeSession = undefined;
          await cancelCommit("Commit cancelled by user.");
          return;
        }

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
        if (cleanArgs) {
          userPrompt = `User hint/instructions: "${cleanArgs}". Inspect staged changes and propose conventional commit(s).`;
        }
        if (isSingle) {
          userPrompt += " Please consolidate all staged changes into a single conventional commit proposal (propose_commit).";
        } else if (isMulti) {
          userPrompt += " Please split staged changes into logical atomic commits (propose_commits).";
        }

        broadcaster.update("Inspecting git diffs…");

        const abortPromise = new Promise<void>((_, reject) => {
          if (abortController.signal.aborted) {
            reject(new Error("Commit cancelled by user."));
          } else {
            abortController.signal.addEventListener(
              "abort",
              () => reject(new Error("Commit cancelled by user.")),
              { once: true }
            );
          }
        });

        try {
          await Promise.race([session.prompt(userPrompt), abortPromise]);
        } finally {
          if (abortController.signal.aborted) {
            void session.abort().catch(() => {}).finally(() => {
              try {
                session.dispose();
              } catch {
                // ignore
              }
            });
            activeSession = undefined;
          } else {
            session.dispose();
            activeSession = undefined;
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          await cancelCommit("Commit cancelled by user.");
          return;
        }
        await rollbackStagingIfNeeded();
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Commit agent failed: ${msg}`, "error");
        return;
      } finally {
        unsubscribe?.();
        cleanupWorkingIndicator();
      }

      if (abortController.signal.aborted) {
        await cancelCommit("Commit cancelled by user.");
        return;
      }

      // 5. Verify captured proposal
      const capturedPlan = plan as CommitPlanProposal | null;
      if (!capturedPlan || capturedPlan.stages.length === 0) {
        const rollbackMsg = await rollbackStagingIfNeeded();
        const warnMsg = "Commit agent completed without proposing a message.";
        ctx.ui.notify(rollbackMsg ? `${warnMsg}\n${rollbackMsg}` : warnMsg, "warning");
        return;
      }
      let commitPlan: CommitPlanProposal = capturedPlan;

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
      const executeCommitSequence = async (stages: CommitProposal[], shouldPush: boolean): Promise<boolean> => {
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
            return false;
          }

          let pushFailedMsg: string | undefined;
          if (shouldPush) {
            try {
              ctx.ui.setWorkingMessage?.("Pushing commit to remote…");
              await pushCommit(cwd);
            } catch (err) {
              pushFailedMsg = err instanceof Error ? err.message : String(err);
            } finally {
              ctx.ui.setWorkingMessage?.();
            }
          }

          const restoreMsg = await restoreStashOnSuccess();

          if (shouldPush) {
            if (pushFailedMsg) {
              const baseMsg = `Committed, but push failed: ${pushFailedMsg}`;
              ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "error");
            } else {
              const baseMsg = `Committed and pushed: ${header} • ${costBadge}`;
              ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "info");
            }
          } else {
            const baseMsg = `Committed: ${header} • ${costBadge}`;
            ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "info");
          }
          return true;
        } else {
          try {
            ctx.ui.setWorkingMessage?.(`Committing 1/${stages.length} stages…`);
            const res = await executeMultiCommit(stages, cwd, (stageIdx, total, header) => {
              ctx.ui.setWorkingMessage?.(`Committing stage ${stageIdx}/${total}: ${header}…`);
            });

            let pushFailedMsg: string | undefined;
            if (shouldPush) {
              try {
                ctx.ui.setWorkingMessage?.("Pushing commits to remote…");
                await pushCommit(cwd);
              } catch (err) {
                pushFailedMsg = err instanceof Error ? err.message : String(err);
              } finally {
                ctx.ui.setWorkingMessage?.();
              }
            }

            const restoreMsg = await restoreStashOnSuccess();

            if (shouldPush) {
              if (pushFailedMsg) {
                const baseMsg = `Committed ${res.committedCount} stages, but push failed: ${pushFailedMsg}`;
                ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "error");
              } else {
                const baseMsg = `Committed (${res.committedCount} stages) and pushed • ${costBadge}`;
                ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "info");
              }
            } else {
              const baseMsg = `Committed ${res.committedCount} atomic commit(s) • ${costBadge}`;
              ctx.ui.notify(restoreMsg ? `${baseMsg}\n${restoreMsg}` : baseMsg, "info");
            }
            return true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Multi-stage commit failed: ${msg}`, "error");
            return false;
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
          ? formatCost(usage.totalCost)
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
            const restoreMsg = await restoreStashOnSuccess();
            if (restoreMsg) {
              process.stdout.write(`[commit] ${restoreMsg}\n`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Multi-stage commit failed: ${msg}\n`);
            await rollbackStagingIfNeeded();
          }
        } else {
          const single = commitPlan.stages[0];
          const fullMessage = single.body?.trim() ? `${firstHeaderLine}\n\n${single.body.trim()}` : firstHeaderLine;
          process.stdout.write(`[commit] Message:\n  ${fullMessage.split("\n").join("\n  ")}\n\n`);
          try {
            await createCommit(fullMessage, cwd);
            process.stdout.write(`Committed: ${firstHeaderLine}\n`);
            const restoreMsg = await restoreStashOnSuccess();
            if (restoreMsg) {
              process.stdout.write(`[commit] ${restoreMsg}\n`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Commit failed: ${msg}\n`);
            await rollbackStagingIfNeeded();
          }
        }
        return;
      }

      // 7. Interactive UI Mode
      const costBadge = formatCostBadge(usage);

      while (true) {
        const isCurrentMultiStage = commitPlan.stages.length > 1;
        const currentFirstHeader = commitPlan.stages[0]?.scope
          ? `${commitPlan.stages[0].type}(${commitPlan.stages[0].scope}): ${commitPlan.stages[0].subject}`
          : `${commitPlan.stages[0]?.type}: ${commitPlan.stages[0]?.subject}`;

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

        if (customUIAttempted) {
          if (!userChoice || userChoice.action === "cancel") {
            await cancelCommit(`Commit cancelled (${costBadge} used).`);
            return;
          }
        } else {
          // Fallback selector ONLY if custom UI is not available
          let actionCommit: string;
          let actionPush: string;
          const actionEdit = isCurrentMultiStage ? "Edit commit plan" : "Edit commit message";

          if (isCurrentMultiStage) {
            actionCommit = `Commit all ${commitPlan.stages.length} stages (${costBadge})`;
            actionPush = `Commit & Push all ${commitPlan.stages.length} stages (${costBadge})`;
          } else {
            actionCommit = `Commit: "${currentFirstHeader}" (${costBadge})`;
            actionPush = `Commit & Push: "${currentFirstHeader}" (${costBadge})`;
          }

          const choice = await ctx.ui.select(`Commit Proposal (${costBadge})`, [
            actionCommit,
            actionPush,
            actionEdit,
          ]);

          if (!choice) {
            await cancelCommit(`Commit cancelled (${costBadge} used).`);
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
          await cancelCommit(`Commit cancelled (${costBadge} used).`);
          return;
        }

        if (userChoice.action === "edit") {
          const stagesToEdit = userChoice.stages || commitPlan.stages;
          const editBuffer = isCurrentMultiStage
            ? formatPlanForEditor(stagesToEdit)
            : (stagesToEdit[0]?.body?.trim() ? `${currentFirstHeader}\n\n${stagesToEdit[0].body.trim()}` : currentFirstHeader);

          let edited: string | undefined;
          if (typeof ctx.ui.editor === "function") {
            edited = await ctx.ui.editor(isCurrentMultiStage ? "Edit commit plan" : "Edit commit message", editBuffer);
          } else {
            edited = await ctx.ui.input(isCurrentMultiStage ? "Edit commit plan" : "Edit commit message", editBuffer);
          }

          if (!edited || !edited.trim()) {
            await cancelCommit("Commit cancelled (empty message).");
            return;
          }

          const newStages = parsePlanFromEditor(edited);
          if (newStages.length === 0) {
            const rollbackMsg = await rollbackStagingIfNeeded();
            const warnMsg = "No valid commits found in edited text; commit cancelled.";
            ctx.ui.notify(rollbackMsg ? `${warnMsg}\n${rollbackMsg}` : warnMsg, "warning");
            return;
          }

          commitPlan = {
            ...commitPlan,
            stages: newStages,
          };
          continue;
        }

        const stagesToRun = userChoice.stages || commitPlan.stages;
        const success = await executeCommitSequence(stagesToRun, userChoice.action === "commit-and-push");
        if (!success) {
          await rollbackStagingIfNeeded();
        }
        return;
      }
      } finally {
        isCommitActive = false;
      }
    },
  });
}
