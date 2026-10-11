import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { jobManager } from "./jobs.js";
import { runSubagent } from "./runner.js";
import {
  type BackgroundJob,
  MAX_SUBAGENT_OUTPUT_CHARS,
  type SubagentResult,
} from "./types.js";

const SubagentParametersSchema = Type.Object({
  task: Type.String({
    description: "Detailed instructions or prompt for the subagent to perform in its isolated context.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Short human-readable summary of the subagent's task (e.g. 'Inspect auth middleware').",
    })
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional list of tools the subagent is allowed to use. Available tools include 'read', 'bash', 'edit', 'write', 'find', 'grep', 'multi_grep', 'web_search', 'web_fetch'. Defaults to all available tools.",
    })
  ),
  maxTurns: Type.Optional(
    Type.Number({
      description:
        "Optional maximum turns limit before automatically terminating (default: 25).",
    })
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Optional timeout in milliseconds before automatically terminating (default: 300000 = 5m).",
    })
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Whether to run in the background. Defaults to true (runs non-blocking in the background, returning immediately with a jobId). Set to false to run synchronously and block until finished.",
      default: true,
    })
  ),
});

export function createSubagentToolDefinition(): ToolDefinition<typeof SubagentParametersSchema, any> {
  return {
    name: "subagent",
    label: "subagent",
    description:
      "Delegate a task to an isolated subagent with its own clean context window. Inherits the current model and thinking effort of the parent session. Runs in the background by default (non-blocking, returns jobId) or synchronously (blocking with background: false).",
    parameters: SubagentParametersSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.model) {
        return {
          content: [
            {
              type: "text",
              text: "Subagent error: No active model selected in Pi session. Please select a model first.",
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      jobManager.setUIContext(ctx.ui);

      // Determine execution mode (defaults to background unless explicitly set to false)
      const isBackground = params.background !== false;

      // Non-blocking background execution
      if (isBackground) {
        const startResult = jobManager.startJob({
          task: params.task,
          description: params.description,
          tools: params.tools,
          maxTurns: params.maxTurns,
          timeoutMs: params.timeoutMs,
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel ?? "off",
          modelRuntime: (ctx.modelRegistry as any)?.runtime,
          deliverAsFollowUp: true,
        });

        if (!startResult.ok) {
          return {
            content: [{ type: "text", text: `Failed to spawn background subagent: ${startResult.error}` }],
            details: undefined,
            isError: true,
          };
        }

        const job = startResult.job;
        return {
          content: [
            {
              type: "text",
              text: `Background subagent spawned successfully.\nJob ID: ${job.id}\nTask: "${job.description}"\n\nYou can continue working immediately on other tasks. Once the subagent finishes, its results will be delivered automatically as a follow-up message into this session. Avoid polling 'subagent_status' rapidly in a tight loop—consecutive polls incur escalating wait cooldowns.`,
            },
          ],
          details: { jobId: job.id, status: "running" },
        };
      }

      // Synchronous blocking execution
      try {
        const result = await runSubagent({
          task: params.task,
          description: params.description,
          tools: params.tools,
          maxTurns: params.maxTurns,
          timeoutMs: params.timeoutMs,
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel ?? "off",
          modelRuntime: (ctx.modelRegistry as any)?.runtime,
          signal,
          onUpdate: (prog) => {
            onUpdate?.({
              content: [{ type: "text", text: `[subagent] ${prog.status}` }],
              details: prog,
            });
          },
        });

        let output = result.output;
        if (output.length > MAX_SUBAGENT_OUTPUT_CHARS) {
          output =
            output.slice(0, MAX_SUBAGENT_OUTPUT_CHARS) +
            `\n\n... [Output truncated (${result.output.length} characters total)] ...`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: result,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Subagent error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("subagent "));
      if (args?.background === false) {
        text += theme.fg("warning", "[sync] ");
      } else {
        text += theme.fg("dim", "[bg] ");
      }
      const label = args?.description || (args?.task ? args.task.slice(0, 60).replace(/\n/g, " ") : "");
      if (label) {
        text += theme.fg("muted", `"${label}"`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) {
        const prog = result.details as any;
        const status = prog?.status || "Executing…";
        return new Text(theme.fg("accent", `⠋ ${status}`), 0, 0);
      }

      if (result.isError) {
        const errText = result.content[0]?.type === "text" ? result.content[0].text : "Subagent failed";
        return new Text(theme.fg("error", `✖ ${errText}`), 0, 0);
      }

      const details = result.details as SubagentResult | { jobId: string; status: string } | undefined;
      if (details && "jobId" in details && details.status === "running") {
        return new Text(
          `${theme.fg("accent", "⚡")} ${theme.fg("muted", `Background subagent [${details.jobId}] active`)}`,
          0,
          0
        );
      }

      const subResult = details as SubagentResult | undefined;
      const durationSec = subResult ? (subResult.durationMs / 1000).toFixed(1) : "0.0";
      const turns = subResult?.turns ?? 1;
      const tokens = subResult?.usage?.totalTokens ?? 0;
      const isEscalated = !!subResult?.escalation;
      const icon = isEscalated ? "⚠️" : "✔";
      const statusColor = isEscalated ? "warning" : "muted";

      let summary = `${theme.fg(statusColor, icon)} ${theme.fg("muted", `Completed in ${durationSec}s (${turns} turns, ${tokens.toLocaleString()} tokens)`)}`;
      if (isEscalated && subResult?.escalation) {
        summary += ` ${theme.fg("warning", `[${subResult.escalation.reason}]`)}`;
      }

      if (expanded) {
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";
        summary += `\n${theme.fg("dim", "─".repeat(40))}\n${outputText}`;
      }

      return new Text(summary, 0, 0);
    },
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let consecutiveStatusPollCount = 0;
let lastPolledJobId: string | undefined;

/**
 * Records tool execution to reset consecutive status poll counter when other tools run.
 */
export function recordToolExecution(toolName: string): void {
  if (toolName !== "subagent_status") {
    consecutiveStatusPollCount = 0;
    lastPolledJobId = undefined;
  }
}

/**
 * Resets the consecutive status poll counter.
 */
export function resetConsecutiveStatusPolls(): void {
  consecutiveStatusPollCount = 0;
  lastPolledJobId = undefined;
}

/**
 * Adaptive backoff schedule for consecutive status checks:
 * 1st poll: 3s
 * 2nd poll: 7s
 * 3rd poll: 12s
 * 4th poll: 18s
 * 5th+ poll: 25s
 */
export function getBackoffWaitMs(consecutiveCount: number): number {
  if (consecutiveCount <= 1) return 3000;
  if (consecutiveCount === 2) return 7000;
  if (consecutiveCount === 3) return 12000;
  if (consecutiveCount === 4) return 18000;
  return 25000;
}

const SubagentStatusParametersSchema = Type.Object({
  jobId: Type.String({
    description: "The unique ID of the background subagent job (e.g. 'sub_a1b2c3').",
  }),
});

export function createSubagentStatusToolDefinition(): ToolDefinition<typeof SubagentStatusParametersSchema, any> {
  return {
    name: "subagent_status",
    label: "subagent_status",
    description: "Check the progress or output of a running or completed background subagent by its jobId.",
    parameters: SubagentStatusParametersSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      let job = jobManager.getJob(params.jobId);
      if (!job) {
        resetConsecutiveStatusPolls();
        const allJobs = jobManager.listJobs().map((j) => `${j.id} (${j.status})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `No background subagent found with ID "${params.jobId}". Active/recent jobs: ${allJobs}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      // If the job is still running, apply adaptive backoff cooldown
      if (job.status === "running") {
        if (lastPolledJobId === params.jobId) {
          consecutiveStatusPollCount++;
        } else {
          consecutiveStatusPollCount = 1;
          lastPolledJobId = params.jobId;
        }

        const waitMs = getBackoffWaitMs(consecutiveStatusPollCount);
        const totalSec = Math.ceil(waitMs / 1000);
        const cooldownStartTime = Date.now();
        let frameIndex = 0;
        let activeJob = job;

        const emitTick = () => {
          const currentJob = activeJob;
          const elapsedCooldownMs = Date.now() - cooldownStartTime;
          const remainingSec = Math.max(1, totalSec - Math.floor(elapsedCooldownMs / 1000));
          const elapsedSec = parseFloat(((Date.now() - currentJob.startTime) / 1000).toFixed(1));
          const spinnerFrame = SPINNER_FRAMES[frameIndex];
          frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `[subagent ${currentJob.id}] ${currentJob.lastStatus}${currentJob.currentTool ? ` (${currentJob.currentTool})` : ""}`,
              },
            ],
            details: {
              jobId: currentJob.id,
              status: currentJob.status,
              turns: currentJob.turns,
              durationSec: elapsedSec,
              currentTool: currentJob.currentTool,
              remainingSec,
              spinnerFrame,
              consecutivePolls: consecutiveStatusPollCount,
            },
          });
        };

        // Emit initial tick immediately
        emitTick();

        // 100ms interval for smooth braille animation and consistent 1-second countdown steps
        const tickTimer = setInterval(() => {
          emitTick();
        }, 100);
        tickTimer.unref?.();

        try {
          const waitedJob = await jobManager.waitForJobOrTimeout(
            params.jobId,
            waitMs,
            signal,
            (progJob) => {
              // Smoothly update reference without double-ticking or jumping spinner frames
              activeJob = progJob;
            }
          );
          if (waitedJob) {
            job = waitedJob;
          }
        } catch (err: any) {
          if (signal?.aborted) {
            throw signal.reason || new Error("Subagent status poll was aborted by user.");
          }
          throw err;
        } finally {
          clearInterval(tickTimer);
        }
      }

      const isTerminal =
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "escalated" ||
        job.status === "cancelled";

      if (isTerminal) {
        resetConsecutiveStatusPolls();
      }

      // GATING 1: If the main agent polls a completed, failed, or escalated job, mark it as polled
      // so the planned follow-up message is cancelled.
      if (job.status === "completed" || job.status === "failed" || job.status === "escalated") {
        jobManager.markJobPolledByAgent(params.jobId);
      }

      const elapsedSec = (((job.endTime ?? Date.now()) - job.startTime) / 1000).toFixed(1);

      let text = `Subagent ${job.id} Status: ${job.status.toUpperCase()}\n`;
      text += `Task: "${job.description}"\n`;
      text += `Duration: ${elapsedSec}s | Turns: ${job.turns} | Model: ${job.modelName}\n`;

      if (job.status === "escalated" && job.escalation) {
        text += `\n--- ESCALATION DETAILS ---\n`;
        text += `Reason: ${job.escalation.reason}\n`;
        text += `Question / Decision Required: ${job.escalation.questionOrDecision}\n`;
        let findings = job.escalation.partialFindings;
        if (findings.length > MAX_SUBAGENT_OUTPUT_CHARS) {
          findings =
            findings.slice(0, MAX_SUBAGENT_OUTPUT_CHARS) +
            `\n\n... [Findings truncated (${job.escalation.partialFindings.length} characters total). Full findings visible via /jobs] ...`;
        }
        text += `Partial Findings: ${findings}\n`;
        if (job.escalation.recommendedAction) {
          text += `Recommended Action: ${job.escalation.recommendedAction}\n`;
        }
      } else if (job.status === "completed" && job.result) {
        let output = job.result.output;
        if (output.length > MAX_SUBAGENT_OUTPUT_CHARS) {
          output =
            output.slice(0, MAX_SUBAGENT_OUTPUT_CHARS) +
            `\n\n... [Output truncated (${job.result.output.length} characters total). Full output visible via /jobs] ...`;
        }
        text += `\n--- Output ---\n${output}`;
      } else if (job.status === "failed") {
        let err = job.error || "Unknown error";
        if (err.length > MAX_SUBAGENT_OUTPUT_CHARS) {
          err =
            err.slice(0, MAX_SUBAGENT_OUTPUT_CHARS) +
            `\n\n... [Error truncated (${job.error!.length} characters total)] ...`;
        }
        text += `\nError: ${err}`;
      } else if (job.status === "running") {
        text += `Current status: ${job.lastStatus}`;
        if (job.currentTool) {
          text += `\nCurrently executing: ${job.currentTool}`;
        }
        if (job.recentSteps && job.recentSteps.length > 0) {
          text += `\nRecent actions:\n${job.recentSteps.map((s) => `  - ${s}`).join("\n")}`;
        }

        const nextWaitSec = (getBackoffWaitMs(consecutiveStatusPollCount + 1) / 1000).toFixed(0);
        text += `\n\n[Cooldown Policy: Subagent is actively running. Consecutive status checks incur increasing wait cooldowns (next wait: ~${nextWaitSec}s). Any cooldown is waived immediately as soon as the subagent finishes. You can perform other tasks in the meantime or allow the background result to be delivered automatically.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          jobId: job.id,
          status: job.status,
          turns: job.turns,
          durationSec: parseFloat(elapsedSec),
          currentTool: job.currentTool,
          recentSteps: job.recentSteps,
          consecutivePolls: consecutiveStatusPollCount,
        },
      };
    },
    renderCall(args, theme, context) {
      const text = theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("muted", args?.jobId || "");
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    renderResult(result, { isPartial }, theme) {
      const first = result.content[0];
      const firstText = first && first.type === "text" ? first.text : "";
      if (result.isError) {
        return new Text(theme.fg("error", firstText || "Job not found"), 0, 0);
      }
      const details = result.details as any;
      if (!details) {
        return new Text(firstText, 0, 0);
      }

      const duration =
        typeof details.durationSec === "number"
          ? `${details.durationSec.toFixed(1)}s`
          : details.durationSec !== undefined
            ? `${details.durationSec}s`
            : undefined;
      const turns =
        details.turns !== undefined
          ? `${details.turns} turn${details.turns === 1 ? "" : "s"}`
          : undefined;
      const metrics = [duration, turns].filter(Boolean).join(", ");
      const metricsStr = metrics ? ` (${metrics})` : "";

      if (isPartial) {
        const frame = details.spinnerFrame || "⠋";
        const cooldown =
          details.remainingSec !== undefined && details.remainingSec > 0
            ? ` [cooldown: ${details.remainingSec}s]`
            : "";
        const toolRaw = details.currentTool;
        const toolText = toolRaw ? (toolRaw.length > 40 ? `${toolRaw.slice(0, 37)}…` : toolRaw) : "";
        const tool = toolText ? ` • ${toolText}` : "";

        return new Text(
          `${theme.fg("accent", frame)} ${theme.fg("dim", `[${details.jobId}]`)} ${theme.fg("muted", "running")}${theme.fg("warning", cooldown)}${metricsStr}${theme.fg("dim", tool)}`,
          0,
          0
        );
      }

      const icon =
        details.status === "running"
          ? "⚡"
          : details.status === "escalated"
            ? "⚠️"
            : details.status === "completed"
              ? "✔"
              : "✖";
      const statusColor =
        details.status === "running"
          ? "accent"
          : details.status === "escalated"
            ? "warning"
            : details.status === "completed"
              ? "muted"
              : "error";
      const line = `${theme.fg(statusColor, icon)} ${theme.fg("dim", `[${details.jobId}]`)} ${theme.fg("muted", details.status)}${metricsStr}`;
      return new Text(line, 0, 0);
    },
  };
}

const SubagentCancelParametersSchema = Type.Object({
  jobId: Type.String({
    description: "The unique ID of the background subagent job to cancel.",
  }),
});

export function createSubagentCancelToolDefinition(): ToolDefinition<typeof SubagentCancelParametersSchema, any> {
  return {
    name: "subagent_cancel",
    label: "subagent_cancel",
    description: "Cancel a running background subagent job.",
    parameters: SubagentCancelParametersSchema,
    async execute(_toolCallId, params) {
      const cancelled = jobManager.cancelJob(params.jobId);
      if (!cancelled) {
        return {
          content: [
            {
              type: "text",
              text: `Could not cancel subagent "${params.jobId}": job not found or is already finished.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `Background subagent "${params.jobId}" was cancelled.` }],
        details: { jobId: params.jobId, status: "cancelled" },
      };
    },
    renderCall(args, theme, context) {
      const text = theme.fg("toolTitle", theme.bold("subagent_cancel ")) + theme.fg("muted", args?.jobId || "");
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    renderResult(result, _options, theme) {
      const first = result.content[0];
      const firstText = first && first.type === "text" ? first.text : "";
      if (result.isError) {
        return new Text(theme.fg("error", firstText || "Cancel failed"), 0, 0);
      }
      const details = result.details as any;
      return new Text(theme.fg("muted", `Cancelled [${details?.jobId || ""}]`), 0, 0);
    },
  };
}

const SubagentListParametersSchema = Type.Object({
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("all"),
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("escalated"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ],
      {
        description:
          "Filter jobs by status ('running', 'completed', 'escalated', 'failed', 'cancelled', or 'all'). Defaults to 'all'.",
      }
    )
  ),
});

