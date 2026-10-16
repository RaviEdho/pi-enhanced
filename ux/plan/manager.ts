import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_DIRECTIVE } from "./prompt.js";
import { isSafeBashCommand } from "./safe-bash.js";
import type { PlanModeState } from "./types.js";

export const PLAN_MODE_ENTRY_TYPE = "plan-mode";
export const STATUS_KEY = "plan-mode";

/**
 * Manages Plan Mode vs Implement Mode state, safety sandboxing,
 * and status indicators.
 *
 * Keeps tool schemas 100% constant over the wire so model prompt caching
 * is never invalidated.
 */
export class PlanModeManager {
  private static instance?: PlanModeManager;
  private enabled = false;
  private pi?: ExtensionAPI;
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  public static getInstance(): PlanModeManager {
    if (!PlanModeManager.instance) {
      PlanModeManager.instance = new PlanModeManager();
    }
    return PlanModeManager.instance;
  }

  public init(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Registers a listener triggered whenever the mode toggles between Plan and Implement.
   */
  public onModeChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyModeChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener error
      }
    }
  }

  /**
   * Returns styled mode indicator for status footer beside cwd:
   * - Plan mode: ■ plan (warning theme)
   * - Implement mode: ▶ implement (matches textbox border / thinking color)
   */
  public getModeIndicator(
    theme?: ExtensionContext["ui"]["theme"],
    thinkingLevel?: string
  ): string {
    if (this.enabled) {
      return theme?.fg ? theme.fg("warning", "■ plan") : "■ plan";
    }

    if (theme) {
      if (typeof (theme as any).getThinkingBorderColor === "function") {
        try {
          const colorFn = (theme as any).getThinkingBorderColor(thinkingLevel || "off");
          if (typeof colorFn === "function") {
            return colorFn("▶ implement");
          }
        } catch {
          // Fallback below
        }
      }

      const token = this.getThinkingColorToken(thinkingLevel);
      try {
        return theme.fg(token as any, "▶ implement");
      } catch {
        // Fallback to accent
      }
      return theme.fg("accent", "▶ implement");
    }

    return "▶ implement";
  }

  private getThinkingColorToken(level?: string): string {
    switch (level) {
      case "minimal":
        return "thinkingMinimal";
      case "low":
        return "thinkingLow";
      case "medium":
        return "thinkingMedium";
      case "high":
        return "thinkingHigh";
      case "xhigh":
        return "thinkingXhigh";
      case "max":
        return "thinkingMax";
      case "off":
      default:
        return "thinkingOff";
    }
  }

  /**
   * Clears legacy status key if present and triggers footer refresh.
   */
  public updateStatus(ctx?: ExtensionContext): void {
    if (ctx?.ui) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    this.notifyModeChange();
  }

  /**
   * Enables Plan Mode (read-only exploration).
   */
  public enable(ctx?: ExtensionContext, notify = true): void {
    this.enabled = true;
    this.updateStatus(ctx);
    this.persistState();

    if (notify && ctx?.ui) {
      ctx.ui.notify("Plan mode enabled (read-only exploration).", "info");
    }
  }

  /**
   * Disables Plan Mode / Enables Implement Mode (write access restored).
   */
  public disable(ctx?: ExtensionContext, notify = true): void {
    this.enabled = false;
    this.updateStatus(ctx);
    this.persistState();

    if (notify && ctx?.ui) {
      ctx.ui.notify("Implement mode enabled (write access restored).", "info");
    }
  }

  /**
   * Toggles between Plan Mode and Implement Mode.
   */
  public toggle(ctx?: ExtensionContext): boolean {
    if (this.enabled) {
      this.disable(ctx, true);
    } else {
      this.enable(ctx, true);
    }
    return this.enabled;
  }

  /**
   * Inspects tool calls and blocks mutating operations if Plan Mode is active.
   */
  public checkToolCall(
    toolName: string,
    input: Record<string, unknown>
  ): { block: boolean; reason?: string } | undefined {
    if (!this.enabled) {
      return undefined;
    }

    // Direct file mutation tools
    if (toolName === "edit" || toolName === "write") {
      return {
        block: true,
        reason:
          "[Plan Mode Active] File modification tools (edit, write) are disabled. " +
          "Inspect the codebase and outline your implementation plan. " +
          "To make code changes, switch to implement mode with /implement.",
      };
    }

    // Shell execution: inspect command safety
    if (toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const validation = isSafeBashCommand(command);
      if (!validation.safe) {
        return {
          block: true,
          reason:
            `[Plan Mode Active] Shell command blocked: ${validation.reason || "Mutating operation"}.\n` +
            `Command: ${command}\n` +
            `Switch to implement mode with /implement to execute mutating commands.`,
        };
      }
    }

    return undefined;
  }

  /**
   * Returns directive to inject before agent prompt when Plan Mode is active.
   */
  public getDirective(): string | undefined {
    return this.enabled ? PLAN_MODE_DIRECTIVE : undefined;
  }

  /**
   * Persists current plan mode state into the session tree.
   */
  private persistState(): void {
    if (!this.pi) return;
    try {
      this.pi.appendEntry(PLAN_MODE_ENTRY_TYPE, {
        enabled: this.enabled,
        timestamp: Date.now(),
      } satisfies PlanModeState);
    } catch {
      // Ignore if session is not yet active
    }
  }

  /**
   * Restores plan mode state on session resume/fork.
   */
  public restoreFromSession(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    ctx?: ExtensionContext
  ): void {
    const lastPlanEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.type === "custom" &&
          (e.customType === PLAN_MODE_ENTRY_TYPE || (e as any).name === PLAN_MODE_ENTRY_TYPE)
      );

    if (lastPlanEntry?.data && typeof (lastPlanEntry.data as any).enabled === "boolean") {
      this.enabled = (lastPlanEntry.data as any).enabled;
    }

    this.updateStatus(ctx);
  }
}
