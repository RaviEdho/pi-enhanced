import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionToolState } from "../../ux/settings/session.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { jobManager, renderSubagentReportMessage } from "./jobs.js";
import { SubagentBorderedLoader } from "./loader.js";
import { runSubagent } from "./runner.js";
import {
  createSubagentCancelToolDefinition,
  createSubagentListToolDefinition,
  createSubagentStatusToolDefinition,
  createSubagentToolDefinition,
  recordToolExecution,
  resetConsecutiveStatusPolls,
} from "./tools.js";
import type { SubagentResult } from "./types.js";

const SUBAGENT_TOOL_NAMES = [
  "subagent",
  "subagent_status",
  "subagent_list",
  "subagent_cancel",
];
export const SUBAGENT_TOOL_SESSION_ENTRY = "subagent-tool-session-state";

export interface SubagentSessionState {
  enabled: boolean;
  timestamp: number;
}

let activeSessionEnabled: boolean | undefined = undefined;
let savedPi: ExtensionAPI | undefined = undefined;

/**
 * Returns whether subagent tools are active for the current session.
 * Prefers the session-persisted state to protect prompt caches on resumed sessions,
 * falling back to active tools in the session, or the global setting in enhanced-settings.json.
 */
export function isSubagentActive(): boolean {
  if (activeSessionEnabled !== undefined) {
    return activeSessionEnabled;
  }
  if (savedPi) {
    try {
      const active = savedPi.getActiveTools();
      if (active && active.length > 0) {
        return active.includes("subagent");
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }
  return EnhancedSettingsStore.getInstance().get("subagent.enabled");
}

/**
 * Handles the `/subagent [--sync|--fg] <task>` slash command.
 * Defaults to background execution unless `--sync`, `--fg`, or `--foreground` is specified.
 */
async function handleSubagentCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!isSubagentActive()) {
    const msg = "Subagents are currently disabled for this session ('subagent.enabled' is disabled). Enable 'subagent.enabled' in /settings-enhanced first.";
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`${msg}\n`);
    return;
  }

  const isForeground = /\b(--sync|-s|--fg|-f|--foreground)\b/i.test(args);
  const task = args
    .replace(/\b(--sync|-s|--fg|-f|--foreground|--bg|-b|--background)\b/gi, "")
    .trim();

  if (!task) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Usage: /subagent [--sync] <task>",
        "warning"
      );
    } else {
      process.stderr.write("Usage: /subagent [--sync] <task>\n");
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

  // Background execution is determined by explicit flag or default setting
  const defaultMode = EnhancedSettingsStore.getInstance().get("subagent.defaultMode");
  const isBackground = isForeground ? false : defaultMode === "background";
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
  let result: SubagentResult | null = null;
  let runError: any = null;

  if (ctx.hasUI && typeof ctx.ui.custom === "function") {
    const shortDesc = task.length > 40 ? `${task.slice(0, 37)}…` : task;
    result = await ctx.ui.custom<SubagentResult | null>((tui, theme, _kb, done) => {
      const loader = new SubagentBorderedLoader(
        tui,
        theme,
        `Subagent: ${shortDesc} (Initializing…)`
      );

      loader.onAbort = () => {
        abortController.abort();
        done(null);
      };

      runSubagent({
        task,
        cwd: ctx.cwd,
        model,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        modelRuntime: (ctx.modelRegistry as any)?.runtime,
        signal: abortController.signal,
        onUpdate: (prog) => {
          const toolInfo = prog.currentTool ? ` (${prog.currentTool})` : "";
          loader.setMessage(`Subagent: ${shortDesc} • ${prog.status}${toolInfo}`);
        },
      })
        .then((res) => done(res))
        .catch((err) => {
          if (!abortController.signal.aborted) {
            runError = err;
          }
          done(null);
        });

      return loader;
    });
  } else {
    // Non-interactive / headless fallback
    if (!ctx.hasUI) {
      process.stdout.write(`Starting subagent: "${task}"...\n`);
    }
    try {
      result = await runSubagent({
        task,
        cwd: ctx.cwd,
        model,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        modelRuntime: (ctx.modelRegistry as any)?.runtime,
        signal: abortController.signal,
        onUpdate: (prog) => {
          if (!ctx.hasUI) {
            process.stdout.write(`[subagent] ${prog.status}\n`);
          }
        },
      });
    } catch (err: any) {
      if (!abortController.signal.aborted) {
        runError = err;
      }
    }
  }

  if (abortController.signal.aborted) {
    if (ctx.hasUI) ctx.ui.notify("Subagent execution cancelled.", "info");
    else process.stderr.write("Subagent execution cancelled.\n");
    return;
  }

  if (runError) {
    const msg = runError instanceof Error ? runError.message : String(runError);
    if (ctx.hasUI) ctx.ui.notify(`Subagent failed: ${msg}`, "error");
    else process.stderr.write(`Subagent failed: ${msg}\n`);
    return;
  }

  if (!result) return;

  if (result.escalation) {
    if (ctx.hasUI) {
      const summaryMsg = `Subagent ESCALATED [${result.escalation.reason}] in ${(result.durationMs / 1000).toFixed(1)}s (${result.turns} turns).`;
      ctx.ui.notify(summaryMsg, "warning");
      await ctx.ui.editor(`Subagent Escalation [${result.escalation.reason}]`, result.output);
    } else {
      process.stdout.write(`\n=== Subagent Escalation [${result.escalation.reason}] ===\n${result.output}\n`);
    }
    return;
  }

  if (ctx.hasUI) {
    const summaryMsg = `Subagent finished in ${(result.durationMs / 1000).toFixed(1)}s (${result.turns} turn${result.turns > 1 ? "s" : ""}, ${result.usage.totalTokens} tokens).`;
    ctx.ui.notify(summaryMsg, "info");
    await ctx.ui.editor("Subagent Result", result.output);
  } else {
    process.stdout.write(`\n=== Subagent Result ===\n${result.output}\n`);
  }
}

