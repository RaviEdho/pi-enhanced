import { keyHint } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DialogFrame } from "../../ux/dialog.js";

/** Read-only, scrollable preview using the same frame as the commit proposal. */
export class GitSummaryDialog implements Component {
  private readonly frame: DialogFrame;

  constructor(
    tui: TUI,
    private readonly theme: any,
    private readonly title: string,
    private readonly summary: string,
    private readonly done: () => void,
  ) {
    this.frame = new DialogFrame(tui, theme);
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (this.frame.handleInput(data)) return true;
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "\x03" || data.toLowerCase() === "q") {
      this.done();
      return true;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.frame.scrollBy(-1);
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.frame.scrollBy(1);
      return true;
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.frame.handleMouse(event);
  }

  render(width: number): string[] {
    const lines = this.summary.split(/\r?\n/).map((line) => {
      const heading = /^\s*#{1,6}\s+/.test(line);
      const text = line.replace(/^\s*#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^(\s*)[-*] /, "$1• ");
      const colored = this.theme?.fg ? this.theme.fg("text", text) : text;
      return `  ${heading && this.theme?.bold ? this.theme.bold(colored) : colored}`;
    });
    return this.frame.render(width, { title: this.title, content: lines, hints: [keyHint("tui.select.cancel", "close")] });
  }
}
