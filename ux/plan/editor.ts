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
 * Intercepts `borderColor` dynamically on the editor instance so that:
 * 1. Top and bottom horizontal borders use the Golden Amber spectrum in Plan Mode.
 * 2. Embedded working status indicator ("⠏ Working (...)") inherits the exact same
 *    Golden Amber spectrum in Plan Mode.
 * 3. In Implement Mode, delegates 100% untouched to Pi's native border and thinking colors.
 */
export class PlanModeEditor extends CustomEditor {
  private _nativeBorderColor?: (s: string) => string;
  private ctx?: ExtensionContext;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ctx?: ExtensionContext
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.ctx = ctx;

    // Cache initial border color function
    this._nativeBorderColor = this.borderColor;

    // Dynamically intercept borderColor property so both border drawing
    // and working status indicator ("⠏ Working (...)") use Plan Mode colors
    Object.defineProperty(this, "borderColor", {
      get: () => {
        if (PlanModeManager.getInstance().isEnabled()) {
          const thinking = this.ctx?.thinkingLevel || "off";
          return (s: string) => PlanModeManager.getInstance().formatPlanText(s, thinking);
        }
        return this._nativeBorderColor || ((s: string) => s);
      },
      set: (fn: (s: string) => string) => {
        this._nativeBorderColor = fn;
      },
      configurable: true,
      enumerable: true,
    });

    // Immediately re-render when switching between Plan and Implement mode
    PlanModeManager.getInstance().onModeChange(() => {
      tui.requestRender();
    });
  }
}
