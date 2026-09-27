import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCost, formatDuration } from "./format.js";
import type {
  CommitActionEntry,
  CommitConfirmationResult,
  CommitProposal,
  CommitUsageCost,
  GitStagedOverview,
} from "./types.js";

export interface CommitConfirmationDialogOptions {
  proposal: CommitProposal;
  actions: CommitActionEntry[];
  overview: GitStagedOverview;
  diffedFiles: string[];
  usage: CommitUsageCost;
  onDone: (result: CommitConfirmationResult) => void;
}

export class CommitConfirmationDialog implements Component {
  private tui: TUI;
  private theme: any;
  private proposal: CommitProposal;
  private actions: CommitActionEntry[];
  private overview: GitStagedOverview;
  private diffedFiles: string[];
  private usage: CommitUsageCost;
  private onDone: (result: CommitConfirmationResult) => void;
  private selectedIndex: number = 0; // 0 = Commit, 1 = Edit, 2 = Cancel
  private fullMessage: string;
  private headerLine: string;

  constructor(
    tui: TUI,
    theme: any,
    options: CommitConfirmationDialogOptions
  ) {
    this.tui = tui;
    this.theme = theme;
    this.proposal = options.proposal;
    this.actions = options.actions;
    this.overview = options.overview;
    this.diffedFiles = options.diffedFiles;
    this.usage = options.usage;
    this.onDone = options.onDone;

    const type = this.proposal.type.trim().toLowerCase();
    const scope = this.proposal.scope?.trim().toLowerCase();
    const subject = this.proposal.subject.trim().replace(/\.$/, "");
    this.headerLine = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
    this.fullMessage = this.proposal.body?.trim()
      ? `${this.headerLine}\n\n${this.proposal.body.trim()}`
      : this.headerLine;
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      if (this.selectedIndex === 0) {
        this.onDone({ action: "commit", message: this.fullMessage });
      } else if (this.selectedIndex === 1) {
        this.onDone({ action: "edit", message: this.fullMessage });
      } else {
        this.onDone({ action: "cancel" });
      }
      return true;
    }

    if (data.toLowerCase() === "c") {
      this.onDone({ action: "commit", message: this.fullMessage });
      return true;
    }

    if (data.toLowerCase() === "e") {
      this.onDone({ action: "edit", message: this.fullMessage });
      return true;
    }

    if (matchesKey(data, "escape") || data.toLowerCase() === "q" || data === "\x03") {
      this.onDone({ action: "cancel" });
      return true;
    }

    // Navigation
    if (matchesKey(data, "left") || matchesKey(data, "up")) {
      this.selectedIndex = (this.selectedIndex - 1 + 3) % 3;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % 3;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  /**
   * Formats a single content row inside the box with symmetric 2-space padding on both sides.
   * Total width of rendered line: 1 (border) + 2 (pad) + contentWidth + 2 (pad) + 1 (border) = boxWidth.
   */
  private boxLine(content: string, contentWidth: number, borderFn: (s: string) => string): string {
    const truncated = truncateToWidth(content, contentWidth, "…");
    const pad = Math.max(0, contentWidth - visibleWidth(truncated));
    return `${borderFn("│")}  ${truncated}${" ".repeat(pad)}  ${borderFn("│")}`;
  }

  render(width: number): string[] {
    const borderFn = (s: string) => this.theme?.fg("border", s) ?? s;
    const accentFn = (s: string) => this.theme?.fg("accent", s) ?? s;
    const mutedFn = (s: string) => this.theme?.fg("muted", s) ?? s;
    const dimFn = (s: string) => this.theme?.fg("dim", s) ?? s;
    const boldFn = (s: string) => this.theme?.bold(s) ?? s;
    const successFn = (s: string) => this.theme?.fg("success", s) ?? s;

    // Outer box width and symmetric inner content width
    const boxWidth = Math.min(Math.max(width - 2, 40), 86);
    const contentWidth = Math.max(10, boxWidth - 6);
    const padLeft = " ".repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));

    const rawLines: string[] = [];

    // 1. Top border
    const title = " Commit Proposal ";
    const fillDash = Math.max(0, boxWidth - visibleWidth(title) - 4);
    rawLines.push(borderFn(`┌─${boldFn(accentFn(title))}${"─".repeat(fillDash)}─┐`));

    // 2. Commit Message Header
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    rawLines.push(this.boxLine(boldFn(accentFn("Commit Message:")), contentWidth, borderFn));
    const headerWrapped = wrapTextWithAnsi(this.headerLine, Math.max(10, contentWidth - 2));
    for (const hLine of headerWrapped) {
      rawLines.push(this.boxLine(`  ${boldFn(hLine)}`, contentWidth, borderFn));
    }

