import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";

/** Total dialog height, including borders, margins, and keyboard hints. */
export const DIALOG_MAX_ROWS = 20;
export const DIALOG_TERMINAL_MARGIN = 4;

export interface DialogOptions {
  title: string;
  metadata?: string;
  /** Already styled and indented body lines. */
  content: string[];
  hints: string[];
  /** Keep the active control visible when it changes. */
  focusLine?: number;
  /** Viewers can advertise arrow scrolling; forms retain arrows for selection. */
  scrollKeys?: string;
}

/** Shared chrome and bounded, keyboard-scrollable viewport for custom Pi dialogs. */
export class DialogFrame {
  private top = 0;
  private maxScroll = 0;
  private renderedBodyHeight?: number;
  private previousFocus?: number;
  private previousSize = "";
  private bodyStart = 0;
  private visibleContentRows: number[] = [];

  constructor(private readonly tui: TUI, private readonly theme: any) {}

  get maxHeight(): number {
    const rows = this.tui.terminal?.rows || process.stdout?.rows || 24;
    return Math.max(1, Math.min(DIALOG_MAX_ROWS, Math.floor(rows) - DIALOG_TERMINAL_MARGIN));
  }

  get bodyHeight(): number {
    const available = Math.max(1, this.maxHeight - (this.maxHeight >= 8 ? 6 : 3));
    return Math.min(available, this.renderedBodyHeight ?? available);
  }

  /** Translate a dialog-local mouse row to its original, unscrolled content row. */
  contentRowAt(y: number): number | undefined {
    return this.visibleContentRows[Math.floor(y) - this.bodyStart];
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
    const titleWidth = Math.max(0, width - 7);
    const label = truncateToWidth(title.replace(/[\r\n]+/g, " "), titleWidth, "…");
    const styledTitle = this.color("accent", label);
    const left = `${border("── ")}${this.theme?.bold ? this.theme.bold(styledTitle) : styledTitle} `;
    const rightLabel = metadata?.replace(/[\r\n]+/g, " ");
    const right = rightLabel ? ` ${this.color("dim", rightLabel)}${border(" ──")}` : border("──");
    const gap = width - visibleWidth(left) - visibleWidth(right);
    if (gap >= 1) return `${left}${border("─".repeat(gap))}${right}`;
    return truncateToWidth(`${left}${border("─".repeat(Math.max(0, width - visibleWidth(left))))}`, width);
  }

  render(width: number, options: DialogOptions): string[] {
    width = Math.max(1, Math.floor(width));
    const height = this.maxHeight;
    this.visibleContentRows = [];
    const header = this.header(width, options.title, options.metadata);
    const bottom = this.color("border", "─".repeat(width));
    if (height === 1) return [truncateToWidth(header, width)];
    if (height === 2) return [truncateToWidth(header, width), bottom];

    const spacious = height >= 8;
    const margins = spacious ? 3 : 0;
    // Reserve at least one body row. On narrow terminals, hints may occupy two rows.
    const hintBudget = Math.max(1, Math.min(2, height - margins - 3));
    const hintWidth = Math.max(1, width - 2);
    const makeHints = (scroll?: string): string[] => {
      const hints = [...options.hints];
      if (scroll) hints.splice(Math.max(0, hints.length - 1), 0, scroll);
      const wrapped = wrapTextWithAnsi(hints.join(" · "), hintWidth);
      if (wrapped.length <= hintBudget) return wrapped;
      // Prioritize scrolling and dismissal over extra action hints on narrow terminals.
      const last = hints.at(-1) ?? "";
      const tail = wrapTextWithAnsi([scroll, last].filter(Boolean).join(" · "), hintWidth);
      if (tail.length <= hintBudget) {
        return [...wrapped.slice(0, hintBudget - tail.length), ...tail];
      }
      if (scroll && hintBudget > 1) {
        return [truncateToWidth(scroll, hintWidth), truncateToWidth(last, hintWidth)];
      }
      return [truncateToWidth(last, hintWidth)];
    };
    let hints = makeHints();
    let bodyHeight = Math.max(0, height - 2 - margins - hints.length);
    const content: string[] = [];
    const contentRows: number[] = [];
    let focusLine: number | undefined;
    for (let index = 0; index < options.content.length; index++) {
      if (index === options.focusLine) focusLine = content.length;
      for (const line of options.content[index].split(/\r?\n/)) {
        const wrapped = wrapTextWithAnsi(line, width);
        content.push(...wrapped);
        contentRows.push(...wrapped.map(() => index));
      }
    }
    const canScroll = bodyHeight > 0 && content.length > bodyHeight;
    if (canScroll) {
      // Use a fixed-width placeholder first so range digit changes cannot resize the viewport.
      hints = makeHints(`${options.scrollKeys ?? "PgUp/PgDn"} scroll (${content.length}-${content.length}/${content.length})`);
      bodyHeight = Math.max(0, height - 2 - margins - hints.length);
    }
    this.renderedBodyHeight = Math.max(1, bodyHeight);
    this.maxScroll = bodyHeight > 0 ? Math.max(0, content.length - bodyHeight) : 0;
    this.top = Math.max(0, Math.min(this.maxScroll, this.top));
    const size = `${width}:${bodyHeight}`;
    if (focusLine !== undefined && (focusLine !== this.previousFocus || size !== this.previousSize)) {
      if (focusLine < this.top) this.top = focusLine;
      else if (focusLine >= this.top + bodyHeight) this.top = focusLine - bodyHeight + 1;
      this.top = Math.max(0, Math.min(this.maxScroll, this.top));
    }
    this.previousFocus = focusLine;
    this.previousSize = size;
    if (canScroll) {
      hints = makeHints(`${options.scrollKeys ?? "PgUp/PgDn"} scroll (${this.top + 1}-${Math.min(content.length, this.top + bodyHeight)}/${content.length})`);
    }
    const body = content.slice(this.top, this.top + bodyHeight);
    this.bodyStart = spacious ? 2 : 1;
    this.visibleContentRows = contentRows.slice(this.top, this.top + bodyHeight);
    const lines = [header, ...(spacious ? [""] : []), ...body,
      ...(spacious ? [""] : []), ...hints.map((line) => `  ${this.color("dim", line)}`),
      ...(spacious ? [""] : []), bottom];
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}
