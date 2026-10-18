import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPlanModeDirective, PLAN_MODE_DIRECTIVE } from "./prompt.js";
import { isFeedbackToolActive } from "../../tools/feedback/index.js";
import { isScoutActive } from "../../tools/scout/index.js";
import { isWebActive } from "../../tools/web/index.js";
import { isSafeBashCommand } from "./safe-bash.js";
import type { PlanModeState } from "./types.js";

export const PLAN_MODE_ENTRY_TYPE = "plan-mode";
export const STATUS_KEY = "plan-mode";

/**
 * Golden Amber color palette for Plan Mode across thinking levels.
 * Provides a warm drafting parchment / architectural gold gradient that
 * intensifies as reasoning effort increases.
 */
const AMBER_DARK_COLORS: Record<string, string> = {
  off: "\x1b[38;2;168;162;158m",     // Stone Slate (#a8a29e)
  minimal: "\x1b[38;2;254;240;138m", // Light Cream (#fef08a)
  low: "\x1b[38;2;253;224;71m",      // Soft Buttercup (#fde047)
  medium: "\x1b[38;2;251;191;36m",   // Warm Amber (#fbbf24)
  high: "\x1b[38;2;245;158;11m",     // Deep Goldenrod (#f59e0b)
  xhigh: "\x1b[38;2;249;115;22m",    // Tangerine Gold (#f97316)
  max: "\x1b[38;2;239;68;68m",       // Fiery Sun (#ef4444)
};

const AMBER_LIGHT_COLORS: Record<string, string> = {
  off: "\x1b[38;2;87;83;78m",        // Stone-600 (#57534e)
  minimal: "\x1b[38;2;161;98;7m",    // Yellow-700 (#a16207)
  low: "\x1b[38;2;180;83;9m",        // Amber-700 (#b45309)
  medium: "\x1b[38;2;146;64;14m",    // Amber-800 (#92400e)
  high: "\x1b[38;2;194;65;12m",      // Orange-700 (#c2410c)
  xhigh: "\x1b[38;2;154;52;18m",     // Orange-800 (#9a3412)
  max: "\x1b[38;2;185;28;28m",       // Red-700 (#b91c1c)
};

/**
 * Blueprint color palette (alternative).
 */
const BLUEPRINT_DARK_COLORS: Record<string, string> = {
  off: "\x1b[38;2;148;163;184m",     // Steel Slate (#94a3b8)
  minimal: "\x1b[38;2;125;211;252m", // Ice Sky (#7dd3fc)
  low: "\x1b[38;2;56;189;248m",      // Sky Cerulean (#38bdf8)
  medium: "\x1b[38;2;6;182;212m",    // Electric Cyan (#06b6d4)
  high: "\x1b[38;2;20;184;166m",     // Deep Teal (#14b8a6)
  xhigh: "\x1b[38;2;16;185;129m",    // Vivid Emerald (#10b981)
  max: "\x1b[38;2;52;211;153m",      // Neon Mint (#34d399)
};

const BLUEPRINT_LIGHT_COLORS: Record<string, string> = {
  off: "\x1b[38;2;71;85;105m",       // Slate-600 (#475569)
  minimal: "\x1b[38;2;3;105;161m",   // Sky-700 (#0369a1)
  low: "\x1b[38;2;2;132;199m",       // Cerulean-600 (#0284c7)
  medium: "\x1b[38;2;14;116;144m",   // Cyan-700 (#0e7490)
  high: "\x1b[38;2;15;118;110m",     // Teal-700 (#0f766e)
  xhigh: "\x1b[38;2;4;120;87m",      // Emerald-700 (#047857)
  max: "\x1b[38;2;21;128;61m",       // Green-700 (#15803d)
};

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
   * - Plan mode: ■ plan (dynamic Golden Amber spectrum based on thinking level)
   * - Implement mode: ▶ implement (dynamic textbox border / thinking color)
   */
  public getModeIndicator(
    theme?: ExtensionContext["ui"]["theme"],
    thinkingLevel?: string
  ): string {
    const level = thinkingLevel || "off";

    if (this.enabled) {
      if (!theme) return "■ plan";
      const isLight = (theme as any)?.appearance === "light";
      const palette = isLight ? AMBER_LIGHT_COLORS : AMBER_DARK_COLORS;
      const ansiColor = palette[level] || palette.off;
      return `${ansiColor}■ plan\x1b[39m`;
    }

    if (theme) {
      if (typeof (theme as any).getThinkingBorderColor === "function") {
        try {
          const colorFn = (theme as any).getThinkingBorderColor(level);
          if (typeof colorFn === "function") {
            return colorFn("▶ implement");
          }
        } catch {
          // Fallback below
        }
      }

      const token = this.getThinkingColorToken(level);
      try {
        return theme.fg(token as any, "▶ implement");
      } catch {
        // Fallback to accent
      }
      return theme.fg("accent", "▶ implement");
    }

    return "▶ implement";
  }

  /**
   * Formats arbitrary text (such as editor border glyphs) using the Golden Amber
   * color spectrum for the specified thinking level.
   */
  public formatPlanText(text: string, thinkingLevel?: string): string {
    const level = thinkingLevel || "off";
    const palette = AMBER_DARK_COLORS;
    const ansiColor = palette[level] || palette.off;
    return `${ansiColor}${text}\x1b[39m`;
  }

  /**
   * Backwards-compatible alias.
   */
  public formatBlueprintText(text: string, thinkingLevel?: string): string {
    return this.formatPlanText(text, thinkingLevel);
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
    if (!this.enabled) return undefined;
    return getPlanModeDirective({
      askUserEnabled: isFeedbackToolActive(),
      scoutEnabled: isScoutActive(),
      webEnabled: isWebActive(),
    });
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
