import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { jobManager, renderSubagentReportMessage } from "./jobs.js";
import { runSubagent } from "./runner.js";
import {
  createSubagentCancelToolDefinition,
  createSubagentStatusToolDefinition,
  createSubagentToolDefinition,
} from "./tools.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Handles the `/subagent [--bg] <task>` slash command.
 */
async function handleSubagentCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const isBackground = /\b(--bg|-b|--background)\b/i.test(args);
  const task = args.replace(/\b(--bg|-b|--background)\b/gi, "").trim();

  if (!task) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Usage: /subagent <task> (or /subagent --bg <task> for non-blocking background execution)",
        "warning"
      );
    } else {
      process.stderr.write("Usage: /subagent [--bg] <task>\n");
    }
    return;
  }

  const model = ctx.model;
  if (!model) {
    if (ctx.hasUI) {
      ctx.ui.notify("No active model selected in Pi session. Please select a model first.", "error");
    } else {
      process.stderr.write("No active model selected in Pi session.\n");
    }
    return;
  }

  jobManager.setUIContext(ctx.ui);

  // Background execution branch
  if (isBackground) {
    const startResult = jobManager.startJob({
      task,
      cwd: ctx.cwd,
      model,
      thinkingLevel: ctx.thinkingLevel ?? "off",
      modelRuntime: (ctx.modelRegistry as any)?.runtime,
      deliverAsFollowUp: true,
    });

    if (!startResult.ok) {
      ctx.ui.notify(startResult.error, "error");
      return;
    }

    const job = startResult.job;
    ctx.ui.notify(`Spawned background subagent [${job.id}]. Results will be delivered on completion.`, "info");
    return;
  }

  // Foreground (blocking) execution branch
  const abortController = new AbortController();
  let frameIndex = 0;
  let statusText = "Subagent initializing...";
  const startTime = Date.now();

  const updateWorkingIndicator = () => {
    if (!ctx.hasUI) return;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const spinner = ctx.ui.theme?.fg
      ? ctx.ui.theme.fg("accent", SPINNER_FRAMES[frameIndex])
      : SPINNER_FRAMES[frameIndex];
    const text = ctx.ui.theme?.fg
      ? ctx.ui.theme.fg("text", statusText)
      : statusText;
    const elapsedText = ctx.ui.theme?.fg
      ? ctx.ui.theme.fg("dim", `(${elapsed}s)`)
      : `(${elapsed}s)`;
    const cancelHint = ctx.ui.theme?.fg
      ? ctx.ui.theme.fg("dim", "• Esc to cancel")
      : "• Esc to cancel";

    const line = `  ${spinner} ${text} ${elapsedText}  ${cancelHint}`;
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;

    if (typeof ctx.ui.setWidget === "function") {
      ctx.ui.setWidget("subagent", [line]);
    }
  };

  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let unsubTerminalInput: (() => void) | undefined;

  if (ctx.hasUI) {
    updateWorkingIndicator();
    workingTimer = setInterval(updateWorkingIndicator, 80);
    workingTimer.unref?.();

    if (typeof ctx.ui.onTerminalInput === "function") {
      unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
        if (
          matchesKey(data, "escape") ||
          matchesKey(data, "esc") ||
          matchesKey(data, "ctrl+c") ||
          data === "\x1b" ||
          data === "\x03"
        ) {
          abortController.abort();
          return { consume: true };
        }
        return undefined;
      });
    }
  }

  try {
    const result = await runSubagent({
      task,
      cwd: ctx.cwd,
      model,
      thinkingLevel: ctx.thinkingLevel ?? "off",
      modelRuntime: (ctx.modelRegistry as any)?.runtime,
      signal: abortController.signal,
      onUpdate: (prog) => {
        statusText = prog.status;
      },
    });

    if (ctx.hasUI) {
      const summaryMsg = `Subagent finished in ${(result.durationMs / 1000).toFixed(1)}s (${result.turns} turn${result.turns > 1 ? "s" : ""}, ${result.usage.totalTokens} tokens).`;
      ctx.ui.notify(summaryMsg, "info");
      await ctx.ui.editor("Subagent Result", result.output);
    } else {
      process.stdout.write(`\n=== Subagent Result ===\n${result.output}\n`);
    }
  } catch (err: any) {
    if (abortController.signal.aborted) {
      if (ctx.hasUI) ctx.ui.notify("Subagent execution cancelled.", "info");
      else process.stderr.write("Subagent execution cancelled.\n");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(`Subagent failed: ${msg}`, "error");
    else process.stderr.write(`Subagent failed: ${msg}\n`);
  } finally {
    if (workingTimer) clearInterval(workingTimer);
    unsubTerminalInput?.();
    if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
      ctx.ui.setWidget("subagent", undefined);
    }
  }
}

