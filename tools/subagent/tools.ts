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
        "If true, runs the subagent in the background without blocking the conversation. Returns immediately with a jobId. Results are automatically delivered as a follow-up when done. Defaults to false.",
    })
  ),
});

export function createSubagentToolDefinition(): ToolDefinition<typeof SubagentParametersSchema, any> {
  return {
    name: "subagent",
    label: "subagent",
    description:
      "Delegate a task to an isolated subagent with its own clean context window. Inherits the current model and thinking effort of the parent session. Can run synchronously (blocking) or in the background (non-blocking with background: true).",
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

      // Non-blocking background execution
      if (params.background) {
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
      if (args?.background) {
        text += theme.fg("warning", "[bg] ");
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
        text += `Current activity: ${job.lastStatus}`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          jobId: job.id,
          status: job.status,
          turns: job.turns,
          durationSec: parseFloat(elapsedSec),
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
