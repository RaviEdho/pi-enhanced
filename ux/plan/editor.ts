import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { PlanModeManager } from "./manager.js";

/**
 * Lightweight, non-invasive CustomEditor subclass.
 *
 * - In Implement Mode: renders native top and bottom borders untouched.
 * - In Plan Mode: colors top and bottom borders with the dynamic Golden Amber
 *   color spectrum matching the active reasoning effort tier.
 */
export class PlanModeEditor extends CustomEditor {
  private ctx?: ExtensionContext;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ctx?: ExtensionContext
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.ctx = ctx;

    // Immediately re-render when switching between Plan and Implement mode
    PlanModeManager.getInstance().onModeChange(() => {
      tui.requestRender();
    });
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (PlanModeManager.getInstance().isEnabled()) {
      const saved = this.borderColor;
      const thinking = this.ctx?.thinkingLevel || "off";
      this.borderColor = (s: string) =>
        PlanModeManager.getInstance().formatPlanText(s, thinking);
      try {
        return super.renderTopBorder(width, hiddenLineCount);
      } finally {
        this.borderColor = saved;
      }
    }
    return super.renderTopBorder(width, hiddenLineCount);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (PlanModeManager.getInstance().isEnabled()) {
      const saved = this.borderColor;
      const thinking = this.ctx?.thinkingLevel || "off";
      this.borderColor = (s: string) =>
        PlanModeManager.getInstance().formatPlanText(s, thinking);
      try {
        return super.renderBottomBorder(width, hiddenLineCount);
      } finally {
        this.borderColor = saved;
      }
    }
    return super.renderBottomBorder(width, hiddenLineCount);
  }
}
