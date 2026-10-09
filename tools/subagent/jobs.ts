import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { runSubagent } from "./runner.js";
import type { BackgroundJob, SubagentReportDetails, SubagentRunOptions } from "./types.js";

const MAX_CONCURRENT_JOBS = 3;
const MAX_STORED_JOBS = 20;

class BackgroundJobManager {
  private static instance: BackgroundJobManager;
  private pi?: ExtensionAPI;
  private uiContext?: ExtensionUIContext;
  private jobs = new Map<string, BackgroundJob>();
  private widgetTimer?: ReturnType<typeof setInterval>;
  private isStreaming = false;

  private constructor() {}

  public static getInstance(): BackgroundJobManager {
    if (!BackgroundJobManager.instance) {
      BackgroundJobManager.instance = new BackgroundJobManager();
    }
    return BackgroundJobManager.instance;
  }

  public init(pi: ExtensionAPI): void {
    this.pi = pi;

    // Track streaming state to coordinate follow-up message delivery.
    // We stay in streaming mode for the entire agent run (between agent_start and agent_settled),
    // and do NOT reset streaming on turn_end so intermediate tool calls do not trigger race conditions.
    pi.on("agent_start", () => {
      this.isStreaming = true;
    });

    pi.on("turn_start", () => {
      this.isStreaming = true;
    });

    pi.on("agent_end", () => {
      this.isStreaming = false;
    });

    pi.on("agent_settled", () => {
      this.isStreaming = false;
      void this.onAgentSettled();
    });
  }

  public setUIContext(ui: ExtensionUIContext | undefined): void {
    this.uiContext = ui;
    this.refreshWidget();
  }