export function createSubagentListToolDefinition(): ToolDefinition<typeof SubagentListParametersSchema, any> {
  return {
    name: "subagent_list",
    label: "subagent_list",
    description:
      "List all active and recent background subagent jobs with their status, turn count, duration, and current activity.",
    parameters: SubagentListParametersSchema,
    async execute(_toolCallId, params) {
      const allJobs = jobManager.listJobs();
      const filter = params.status && params.status !== "all" ? params.status : undefined;
      const jobs = filter ? allJobs.filter((j) => j.status === filter) : allJobs;

      if (jobs.length === 0) {
        const msg = filter
          ? `No background subagents found with status "${filter}". Total jobs in session: ${allJobs.length}.`
          : "No background subagents have been launched in this session.";
        return {
          content: [{ type: "text", text: msg }],
          details: { total: 0, jobs: [] },
        };
      }

      const rows = jobs.map((j) => {
        const elapsedSec = (((j.endTime ?? Date.now()) - j.startTime) / 1000).toFixed(1);
        let info = `[${j.id}] ${j.status.toUpperCase()} (${elapsedSec}s, ${j.turns} turns) - "${j.description}"`;
        if (j.status === "running") {
          info += `\n    Activity: ${j.lastStatus}`;
          if (j.currentTool) {
            info += ` (executing: ${j.currentTool})`;
          }
        } else if (j.status === "escalated" && j.escalation) {
          info += `\n    Escalation [${j.escalation.reason}]: ${j.escalation.questionOrDecision.slice(0, 75)}...`;
        } else if (j.status === "failed" && j.error) {
          const errPreview = j.error.length > 80 ? `${j.error.slice(0, 77)}...` : j.error;
          info += `\n    Error: ${errPreview}`;
        }
        return info;
      });

      const header = `Background Subagents (${jobs.length}${filter ? ` with status '${filter}'` : ""}):\n`;
      return {
        content: [{ type: "text", text: header + rows.join("\n\n") }],
        details: {
          total: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            status: j.status,
            turns: j.turns,
            description: j.description,
            startTime: j.startTime,
            endTime: j.endTime,
          })),
        },
      };
    },
    renderCall(args, theme, context) {
      const filter = args?.status ? ` [${args.status}]` : "";
      const text = theme.fg("toolTitle", theme.bold("subagent_list")) + theme.fg("dim", filter);
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    renderResult(result, _options, theme) {
      const details = result.details as any;
      const count = details?.totalCount ?? 0;
      return new Text(theme.fg("muted", `${count} subagent job${count === 1 ? "" : "s"}`), 0, 0);
    },
  };
}