    // 3. Commit Body (word-wrapped with clean hanging indents)
    if (this.proposal.body?.trim()) {
      rawLines.push(this.boxLine("", contentWidth, borderFn));
      const rawBodyLines = this.proposal.body.trim().split("\n");
      for (const rawLine of rawBodyLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          rawLines.push(this.boxLine("", contentWidth, borderFn));
          continue;
        }

        const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ");
        const textAfterBullet = isBullet ? trimmed.slice(2).trim() : trimmed;

        if (isBullet) {
          const wrapped = wrapTextWithAnsi(textAfterBullet, Math.max(10, contentWidth - 4));
          wrapped.forEach((line, idx) => {
            const prefix = idx === 0 ? "  • " : "    ";
            rawLines.push(this.boxLine(`${prefix}${mutedFn(line)}`, contentWidth, borderFn));
          });
        } else {
          const wrapped = wrapTextWithAnsi(trimmed, Math.max(10, contentWidth - 2));
          wrapped.forEach((line) => {
            rawLines.push(this.boxLine(`  ${mutedFn(line)}`, contentWidth, borderFn));
          });
        }
      }
    }

    // 4. Section Divider
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    rawLines.push(borderFn(`├${"─".repeat(boxWidth - 2)}┤`));

    // 5. Inspection Transparency
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    rawLines.push(this.boxLine(boldFn(accentFn("Inspection Details:")), contentWidth, borderFn));
    const stagedCount = this.overview.stagedFiles.length;
    const stagedDesc = `${stagedCount} staged file${stagedCount === 1 ? "" : "s"}${
      this.overview.statSummary ? ` (${this.overview.statSummary.split("\n")[0]})` : ""
    }`;
    rawLines.push(this.boxLine(`  • Staged:    ${stagedDesc}`, contentWidth, borderFn));

    if (this.diffedFiles.length > 0) {
      const diffList = this.diffedFiles.slice(0, 3).join(", ");
      const extraDiff = this.diffedFiles.length > 3 ? ` (+${this.diffedFiles.length - 3} more)` : "";
      rawLines.push(this.boxLine(`  • Diffed:    ${diffList}${extraDiff}`, contentWidth, borderFn));
    }

    // 6. Cost & Usage Information
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    rawLines.push(this.boxLine(boldFn(accentFn("Cost & Usage Information:")), contentWidth, borderFn));
    rawLines.push(
      this.boxLine(
        `  • Model:     ${this.usage.modelId} (${this.usage.turns} turn${
          this.usage.turns === 1 ? "" : "s"
        } in ${formatDuration(this.usage.durationMs)})`,
        contentWidth,
        borderFn
      )
    );

    const promptTokens = this.usage.inputTokens.toLocaleString();
    const completionTokens = this.usage.outputTokens.toLocaleString();
    const totalTokens = this.usage.totalTokens.toLocaleString();
    let tokenDetail = `  • Tokens:    ${totalTokens} total (↑${promptTokens} prompt, ↓${completionTokens} completion`;
    if (this.usage.reasoningTokens > 0) {
      tokenDetail += `, reasoning: ${this.usage.reasoningTokens.toLocaleString()}`;
    }
    if (this.usage.cacheReadTokens > 0) {
      tokenDetail += `, cached: ${this.usage.cacheReadTokens.toLocaleString()}`;
    }
    tokenDetail += ")";
    rawLines.push(this.boxLine(tokenDetail, contentWidth, borderFn));

    let costString: string;
    if (this.usage.totalCost > 0) {
      costString = `${successFn(`$${formatCost(this.usage.totalCost)}`)} ${dimFn("(estimated per-token billing)")}`;
    } else if (this.usage.isSubscription) {
      costString = `${successFn("$0.00")} ${dimFn(`(included with ${this.usage.provider} subscription)`)}`;
    } else {
      costString = `${dimFn("$0.00 (free)")}`;
    }
    rawLines.push(this.boxLine(`  • Cost:      ${costString}`, contentWidth, borderFn));

    // 7. Divider before Buttons
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    rawLines.push(borderFn(`├${"─".repeat(boxWidth - 2)}┤`));
    rawLines.push(this.boxLine("", contentWidth, borderFn));

    // 8. Buttons
    const btnCommit = this.selectedIndex === 0
      ? boldFn(accentFn("→ [ ✓ Commit ]"))
      : dimFn("  [ ✓ Commit ]");
    const btnEdit = this.selectedIndex === 1
      ? boldFn(accentFn("→ [ ✎ Edit Message ]"))
      : dimFn("  [ ✎ Edit Message ]");
    const btnCancel = this.selectedIndex === 2
      ? boldFn(accentFn("→ [ ✗ Cancel ]"))
      : dimFn("  [ ✗ Cancel ]");

    const buttonsLine = `${btnCommit}      ${btnEdit}      ${btnCancel}`;
    rawLines.push(this.boxLine(buttonsLine, contentWidth, borderFn));

    // 9. Navigation hint
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    const navHint = "Enter select • ←→/Tab navigate • c commit • e edit • Esc cancel";
    rawLines.push(this.boxLine(dimFn(navHint), contentWidth, borderFn));

    // 10. Bottom border
    rawLines.push(borderFn(`└${"─".repeat(boxWidth - 2)}┘`));

    return rawLines.map((line) => `${padLeft}${line}`);
  }
}
