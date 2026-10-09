import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { analyzeContext } from "./analyzer.js";
import { buildContextLines, formatNativeKeyHint } from "./format.js";
import type { ContextAnalysis } from "./types.js";

/**
 * Interactive context usage viewer for Pi TUI.
 *
 * Displays an embedded top border ("Session Context"), generous vertical margins,
 * live re-analysis (r), scrolling (arrows/j/k), compacting (c), and clean dismissal (esc/Enter).
 */
export class ContextViewerComponent implements Component {
  private tui: TUI;
  private theme: any;
  private keybindings?: any;
  private onDone: () => void;
  private ctx: ExtensionCommandContext;

  private analysis: ContextAnalysis;
  private scrollTop = 0;
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
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      this.tui.requestRender();
      return true;
    }

    // Scrolling: Down / j
    if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.scrollTop += 1;
      this.tui.requestRender();
      return true;
    }

    // Page Up / b
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u") || data === "b" || data === "B") {
      this.scrollTop = Math.max(0, this.scrollTop - 6);
      this.tui.requestRender();
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
      this.scrollTop += 6;
      this.tui.requestRender();
      return true;
    }

    // Top: Home / g
    if (matchesKey(data, "home") || data === "g") {
      this.scrollTop = 0;
      this.tui.requestRender();
      return true;
    }

    // Bottom: End / G
    if (matchesKey(data, "end") || data === "G") {
      this.scrollTop = 99999;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  public render(width: number): string[] {
    const accentFn = (s: string) => (this.theme?.fg ? this.theme.fg("accent", s) : s);
    const borderFn = this.theme?.fg
      ? (s: string) => this.theme.fg("border", s)
      : (s: string) => `\x1b[90m${s}\x1b[39m`;
    const boldFn = (s: string) => (this.theme?.bold ? this.theme.bold(s) : s);
    const dimFn = (s: string) => (this.theme?.fg ? this.theme.fg("dim", s) : s);

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

    const termRows =
      this.tui.terminal?.rows ||
      (typeof process !== "undefined" && process.stdout?.rows) ||
      24;
    // Overhead: top border (1) + margin after top (1) + margin before hints (1) + hints (1) + margin before bottom (1) + bottom border (1) = 6
    const viewportHeight = Math.max(5, termRows - 6);
    const canScroll = allContentLines.length > viewportHeight;
    const maxScroll = Math.max(0, allContentLines.length - viewportHeight);
    this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop));

    const visibleLines = canScroll
      ? allContentLines.slice(this.scrollTop, this.scrollTop + viewportHeight)
      : allContentLines;

    // Embedded title top border: "── Context Window ────"
    const titleText = "Context Window";
    const leftText = `── ${titleText} `;
    const leftPart = `${borderFn("── ")}${boldFn(accentFn(titleText))} `;
    const leftVisible = visibleWidth(leftText);

    let rightBadge = "";
    if (canScroll && this.scrollTop > 0) {
      rightBadge = `↑ ${this.scrollTop} more`;
    }
    const rightText = rightBadge ? ` ${rightBadge} ──` : " ──";
    const rightPart = rightBadge ? ` ${dimFn(rightBadge)}${borderFn(" ──")}` : borderFn(" ──");
    const rightVisible = visibleWidth(rightText);

    let topBorder: string;
    if (leftVisible + rightVisible + 2 <= width) {
      const fillCount = Math.max(1, width - leftVisible - rightVisible);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${rightPart}`;
    } else {
      const fillCount = Math.max(1, width - leftVisible - 2);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${borderFn("──")}`;
    }

    const lines: string[] = [topBorder];

    // Margin between top bar and content
    lines.push("");

    // Text content
    lines.push(...visibleLines);

    // Margin between text content and navigation hints
    lines.push("");

    // Native Pi navigation hint footer
    const hints: string[] = [];
    if (!this.compacting) {
      hints.push(formatNativeKeyHint(this.theme, "c", "compact"));
    }
    hints.push(formatNativeKeyHint(this.theme, "r", "refresh"));
    if (canScroll) {
      const scrollInfo = `${this.scrollTop + 1}-${Math.min(allContentLines.length, this.scrollTop + viewportHeight)}/${allContentLines.length}`;
      hints.push(formatNativeKeyHint(this.theme, "↑↓", `scroll (${scrollInfo})`));
    }
    hints.push(formatNativeKeyHint(this.theme, "esc", "close"));

    lines.push(`  ${hints.join("  ")}`);

    // Margin between hints and bottom bar
    lines.push("");

    // Bottom border with scroll indicator if hidden lines remain
    const remainingBelow = maxScroll - this.scrollTop;
    let bottomBorder: string;
    if (canScroll && remainingBelow > 0) {
      const badge = `↓ ${remainingBelow} more`;
      const badgeText = ` ${badge} ──`;
      const badgeVisible = visibleWidth(badgeText);
      const fillCount = Math.max(1, width - badgeVisible);
      bottomBorder = `${borderFn("─".repeat(fillCount))} ${dimFn(badge)}${borderFn(" ──")}`;
    } else {
      bottomBorder = borderFn("─".repeat(Math.max(1, width)));
    }
    lines.push(bottomBorder);

    return lines;
  }
}
