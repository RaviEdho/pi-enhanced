import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { runSubagent } from "./runner.js";
import { createSubagentToolDefinition } from "./tools.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Handles the `/subagent <task>` slash command.
 */
async function handleSubagentCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const task = args.trim();
  if (!task) {
    if (ctx.hasUI) {
      ctx.ui.notify("Please specify a task for the subagent, e.g.: /subagent audit auth error handling", "warning");
    } else {
      process.stderr.write("Please specify a task for the subagent, e.g.: /subagent audit auth error handling\n");
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
 * Registers the subagent tool and /subagent slash command.
 */
export function registerSubagent(pi: ExtensionAPI): void {
  // Register the LLM tool
  pi.registerTool(createSubagentToolDefinition());

  // Register the user slash command
  pi.registerCommand("subagent", {
    description: "Run an isolated subagent inheriting the current model and thinking effort: /subagent <task>",
    handler: async (args, ctx) => {
      await handleSubagentCommand(args, ctx);
    },
  });
}

export { createSubagentToolDefinition } from "./tools.js";
export { runSubagent } from "./runner.js";
export type * from "./types.js";
