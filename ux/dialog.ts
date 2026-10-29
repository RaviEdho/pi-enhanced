import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** Total dialog height, including borders, actions, margins, and keyboard hints. */
export const DIALOG_MAX_ROWS = 24;
export const DIALOG_TERMINAL_MARGIN = 4;

export interface DialogOptions {
  title: string;
  metadata?: string;
  /** Already styled and indented body lines. */
  content: string[];
  /** Controls pinned below the scrolling body and above the keyboard hints. */
  actions?: string[];
  /** Selected row within actions; always kept visible, even while paging the body. */
  actionFocusLine?: number;
  hints: string[];
  /** Keep a body control visible when it changes (prefer actions for controls). */
  focusLine?: number;
  scrollKeys?: string;
}

interface WrappedLines {
  lines: string[];
  origins: number[];
  focus?: number;
}

/** Shared chrome with independent body scrolling and a fixed control section. */
export class DialogFrame {
  private top = 0;
  private maxScroll = 0;
  private renderedBodyHeight?: number;
  private previousFocus?: number;
  private previousSize = "";
  private bodyStart = 0;
  private actionsStart = 0;
  private visibleContentRows: number[] = [];
  private visibleActionRows: number[] = [];
  private actionTop = 0;

  constructor(private readonly tui: TUI, private readonly theme: any) {}

  get maxHeight(): number {
    const rows = this.tui.terminal?.rows || process.stdout?.rows || 24;
    return Math.max(1, Math.min(DIALOG_MAX_ROWS, Math.floor(rows) - DIALOG_TERMINAL_MARGIN));
  }

  get bodyHeight(): number {
    const available = Math.max(1, this.maxHeight - (this.maxHeight >= 8 ? 6 : 3));
    return Math.min(available, this.renderedBodyHeight ?? available);
  }

  /** Translate a dialog-local mouse row into an original, unscrolled body row. */
  contentRowAt(y: number): number | undefined {
    return this.visibleContentRows[Math.floor(y) - this.bodyStart];
  }

  /** Translate a dialog-local mouse row into an original pinned-control row. */
  actionRowAt(y: number): number | undefined {
    return this.visibleActionRows[Math.floor(y) - this.actionsStart];
  }

  resetScroll(): void {
    this.top = 0;
    this.previousFocus = undefined;
  }

  scrollBy(rows: number): void {
    this.top = Math.max(0, Math.min(this.maxScroll, this.top + rows));
    this.tui.requestRender();
  }

  scrollTo(row: number): void {
    this.top = Math.max(0, Math.min(this.maxScroll, row));
    this.tui.requestRender();
  }