/**
 * Handles `/jobs` slash command to display background subagents.
 */
async function handleJobsCommand(ctx: ExtensionCommandContext): Promise<void> {
  const jobs = jobManager.listJobs();
  if (jobs.length === 0) {
    ctx.ui.notify("No background subagents have been run in this session.", "info");
    return;
  }

  const items = jobs.map((j) => {
    const elapsed = (((j.endTime ?? Date.now()) - j.startTime) / 1000).toFixed(1);
    const icon = j.status === "running" ? "⚡" : j.status === "completed" ? "✔" : "✖";
    return `${icon} [${j.id}] ${j.status.toUpperCase()} (${elapsed}s, ${j.turns} turns) - ${j.description}`;
  });

  if (ctx.hasUI) {
    const selected = await ctx.ui.select("Background Subagent Jobs", [
      ...items,
      "Cancel all running subagents",
      "Close",
    ]);

    if (!selected || selected === "Close") return;

    if (selected === "Cancel all running subagents") {
      jobManager.cancelAllJobs();
      ctx.ui.notify("All running background subagents have been cancelled.", "info");
      return;
    }

    // Inspect selected job
    const match = selected.match(/\[(sub_[a-z0-9]+)\]/);
    if (match) {
      const job = jobManager.getJob(match[1]);
      if (job && job.result) {
        await ctx.ui.editor(`Subagent [${job.id}] Output`, job.result.output);
      } else if (job && job.status === "running") {
        const action = await ctx.ui.select(`Subagent [${job.id}] is running`, [
          "Cancel this subagent",
          "Back",
        ]);
        if (action?.startsWith("Cancel")) {
          jobManager.cancelJob(job.id);
          ctx.ui.notify(`Subagent [${job.id}] cancelled.`, "info");
        }
      }
    }
  } else {
    process.stdout.write(items.join("\n") + "\n");
  }
}

/**
 * Registers the subagent tools and slash commands.
 */
export function registerSubagent(pi: ExtensionAPI): void {
  // Initialize job manager with ExtensionAPI
  jobManager.init(pi);

  // Register custom message renderer for clean, non-cluttering subagent reports
  pi.registerMessageRenderer("subagent_report", renderSubagentReportMessage);

  // Register tools
  pi.registerTool(createSubagentToolDefinition());
  pi.registerTool(createSubagentStatusToolDefinition());
  pi.registerTool(createSubagentCancelToolDefinition());

  // Attach UI context on session start and cleanup on shutdown
  pi.on("session_start", async (_event, ctx) => {
    jobManager.setUIContext(ctx.ui);
  });

  pi.on("session_shutdown", async () => {
    jobManager.cancelAllJobs();
  });

  // Slash commands
  pi.registerCommand("subagent", {
    description: "Run an isolated subagent (synchronous or background with --bg): /subagent [--bg] <task>",
    handler: async (args, ctx) => {
      await handleSubagentCommand(args, ctx);
    },
  });

  pi.registerCommand("jobs", {
    description: "List and manage background subagent jobs",
    handler: async (_args, ctx) => {
      await handleJobsCommand(ctx);
    },
  });
}

export {
  createSubagentCancelToolDefinition,
  createSubagentStatusToolDefinition,
  createSubagentToolDefinition,
} from "./tools.js";
export { runSubagent } from "./runner.js";
export { jobManager, renderSubagentReportMessage } from "./jobs.js";
export type * from "./types.js";