  public getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  public listJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startTime - a.startTime);
  }

  public getRunningJobs(): BackgroundJob[] {
    return this.listJobs().filter((j) => j.status === "running");
  }

  /**
   * GATING 1: When the main agent polls subagent_status on a completed/failed job,
   * mark it as polled so any planned follow-up message is cancelled.
   */
  public markJobPolledByAgent(id: string): void {
    const job = this.jobs.get(id);
    if (job && (job.status === "completed" || job.status === "failed")) {
      job.polledByAgent = true;
      job.pendingFollowUp = false;
    }
  }

  public cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.abortController.abort();
    job.status = "cancelled";
    job.endTime = Date.now();
    job.pendingFollowUp = false;
    this.refreshWidget();
    return true;
  }

  public cancelAllJobs(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.abortController.abort();
        job.status = "cancelled";
        job.endTime = Date.now();
        job.pendingFollowUp = false;
      }
    }
    this.refreshWidget();
  }

  public startJob(
    options: SubagentRunOptions & {
      deliverAsFollowUp?: boolean;
    }
  ): { ok: true; job: BackgroundJob } | { ok: false; error: string } {
    const running = this.getRunningJobs();
    if (running.length >= MAX_CONCURRENT_JOBS) {
      return {
        ok: false,
        error: `Maximum concurrent background subagents reached (${MAX_CONCURRENT_JOBS}). Please wait or cancel an active subagent first.`,
      };
    }

    // Prune oldest finished jobs if over capacity
    if (this.jobs.size >= MAX_STORED_JOBS) {
      const finished = this.listJobs().filter((j) => j.status !== "running");
      if (finished.length > 0) {
        const oldest = finished[finished.length - 1];
        this.jobs.delete(oldest.id);
      }
    }

    const id = `sub_${Math.random().toString(36).slice(2, 8)}`;
    const description = options.description || options.task.slice(0, 50).replace(/\n/g, " ");
    const abortController = new AbortController();

    const job: BackgroundJob = {
      id,
      task: options.task,
      description,
      status: "running",
      turns: 0,
      lastStatus: "Initializing…",
      tokens: 0,
      abortController,
      startTime: Date.now(),
      deliverAsFollowUp: options.deliverAsFollowUp ?? true,
      modelName: `${options.model.provider}/${options.model.id}`,
      thinkingLevel: options.thinkingLevel,
      polledByAgent: false,
      followUpDelivered: false,
      pendingFollowUp: false,
    };

    this.jobs.set(id, job);
    this.ensureWidgetTimer();
    this.refreshWidget();

    // Spawn execution asynchronously in the background
    void (async () => {
      try {
        const result = await runSubagent({
          task: options.task,
          description: options.description,
          tools: options.tools,
          readOnly: options.readOnly,
          maxTurns: options.maxTurns,
          timeoutMs: options.timeoutMs,
          systemPrompt: options.systemPrompt,
          cwd: options.cwd,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          modelRuntime: options.modelRuntime,
          signal: abortController.signal,
          onUpdate: (prog) => {
            job.turns = prog.turns;
            job.tokens = prog.tokens;
            job.lastStatus = prog.status;
            this.refreshWidget();
          },
        });

        job.status = "completed";
        job.result = result;
        job.endTime = Date.now();
        this.refreshWidget();

        // Gating 1 check: if the main model already polled for subagent_status,
        // cancel the planned subagent follow-up
        if (!job.polledByAgent && job.deliverAsFollowUp) {
          await this.dispatchFollowUpReport(job);
        }
      } catch (err: any) {
        job.endTime = Date.now();
        if (abortController.signal.aborted) {
          job.status = "cancelled";
        } else {
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);

          if (!job.polledByAgent && job.deliverAsFollowUp) {
            await this.dispatchFollowUpReport(job);
          }
        }
        this.refreshWidget();
      } finally {
        this.checkWidgetTimer();
      }
    })();

    return { ok: true, job };
  }

  /**
   * Dispatches the subagent report back to the main agent.
   * If the agent is currently streaming, defers until agent settles so the agent
   * has a chance to poll subagent_status first.
   */
  private async dispatchFollowUpReport(job: BackgroundJob): Promise<void> {
    if (job.polledByAgent || job.followUpDelivered) return;

    if (this.isStreaming) {
      job.pendingFollowUp = true;
      return;
    }

    job.pendingFollowUp = false;
    job.followUpDelivered = true;
    await this.sendCustomReportMessage(job);
  }

  /**
   * Called when the main agent run settles.
   * Flushes any pending background job reports that haven't been polled.
   */
  private async onAgentSettled(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.pendingFollowUp && !job.polledByAgent && !job.followUpDelivered) {
        job.pendingFollowUp = false;
        job.followUpDelivered = true;
        await this.sendCustomReportMessage(job);
      }
    }
  }

  /**
   * GATING 2: Sends the report using custom message rendering (pi.sendMessage)
   * instead of a standard user message, preventing screen clutter.
   */
  private async sendCustomReportMessage(job: BackgroundJob): Promise<void> {
    if (!this.pi) return;

    const isCompleted = job.status === "completed";
    const durationSec = (((job.endTime ?? Date.now()) - job.startTime) / 1000).toFixed(1);
    const rawOutput = isCompleted ? (job.result?.output ?? "") : (job.error ?? "Unknown error");

    // Context budgeting: truncate excessively large outputs injected into LLM conversation
    const MAX_REPORT_OUTPUT_CHARS = 12000;
    let budgetedOutput = rawOutput;
    if (budgetedOutput.length > MAX_REPORT_OUTPUT_CHARS) {
      budgetedOutput =
        budgetedOutput.slice(0, MAX_REPORT_OUTPUT_CHARS) +
        `\n\n... [Output truncated (${rawOutput.length} characters total). Full output is saved in job record [${job.id}]] ...`;
    }

    const bannerTextForLLM = `[Background Subagent "${job.description}" (${job.id}) ${isCompleted ? "Completed" : "Failed"} in ${durationSec}s, ${job.turns} turns]:\n\n${budgetedOutput}`;

    try {
      await this.pi.sendMessage<SubagentReportDetails>(
        {
          customType: "subagent_report",
          content: bannerTextForLLM,
          display: true,
          details: {
            jobId: job.id,
            description: job.description,
            status: job.status,
            durationMs: (job.endTime ?? Date.now()) - job.startTime,
            turns: job.turns,
            tokens: job.tokens,
            output: isCompleted ? job.result?.output : undefined,
            error: !isCompleted ? job.error : undefined,
            modelName: job.modelName,
          },
        },
        {
          triggerTurn: true,
          deliverAs: "followUp",
        }
      );
    } catch {
      // Fallback if deliverAs fails
      try {
        await this.pi.sendMessage<SubagentReportDetails>(
          {
            customType: "subagent_report",
            content: bannerTextForLLM,
            display: true,
            details: {
              jobId: job.id,
              description: job.description,
              status: job.status,
              durationMs: (job.endTime ?? Date.now()) - job.startTime,
              turns: job.turns,
              tokens: job.tokens,
              output: isCompleted ? job.result?.output : undefined,
              error: !isCompleted ? job.error : undefined,
              modelName: job.modelName,
            },
          },
          {
            triggerTurn: true,
          }
        );
      } catch {
        // Session might be shutting down
      }
    }
  }

  private ensureWidgetTimer(): void {
    if (!this.widgetTimer) {
      this.widgetTimer = setInterval(() => {
        this.refreshWidget();
      }, 500);
      this.widgetTimer.unref?.();
    }
  }

  private checkWidgetTimer(): void {
    if (this.getRunningJobs().length === 0 && this.widgetTimer) {
      clearInterval(this.widgetTimer);
      this.widgetTimer = undefined;
      this.refreshWidget();
    }
  }

  private refreshWidget(): void {
    if (!this.uiContext || typeof this.uiContext.setWidget !== "function") return;

    const running = this.getRunningJobs();
    if (running.length === 0) {
      this.uiContext.setWidget("subagents", undefined);
      return;
    }

    const lines: string[] = running.map((j) => {
      const elapsed = ((Date.now() - j.startTime) / 1000).toFixed(0);
      const title = j.description.length > 35 ? `${j.description.slice(0, 32)}…` : j.description;
      return `  ⚡ [${j.id}] ${title}: ${j.lastStatus} (${elapsed}s)`;
    });

    this.uiContext.setWidget("subagents", lines);
  }
}

