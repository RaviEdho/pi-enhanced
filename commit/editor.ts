import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class CommitStatusBroadcaster {
  private currentStatus: string;
  private listeners = new Set<(status: string) => void>();

  constructor(initialStatus = "Initializing commit agent…") {
    this.currentStatus = initialStatus;
  }

  get status(): string {
    return this.currentStatus;
  }

  update(newStatus: string): void {
    this.currentStatus = newStatus;
    for (const listener of this.listeners) {
      listener(newStatus);
    }
  }

  subscribe(listener: (status: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class BlockingCommitEditor implements EditorComponent {
  private statusText: string;
  private frameIndex: number = 0;
  private timer?: ReturnType<typeof setInterval>;
  private tui: TUI;
  private editorTheme: EditorTheme;
  private broadcaster: CommitStatusBroadcaster;
  private unsubscribeStatus: () => void;
  private onAbort?: () => void;
  public focused: boolean = true;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    broadcaster: CommitStatusBroadcaster,
    onAbort?: () => void
  ) {
    this.tui = tui;
    this.editorTheme = editorTheme;
    this.broadcaster = broadcaster;
    this.statusText = broadcaster.status;
    this.onAbort = onAbort;

    this.unsubscribeStatus = this.broadcaster.subscribe((status) => {
      this.statusText = status;
      this.tui.requestRender();
    });

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, 80);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribeStatus();
  }

  getText(): string {
    return "";
  }

  setText(_text: string): void {}

  handleInput(data: string): void {
    // Allow cancellation via Ctrl+C or Escape
    if (data === "\x03" || data === "\x1b") {
      this.onAbort?.();
    }
    // Block all other user keystrokes / text submissions while commit is active
  }

  render(width: number): string[] {
    const spinner = BRAILLE_SPINNER_FRAMES[this.frameIndex];
    const borderFn = this.editorTheme.borderColor ?? ((s: string) => s);
    const topBorder = borderFn("─".repeat(Math.max(1, width)));
    const bottomBorder = borderFn("─".repeat(Math.max(1, width)));

    const content = ` ${spinner} ${this.statusText}`;
    const fillLength = Math.max(0, width - visibleWidth(content));
    const middleLine = `${content}${" ".repeat(fillLength)}`;

    return [topBorder, middleLine, bottomBorder];
  }
}
