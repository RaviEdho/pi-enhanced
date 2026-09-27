import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatTokens } from "./format.js";
import type { CommitActionEntry } from "./types.js";

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class CommitStatusBroadcaster {
  private currentStatus: string;
  private actions: CommitActionEntry[] = [];
  private modelName: string;
  private startTime: number;
  private totalTokens: number = 0;
  private totalCost: number = 0;
  private subscription: boolean = false;
  private listeners = new Set<() => void>();

  constructor(initialStatus = "Initializing commit agent…", modelName = "") {
    this.currentStatus = initialStatus;
    this.modelName = modelName;
    this.startTime = Date.now();
  }

  get status(): string {
    return this.currentStatus;
  }

  get recentActions(): CommitActionEntry[] {
    return this.actions;
  }

  get model(): string {
    return this.modelName;
  }

  get startTimestamp(): number {
    return this.startTime;
  }

  get tokens(): number {
    return this.totalTokens;
  }

  get cost(): number {
    return this.totalCost;
  }

  get isSubscription(): boolean {
    return this.subscription;
  }

  setModel(name: string): void {
    this.modelName = name;
    this.notify();
  }

  setIsSubscription(val: boolean): void {
    this.subscription = val;
    this.notify();
  }

  update(newStatus: string): void {
    this.currentStatus = newStatus;
    this.notify();
  }

  addAction(action: Omit<CommitActionEntry, "timestamp">): void {
    this.actions.push({ ...action, timestamp: Date.now() });
    this.notify();
  }

  updateUsage(tokens: number, cost: number): void {
    this.totalTokens = tokens;
    this.totalCost = cost;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class BlockingCommitEditor implements EditorComponent {
  private frameIndex: number = 0;
  private timer?: ReturnType<typeof setInterval>;
  private tui: TUI;
  private editorTheme: EditorTheme;
  private theme?: any;
  private broadcaster: CommitStatusBroadcaster;
  private unsubscribeStatus: () => void;
  private onAbort?: () => void;
  private keybindings?: any;
  public focused: boolean = true;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    broadcaster: CommitStatusBroadcaster,
    onAbort?: () => void,
    theme?: any,
    keybindings?: any
  ) {
    this.tui = tui;
    this.editorTheme = editorTheme;
    this.theme = theme;
    this.broadcaster = broadcaster;
    this.onAbort = onAbort;
    this.keybindings = keybindings;

    this.unsubscribeStatus = this.broadcaster.subscribe(() => {
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
    // Allow cancellation via Ctrl+C, Escape, 'q', or matching keybindings
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "\x1b" ||
      data === "\x03" ||
      data.toLowerCase() === "q" ||
      (this.keybindings && typeof this.keybindings.matches === "function" && (
        this.keybindings.matches(data, "app.interrupt") ||
        this.keybindings.matches(data, "app.clear") ||
        this.keybindings.matches(data, "tui.select.cancel")
      ))
    ) {
      this.broadcaster.update("Cancelling commit agent…");
      this.onAbort?.();
    }
    // Block all other user keystrokes while commit agent runs
  }

  private formatBoxLine(text: string, width: number, borderFn: (s: string) => string): string {
    const innerWidth = Math.max(0, width - 4);
    const truncated = truncateToWidth(text, innerWidth, "…");
    const pad = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${borderFn("│")} ${truncated}${" ".repeat(pad)} ${borderFn("│")}`;
  }

  render(width: number): string[] {
    const spinner = BRAILLE_SPINNER_FRAMES[this.frameIndex];
    const borderFn = this.editorTheme.borderColor ?? ((s: string) => s);
    const elapsedSec = ((Date.now() - this.broadcaster.startTimestamp) / 1000).toFixed(1);

    const dimFn = (s: string) =>
      this.theme?.fg ? this.theme.fg("dim", s) : `\x1b[2m\x1b[90m${s}\x1b[0m`;
    const whiteFn = (s: string) =>
      this.theme?.fg ? this.theme.fg("text", s) : `\x1b[97m${s}\x1b[0m`;

    // Compact single-line fallback for narrow terminals
    if (width < 50) {
      const content = ` ${spinner} ${this.broadcaster.status}`;
      const fillLength = Math.max(0, width - visibleWidth(content));
      const middleLine = `${whiteFn(content)}${" ".repeat(fillLength)}`;
      return [
        borderFn("─".repeat(Math.max(1, width))),
        middleLine,
        borderFn("─".repeat(Math.max(1, width))),
      ];
    }

    const lines: string[] = [];

    // Top border with title and cancel hint
    const title = " Commit Agent ";
    const hint = " [Esc to cancel] ";
    const availableDash = Math.max(0, width - visibleWidth(title) - visibleWidth(hint) - 3);
    const topBorder = `┌─${title}${"─".repeat(availableDash)}${hint}┐`;
    lines.push(borderFn(topBorder));

    // Active status line (colored white)
    const modelTag = this.broadcaster.model ? ` [${this.broadcaster.model}]` : "";
    const activeText = whiteFn(`${spinner} ${this.broadcaster.status}${modelTag} • ${elapsedSec}s`);
    lines.push(this.formatBoxLine(activeText, width, borderFn));

    // Recent actions (last 2 - faded/dim)
    const recent = this.broadcaster.recentActions.slice(-2);
    if (recent.length > 0) {
      for (const action of recent) {
        lines.push(this.formatBoxLine(dimFn(`  ✓ ${action.description}`), width, borderFn));
      }
    }

    // Usage & cost line if any usage reported (colored white)
    if (this.broadcaster.tokens > 0) {
      const costBadge = this.broadcaster.cost > 0
        ? `$${formatCost(this.broadcaster.cost)}`
        : (this.broadcaster.isSubscription ? "included with subscription" : "$0.00");
      const usageText = whiteFn(`  Tokens: ${formatTokens(this.broadcaster.tokens)} • Cost: ${costBadge}`);
      lines.push(this.formatBoxLine(usageText, width, borderFn));
    }

    // Bottom border
    const bottomBorder = `└${"─".repeat(Math.max(0, width - 2))}┘`;
    lines.push(borderFn(bottomBorder));

    return lines;
  }
}
