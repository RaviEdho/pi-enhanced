import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DialogFrame, renderDialogActions } from "../../ux/dialog.js";

export type GitSummaryAction = "print" | { instruction: string };

/** Scrollable summary with pinned, selectable commit actions. */
export class GitSummaryDialog implements Component {
  private readonly frame: DialogFrame;
  private selectedIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly title: string,
    private readonly summary: string,
    private readonly done: (action?: GitSummaryAction) => void,
    private readonly commits: { topic: string; instruction: string }[] = [],
    private readonly keybindings?: any,
  ) {
    this.frame = new DialogFrame(tui, theme);
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (this.frame.handleInput(data)) return true;
    if (data.toLowerCase() === "p") {
      this.done("print");
      return true;
    }
    if (this.keybindings?.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || data === "\x03" || data.toLowerCase() === "q") {
      this.done();
      return true;
    }
    if (this.keybindings?.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
      const commit = this.commits[this.selectedIndex];
      this.done(commit ? { instruction: commit.instruction } : undefined);
      return true;
    }
    if (this.keybindings?.matches(data, "tui.select.up") || matchesKey(data, "up") || data === "k") {
      if (this.commits.length) this.selectedIndex = (this.selectedIndex - 1 + this.commits.length) % this.commits.length;
      else this.frame.scrollBy(-1);
      this.tui.requestRender();
      return true;
    }
    if (this.keybindings?.matches(data, "tui.select.down") || matchesKey(data, "down") || matchesKey(data, "tab") || data === "j") {
      if (this.commits.length) this.selectedIndex = (this.selectedIndex + 1) % this.commits.length;
      else this.frame.scrollBy(1);
      this.tui.requestRender();
      return true;
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const scrolled = this.frame.handleMouse(event);
    if (scrolled) return scrolled;
    const row = this.frame.actionRowAt(event.y);
    if (row !== undefined && this.commits[row] && event.button === "left" && (event.type === "press" || event.type === "click")) {
      this.selectedIndex = row;
      if (event.type === "click") this.done({ instruction: this.commits[row].instruction });
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const lines = this.summary.split(/\r?\n/).map((line) => {
      const heading = /^\s*#{1,6}\s+/.test(line);
      const text = line.replace(/^\s*#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^(\s*)[-*] /, "$1• ");
      const colored = this.theme?.fg ? this.theme.fg("text", text) : text;
      return `  ${heading && this.theme?.bold ? this.theme.bold(colored) : colored}`;
    });
    return this.frame.render(width, {
      title: this.title,
      content: lines,
      actions: renderDialogActions(this.commits.map(({ topic }) => `Commit ${topic}`), this.selectedIndex, width),
      actionFocusLine: this.selectedIndex,
      hints: [
        ...(this.commits.length ? [rawKeyHint("↑/↓", "select topic"), keyHint("tui.select.confirm", "review commit")] : []),
        rawKeyHint("p", "print to transcript"), keyHint("tui.select.cancel", "close"),
      ],
    });
  }
}
