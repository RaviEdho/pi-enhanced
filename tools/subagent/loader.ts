import {
  CancellableLoader,
  Container,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

class DynamicBorder {
  private color: (s: string) => string;

  constructor(color: (s: string) => string) {
    this.color = color;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

/**
 * Pi-native bordered loader for foreground (synchronous) subagent execution.
 * Built with Pi's DynamicBorder, CancellableLoader, semantic theme colors,
 * and standard Esc cancellation hint.
 */
export class SubagentBorderedLoader extends Container {
  private loader: CancellableLoader;

  constructor(tui: TUI, theme: any, initialMessage: string) {
    super();
    const borderColor = (s: string) => (theme?.fg ? theme.fg("border", s) : s);
    this.addChild(new DynamicBorder(borderColor));
    this.loader = new CancellableLoader(
      tui,
      (s) => (theme?.fg ? theme.fg("accent", s) : s),
      (s) => (theme?.fg ? theme.fg("muted", s) : s),
      initialMessage
    );
    this.addChild(this.loader);
    this.addChild(new Spacer(1));
    this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(borderColor));
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

  handleInput(data: string): void {
    this.loader.handleInput(data);
  }

  dispose(): void {
    this.loader.dispose();
  }
}
