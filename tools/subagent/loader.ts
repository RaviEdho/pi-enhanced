import { CancellableLoader, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { DialogFrame } from "../../ux/dialog.js";

/** Native cancellable loader inside the shared, height-bounded dialog frame. */
export class SubagentBorderedLoader implements Component {
  private readonly loader: CancellableLoader;
  private readonly frame: DialogFrame;

  constructor(tui: TUI, theme: any, initialMessage: string) {
    this.frame = new DialogFrame(tui, theme);
    this.loader = new CancellableLoader(
      tui,
      (s) => (theme?.fg ? theme.fg("accent", s) : s),
      (s) => (theme?.fg ? theme.fg("muted", s) : s),
      initialMessage
    );
  }

  get signal(): AbortSignal {
    return this.loader.signal;
  }

  set onAbort(fn: (() => void) | undefined) {
    this.loader.onAbort = fn;
  }

  setMessage(message: string): void {
    this.loader.setMessage(message);
  }

  invalidate(): void {
    this.loader.invalidate();
  }

  render(width: number): string[] {
    return this.frame.render(width, {
      title: "Subagent",
      content: this.loader.render(Math.max(1, width - 2)).slice(1).map((line) => `  ${line}`),
      hints: [keyHint("tui.select.cancel", "cancel")],
    });
  }

  handleInput(data: string): void {
    if (!this.frame.handleInput(data)) this.loader.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.frame.handleMouse(event);
  }

  dispose(): void {
    this.loader.dispose();
  }
}
