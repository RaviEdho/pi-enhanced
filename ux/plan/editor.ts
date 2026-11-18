import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { PlanModeManager } from "./manager.js";

type EditorStatus = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
const TRAILING_BORDER = "──";

/** Compact only Pi Enhanced's known telemetry format, not arbitrary loader messages. */
function workingVariants(message: string): string[] | undefined {
  if (message === "Working") return [""];
  const match = /^Working \((\d+[hms](?: \d+[ms])*)(?: · (↑[\d.kM]+(?: ↓[\d.kM]+)?|↓[\d.kM]+))?(?: · (TTFT [\d.]+m?s))?(?: · ([\d.]+ tok\/s))?\)$/.exec(message);
  if (!match) return;
  const [, elapsed, tokens = "", ttft, rate] = match;
  const [input, output] = tokens.startsWith("↓") ? ["", tokens] : tokens.split(" ");
  const counts = [elapsed, input, output].filter(Boolean).join(" ");
  return [
    [counts, ttft, rate].filter(Boolean).join(" · "),
    [counts, rate].filter(Boolean).join(" · "),
    counts,
    [elapsed, output].filter(Boolean).join(" "),
    elapsed,
    "",
  ];
}

function renderTitle(name: string, width: number): string {
  // Pi's truncator can insert SGR resets around the ellipsis. The title must
  // be plain text before the editor applies the current border color.
  const title = stripVTControlCharacters(truncateToWidth(name, width - 2 - TRAILING_BORDER.length, "…"));
  return title && title !== "…" ? ` ${title} ${TRAILING_BORDER}` : "";
}

/** Preserve Pi's editor controls and spinner, with responsive top-border labels. */
export class PlanModeEditor extends CustomEditor {
  private _nativeBorderColor?: (s: string) => string;
  private ctx?: ExtensionContext;
  private unsubscribeMode: () => void;
  private status: EditorStatus;

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
    this.unsubscribeMode = PlanModeManager.getInstance().onModeChange(() => {
      tui.requestRender();
    });
  }

  dispose(): void {
    this.unsubscribeMode();
  }

  override setWorkingStatusIndicator(indicator: EditorStatus): void {
    super.setWorkingStatusIndicator(indicator);
    this.status = indicator;
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    const name = stripVTControlCharacters(this.ctx?.sessionManager?.getSessionName?.() ?? "")
      .replace(/[\r\n\t]+/g, " ").trim();
    const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
    const indicator = this.status;
    const spinner = indicator?.renderSpinnerInBorder(width) ?? "";
    const spinnerWidth = visibleWidth(spinner);
    // The native loader wraps at its render width; measure its first line
    // before allocating space to the title. Telemetry fits within 128 cells.
    let status = indicator?.renderInBorder(Math.max(width, spinnerWidth + 128)) ?? "";
    if (!indicator || !visibleWidth(status)) {
      const title = renderTitle(name, width - Math.max(3, visibleWidth(overflow) + 2));
      return super.renderTopBorder(width - visibleWidth(title), hiddenLineCount) + this.borderColor(title);
    }

    let hint = overflow;
    if (visibleWidth(hint) + spinnerWidth + 1 > width) hint = hiddenLineCount > 0 ? ` ↑${hiddenLineCount}` : "";
    if (visibleWidth(hint) + spinnerWidth + 1 > width) hint = "";
    const statusSpace = width - visibleWidth(hint);
    const normalSpace = statusSpace - 5; // `── ` before status, ` ─` after
    const titleWidth = name ? visibleWidth(name) + 2 + TRAILING_BORDER.length : 0;
    const indicatorText = stripVTControlCharacters(spinner);
    const plain = stripVTControlCharacters(status);
    const message = (indicatorText && plain.startsWith(indicatorText + " ") ? plain.slice(indicatorText.length + 1) : plain).trim();
    const withSpinner = (text: string) => text ? (spinnerWidth ? `${spinner} ` : "") + text : spinner;
    const isWorking = indicator.kind === "working";
    const variants = isWorking && (spinnerWidth || message !== "Working")
      ? workingVariants(message)?.map(withSpinner)
      : undefined;
    if (variants && visibleWidth(status) + titleWidth > normalSpace) status = variants[0];

    // Give the title only the space left after the full compact telemetry (or
    // the native status, including a waiting prompt) has been accounted for.
    const title = renderTitle(name, normalSpace - visibleWidth(status));
    if (visibleWidth(status) > statusSpace) {
      if (variants) {
        status = variants.find((variant) => visibleWidth(variant) <= statusSpace) ?? spinner;
      } else if (isWorking && message === "Waiting for your response…") {
        status = ["Waiting for reply…", "Waiting…", "Wait"].map(withSpinner)
          .find((variant) => visibleWidth(variant) <= statusSpace) ?? spinner;
      } else {
        status = spinnerWidth && statusSpace <= spinnerWidth + 1 ? spinner : truncateToWidth(status, statusSpace, "…");
      }
    }

    const remaining = statusSpace - visibleWidth(status) - visibleWidth(title);
    const prefix = remaining >= 5 && visibleWidth(status) ? "── " : "";
    const fillWidth = remaining - visibleWidth(prefix);
    const fill = fillWidth > 0 && visibleWidth(status) ? ` ${"─".repeat(fillWidth - 1)}` : "─".repeat(fillWidth);
    const suffix = fill + hint + title;
    // Reuse the current editor color rather than the loader's cached ANSI.
    // Leave native retry/compaction colors alone.
    if (isWorking) return this.borderColor(prefix + stripVTControlCharacters(status) + suffix);
    return this.borderColor(prefix) + status + this.borderColor(suffix);
  }
}
