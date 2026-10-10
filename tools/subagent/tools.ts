import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { jobManager } from "./jobs.js";
import { runSubagent } from "./runner.js";

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
  readOnly: Type.Optional(
    Type.Boolean({
      description:
        "If true, runs in read-only mode disabling workspace modification tools ('edit', 'write'). Recommended for analysis, search, and inspection.",
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
          readOnly: params.readOnly,
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
              text: `Background subagent spawned successfully.\nJob ID: ${job.id}\nTask: "${job.description}"\n\nYou can continue working immediately. Once the subagent finishes, its results will be delivered automatically as a follow-up message into this session. You can also inspect its status at any time with 'subagent_status'.`,
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
          readOnly: params.readOnly,
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

        return {
          content: [{ type: "text", text: result.output }],
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
        text += theme.fg("accent", `"${label}"`);
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
  };
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
    async execute(_toolCallId, params) {
      const job = jobManager.getJob(params.jobId);
      if (!job) {
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

      const elapsedSec = (( (job.endTime ?? Date.now()) - job.startTime) / 1000).toFixed(1);

      // GATING 1: If the main agent polls a completed or failed job, mark it as polled
      // so the planned follow-up message is cancelled.
      if (job.status === "completed" || job.status === "failed") {
        jobManager.markJobPolledByAgent(params.jobId);
      }

      let text = `Subagent ${job.id} Status: ${job.status.toUpperCase()}\n`;
      text += `Task: "${job.description}"\n`;
      text += `Duration: ${elapsedSec}s | Turns: ${job.turns} | Model: ${job.modelName}\n`;

      if (job.status === "completed" && job.result) {
        text += `\n--- Output ---\n${job.result.output}`;
      } else if (job.status === "failed") {
        text += `\nError: ${job.error || "Unknown error"}`;
      } else if (job.status === "running") {
        text += `Current status: ${job.lastStatus}`;
        if (job.currentTool) {
          text += `\nCurrently executing: ${job.currentTool}`;
        }
        if (job.recentSteps && job.recentSteps.length > 0) {
          text += `\nRecent actions:\n${job.recentSteps.map((s) => `  - ${s}`).join("\n")}`;
        }
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
        },
      };
    },
    renderCall(args, theme, context) {
      const text = theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("accent", args?.jobId || "");
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
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
      const text = theme.fg("toolTitle", theme.bold("subagent_cancel ")) + theme.fg("accent", args?.jobId || "");
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
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
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ],
      {
        description:
          "Filter jobs by status ('running', 'completed', 'failed', 'cancelled', or 'all'). Defaults to 'all'.",
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
  };
}
