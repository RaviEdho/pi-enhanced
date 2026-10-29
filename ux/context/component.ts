import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { DialogFrame } from "../dialog.js";
import { analyzeContext } from "./analyzer.js";
import { buildContextLines, formatNativeKeyHint } from "./format.js";
import type { ContextAnalysis } from "./types.js";

/**
 * Interactive context usage viewer for Pi TUI.
 *
 * Uses the shared bounded dialog frame with live re-analysis (r), scrolling
 * (arrows/j/k), compacting (c), and clean dismissal (Esc/Enter).
 */
export class ContextViewerComponent implements Component {
  private tui: TUI;
  private theme: any;
  private keybindings?: any;
  private onDone: () => void;
  private ctx: ExtensionCommandContext;

  private analysis: ContextAnalysis;
  private frame: DialogFrame;
  private compacting = false;
  private statusMessage?: string;

  constructor(
    tui: TUI,
    theme: any,
    keybindings: any,
    onDone: () => void,
    ctx: ExtensionCommandContext
  ) {
    this.tui = tui;
    this.theme = theme;
    this.frame = new DialogFrame(tui, theme);
    this.keybindings = keybindings;
    this.onDone = onDone;
    this.ctx = ctx;

    this.analysis = analyzeContext(ctx);
  }

  public invalidate(): void {}

  public handleInput(data: string): boolean {
    // Dismissal / Exit:
    // Support all forms of Escape across Kitty protocol, xterm, and standard sequences
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "\x1b" ||
      data === "\x1b\x1b" ||
      data === "q" ||
      data === "Q" ||
      data === "\x03" || // Ctrl+C
      matchesKey(data, "enter") ||
      data === "\r" ||
      (this.keybindings &&
        typeof this.keybindings.matches === "function" &&
        (this.keybindings.matches(data, "tui.select.cancel") ||
          this.keybindings.matches(data, "app.interrupt") ||
          this.keybindings.matches(data, "cancel")))
    ) {
      this.onDone();
      return true;
    }

    // Refresh context snapshot
    if (data === "r" || data === "R") {
      this.analysis = analyzeContext(this.ctx);
      this.statusMessage = "Context re-analyzed";
      this.tui.requestRender();
      return true;
    }

    // Trigger compaction
    if ((data === "c" || data === "C") && !this.compacting) {
      this.compacting = true;
      this.statusMessage = "Compacting context...";
      this.tui.requestRender();

      try {
        this.ctx.compact({
          onComplete: () => {
            this.compacting = false;
            this.analysis = analyzeContext(this.ctx);
            this.statusMessage = "Compaction complete";
            this.tui.requestRender();
          },
          onError: (err) => {
            this.compacting = false;
            this.statusMessage = `Compaction failed: ${err.message}`;
            this.tui.requestRender();
          },
        });
      } catch (err: any) {
        this.compacting = false;
        this.statusMessage = `Compaction error: ${err.message}`;
        this.tui.requestRender();
      }
      return true;
    }

    // Scrolling: Up / k
    if (matchesKey(data, "up") || data === "k" || data === "K") {
      this.frame.scrollBy(-1);
      return true;
    }

    // Scrolling: Down / j
    if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.frame.scrollBy(1);
      return true;
    }

    // Page Up / b
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u") || data === "b" || data === "B") {
      this.frame.scrollBy(-this.frame.bodyHeight);
      return true;
    }

    // Page Down / Space / f
    if (
      matchesKey(data, "pageDown") ||
      matchesKey(data, "ctrl+d") ||
      matchesKey(data, "space") ||
      data === "f" ||
      data === "F"
    ) {
      this.frame.scrollBy(this.frame.bodyHeight);
      return true;
    }

    // Top: Home / g
    if (matchesKey(data, "home") || data === "g") {
      this.frame.scrollTo(0);
      return true;
    }

    // Bottom: End / G
    if (matchesKey(data, "end") || data === "G") {
      this.frame.scrollTo(Number.MAX_SAFE_INTEGER);
      return true;
    }

    return false;
  }

  public render(width: number): string[] {
    const allContentLines = buildContextLines(this.analysis, {
      availableWidth: width,
      theme: this.theme,
    });

    // Optional status message banner
    if (this.statusMessage) {
      const statusColor = this.compacting
        ? (this.theme?.fg ? this.theme.fg("warning", `  ⏳ ${this.statusMessage}`) : `  ⏳ ${this.statusMessage}`)
        : (this.theme?.fg ? this.theme.fg("accent", `  ${this.statusMessage}`) : `  ${this.statusMessage}`);
      allContentLines.unshift(statusColor, "");
    }

    const hints: string[] = [];
    if (!this.compacting) {
      hints.push(formatNativeKeyHint(this.theme, "c", "compact"));
    }
    hints.push(formatNativeKeyHint(this.theme, "r", "refresh"));
    hints.push(formatNativeKeyHint(this.theme, "Esc", "close"));
    return this.frame.render(width, {
      title: "Context Window",
      content: allContentLines,
      hints,
      scrollKeys: "↑↓",
    });
  }
}