  /** Scroll only the body; consume boundary events so they cannot move the transcript. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true, render: true };
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(-this.bodyHeight);
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(this.bodyHeight);
      return true;
    }
    return false;
  }

  private color(token: string, text: string): string {
    return this.theme?.fg ? this.theme.fg(token, text) : text;
  }

  private header(width: number, title: string, metadata?: string): string {
    const border = (text: string) => this.color("border", text);
    if (width < 8) return border("─".repeat(width));
    const label = truncateToWidth(title.replace(/[\r\n]+/g, " "), Math.max(0, width - 7), "…");
    const styledTitle = this.color("accent", label);
    const left = `${border("── ")}${this.theme?.bold ? this.theme.bold(styledTitle) : styledTitle} `;
    const rightLabel = metadata?.replace(/[\r\n]+/g, " ");
    const right = rightLabel ? ` ${this.color("dim", rightLabel)}${border(" ──")}` : border("──");
    const gap = width - visibleWidth(left) - visibleWidth(right);
    if (gap >= 1) return `${left}${border("─".repeat(gap))}${right}`;
    return truncateToWidth(`${left}${border("─".repeat(Math.max(0, width - visibleWidth(left))))}`, width);
  }

  private wrap(lines: string[], width: number, focus?: number): WrappedLines {
    const result: WrappedLines = { lines: [], origins: [] };
    for (let index = 0; index < lines.length; index++) {
      if (index === focus) result.focus = result.lines.length;
      for (const line of lines[index].split(/\r?\n/)) {
        const wrapped = wrapTextWithAnsi(line, width);
        result.lines.push(...wrapped);
        result.origins.push(...wrapped.map(() => index));
      }
    }
    return result;
  }

  render(width: number, options: DialogOptions): string[] {
    width = Math.max(1, Math.floor(width));
    const height = this.maxHeight;
    this.visibleContentRows = [];
    this.visibleActionRows = [];
    const header = this.header(width, options.title, options.metadata);
    const bottom = this.color("border", "─".repeat(width));
    const content = this.wrap(options.content, width, options.focusLine);
    const actions = this.wrap(options.actions ?? [], width, options.actionFocusLine ?? 0);
    const hasBody = content.lines.length > 0;
    const hasActions = actions.lines.length > 0;
    const selectedAction = actions.focus ?? 0;

    // In exceptionally short terminals, prioritize the active control over chrome.
    if (height <= 2 || (height === 3 && hasActions)) {
      if (hasActions) {
        this.actionsStart = height === 3 ? 1 : 0;
        this.visibleActionRows = [actions.origins[selectedAction]];
        return [...(height === 3 ? [truncateToWidth(header, width)] : []),
          truncateToWidth(actions.lines[selectedAction], width), ...(height >= 2 ? [bottom] : [])];
      }
      return height === 1 ? [truncateToWidth(header, width)] : [truncateToWidth(header, width), bottom];
    }

    const hintWidth = Math.max(1, width - 2);
    const hintBudget = Math.max(1, Math.min(2, height - 2 - (hasActions ? 1 : 0) - (hasBody ? 1 : 0)));
    const makeHints = (scrollLabel?: string): string[] => {
      const scroll = scrollLabel
        ? this.color("dim", options.scrollKeys ?? "PgUp/PgDn") + this.color("muted", ` ${scrollLabel}`)
        : undefined;
      const hints = [...options.hints];
      if (scroll) hints.splice(Math.max(0, hints.length - 1), 0, scroll);
      const wrapped = wrapTextWithAnsi(hints.join(" · "), hintWidth);
      if (wrapped.length <= hintBudget) return wrapped;
      const last = hints.at(-1) ?? "";
      const tail = wrapTextWithAnsi([scroll, last].filter(Boolean).join(" · "), hintWidth);
      if (tail.length <= hintBudget) return [...wrapped.slice(0, hintBudget - tail.length), ...tail];
      if (scroll && hintBudget > 1) return [truncateToWidth(scroll, hintWidth), truncateToWidth(last, hintWidth)];
      return [truncateToWidth(last, hintWidth)];
    };
    const layout = (hintRows: number) => {
      const minimum = (hasBody ? 1 : 0) + (hasActions ? 1 : 0);
      const spaciousMargins = 3 + (hasBody && hasActions ? 1 : 0);
      const spacious = height >= 8 && height - 2 - hintRows - spaciousMargins >= minimum;
      const gap = spacious && hasBody && hasActions ? 1 : 0;
      const available = Math.max(0, height - 2 - hintRows - (spacious ? 3 : 0) - gap);
      // Keep controls independent from the body. If controls alone overflow,
      // their own bounded window follows the selected row, not the body scroll.
      const actionHeight = hasActions
        ? Math.min(actions.lines.length, Math.max(1, available - (hasBody && available > 1 ? 1 : 0)))
        : 0;
      return { spacious, gap, actionHeight, bodyHeight: Math.max(0, available - actionHeight) };
    };
    let hints = makeHints();
    let geometry = layout(hints.length);
    const canScroll = hasBody && content.lines.length > geometry.bodyHeight;
    if (canScroll) {
      hints = makeHints(`scroll (${content.lines.length}-${content.lines.length}/${content.lines.length})`);
      geometry = layout(hints.length);
    }
    const { spacious, gap, bodyHeight, actionHeight } = geometry;
    const reservedHintRows = hints.length;
    this.renderedBodyHeight = Math.max(1, bodyHeight);
    this.maxScroll = bodyHeight > 0 ? Math.max(0, content.lines.length - bodyHeight) : 0;
    this.top = Math.max(0, Math.min(this.maxScroll, this.top));
    const size = `${width}:${bodyHeight}`;
    if (content.focus !== undefined && (content.focus !== this.previousFocus || size !== this.previousSize)) {
      if (content.focus < this.top) this.top = content.focus;
      else if (content.focus >= this.top + bodyHeight) this.top = content.focus - bodyHeight + 1;
      this.top = Math.max(0, Math.min(this.maxScroll, this.top));
    }
    this.previousFocus = content.focus;
    this.previousSize = size;
    if (canScroll && bodyHeight > 0) {
      hints = makeHints(`scroll (${this.top + 1}-${Math.min(content.lines.length, this.top + bodyHeight)}/${content.lines.length})`);
    } else if (bodyHeight === 0) {
      hints = makeHints();
    }
    // Keep the dock height stable when scroll-range digits wrap the footer.
    while (hints.length < reservedHintRows) hints.push("");
    this.actionTop = Math.max(0, Math.min(this.actionTop, actions.lines.length - actionHeight));
    if (selectedAction < this.actionTop) this.actionTop = selectedAction;
    if (selectedAction >= this.actionTop + actionHeight) this.actionTop = selectedAction - actionHeight + 1;
    this.actionTop = Math.max(0, this.actionTop);

    const lines = [header, ...(spacious ? [""] : [])];
    this.bodyStart = lines.length;
    lines.push(...content.lines.slice(this.top, this.top + bodyHeight));
    this.visibleContentRows = content.origins.slice(this.top, this.top + bodyHeight);
    if (gap) lines.push("");
    this.actionsStart = lines.length;
    lines.push(...actions.lines.slice(this.actionTop, this.actionTop + actionHeight));
    this.visibleActionRows = actions.origins.slice(this.actionTop, this.actionTop + actionHeight);
    lines.push(...(spacious ? [""] : []), ...hints.map((line) => `  ${this.color("dim", line)}`),
      ...(spacious ? [""] : []), bottom);
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}