/**
 * Handles `/jobs` slash command to display background subagents.
 */
async function handleJobsCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (!isSubagentActive()) {
    const msg = "Subagents are currently disabled for this session ('subagent.enabled' is disabled).";
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`${msg}\n`);
    return;
  }

  const jobs = jobManager.listJobs();
  if (jobs.length === 0) {
    ctx.ui.notify("No background subagents have been run in this session.", "info");
    return;
  }

  const items = jobs.map((j) => {
    const elapsed = (((j.endTime ?? Date.now()) - j.startTime) / 1000).toFixed(1);
    let desc = j.description;
    if (j.status === "escalated" && j.escalation) {
      desc = `[${j.escalation.reason}] ${desc}`;
    }
    return `[${j.id}] ${j.status.toUpperCase()} (${elapsed}s, ${j.turns} turns) - ${desc}`;
  });

  if (ctx.hasUI) {
    const selected = await ctx.ui.select("Background Subagent Jobs", [
      ...items,
      "Cancel all running subagents",
    ]);

    if (!selected) return;

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
        const title = job.status === "escalated" ? `Subagent [${job.id}] Escalation` : `Subagent [${job.id}] Output`;
        await ctx.ui.editor(title, job.result.output);
      } else if (job && job.status === "running") {
        const action = await ctx.ui.select(`Subagent [${job.id}] is running`, [
          "Cancel this subagent",
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
  savedPi = pi;

  // Initialize job manager with ExtensionAPI
  jobManager.init(pi);

  // Register custom message renderer for clean, non-cluttering subagent reports
  pi.registerMessageRenderer("subagent_report", renderSubagentReportMessage);

  // Register tools
  pi.registerTool(createSubagentToolDefinition());
  pi.registerTool(createSubagentStatusToolDefinition());
  pi.registerTool(createSubagentListToolDefinition());
  pi.registerTool(createSubagentCancelToolDefinition());

  const store = EnhancedSettingsStore.getInstance();

  function syncSubagentTools(enabled?: boolean): void {
    const isEnabled = enabled !== undefined ? enabled : isSubagentActive();
    try {
      const current = pi.getActiveTools();
      if (isEnabled) {
        const toAdd = SUBAGENT_TOOL_NAMES.filter((name) => !current.includes(name));
        if (toAdd.length > 0) {
          pi.setActiveTools([...current, ...toAdd]);
        }
      } else {
        const remaining = current.filter((name) => !SUBAGENT_TOOL_NAMES.includes(name));
        if (remaining.length !== current.length) {
          pi.setActiveTools(remaining);
        }
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  // Attach UI context on session start and restore session-scoped state to protect prompt cache
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    jobManager.setUIContext(ctx.ui);

    const entries = ctx.sessionManager?.getEntries?.() || [];
    const isEnabled = resolveSessionToolState(entries, "subagent", store.get("subagent.enabled"));
    activeSessionEnabled = isEnabled;
    syncSubagentTools(isEnabled);
  });

  // Dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "subagent.enabled") {
      const newEnabled = settings["subagent.enabled"];
      activeSessionEnabled = newEnabled;
      syncSubagentTools(newEnabled);
    }
  });

  // Inject or prune subagent tools from system prompt
  pi.on("before_agent_start", (event) => {
    const isEnabled = isSubagentActive();

    // If disabled: completely prune subagent tools from active tools and prompt
    if (!isEnabled) {
      if (event.systemPromptOptions?.selectedTools) {
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
          (name) => !SUBAGENT_TOOL_NAMES.includes(name)
        );
      }
      syncSubagentTools(false);
      return;
    }

    if (!event.systemPromptOptions) return;

    if (event.systemPromptOptions.selectedTools) {
      for (const name of SUBAGENT_TOOL_NAMES) {
        if (!event.systemPromptOptions.selectedTools.includes(name)) {
          event.systemPromptOptions.selectedTools.push(name);
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    jobManager.cancelAllJobs();
    jobManager.dispose();
  });

  // Slash commands
  pi.registerCommand("subagent", {
    description: "Run an isolated subagent (defaults to background, use --sync or --fg for blocking): /subagent [--sync] <task>",
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
  createSubagentListToolDefinition,
  createSubagentStatusToolDefinition,
  createSubagentToolDefinition,
} from "./tools.js";
export { runSubagent } from "./runner.js";
export { jobManager, renderSubagentReportMessage } from "./jobs.js";
export type * from "./types.js";