/**
 * Custom message renderer for "subagent_report" customType.
 * Keeps terminal clean by rendering a compact 2-line badge when collapsed,
 * expandable by user interaction to see full details.
 */
export function renderSubagentReportMessage(
  message: { content: any; details?: any },
  options: { expanded: boolean; outputPad: number },
  theme: any
): any {
  const details = message.details as SubagentReportDetails | undefined;
  const isCompleted = details?.status === "completed";
  const icon = isCompleted ? "⚡" : "✖";
  const statusColor = isCompleted ? "success" : "error";
  const title = details?.description || details?.jobId || "Subagent Task";
  const durationSec = details ? (details.durationMs / 1000).toFixed(1) : "0.0";
  const turns = details?.turns ?? 0;
  const tokens = details?.tokens ?? 0;

  let text = `${theme.fg(statusColor, icon)} ${theme.bold(theme.fg("toolTitle", "Subagent Report: "))}${theme.fg("accent", `"${title}"`)}`;
  text += ` ${theme.fg("dim", `(${details?.jobId || "sub"})`)}`;
  text += `\n${theme.fg("dim", `  ${durationSec}s • ${turns} turn${turns === 1 ? "" : "s"} • ${tokens} tokens • `)}`;

  if (options.expanded) {
    text += `${theme.fg("dim", "[Press Enter to collapse]")}\n`;
    const pad = Math.max(30, Math.min(options.outputPad || 50, 70));
    text += `\n${theme.fg("dim", "─".repeat(pad))}\n`;
    if (isCompleted && details?.output) {
      text += details.output;
    } else if (details?.error) {
      text += theme.fg("error", `Error: ${details.error}`);
    } else {
      text += "(No content)";
    }
  } else {
    text += `${theme.fg("warning", "[Press Enter to expand full output]")}`;
  }

  const box = new Box(options.outputPad ?? 0, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(text, 0, 0));
  return box;
}

export const jobManager = BackgroundJobManager.getInstance();
