import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCost, formatDuration } from "./format.js";
import type {
  CommitActionEntry,
  CommitConfirmationResult,
  CommitPlanProposal,
  CommitProposal,
  CommitUsageCost,
  GitStagedOverview,
} from "./types.js";

export interface CommitConfirmationDialogOptions {
  plan: CommitPlanProposal;
  actions: CommitActionEntry[];
  overview: GitStagedOverview;
  diffedFiles: string[];
  usage: CommitUsageCost;
  onDone: (result: CommitConfirmationResult) => void;
}

export class CommitConfirmationDialog implements Component {
  private tui: TUI;
  private theme: any;
  private plan: CommitPlanProposal;
  private actions: CommitActionEntry[];
  private overview: GitStagedOverview;
  private diffedFiles: string[];
  private usage: CommitUsageCost;
  private onDone: (result: CommitConfirmationResult) => void;
  private keybindings?: any;
  private selectedIndex: number = 0; // 0 = Commit, 1 = Commit & Push, 2 = Edit, 3 = Cancel
  private fullMessage: string = "";
  private headerLine: string = "";
  private isTwoRowLayout: boolean = false;

  constructor(
    tui: TUI,
    theme: any,
    options: CommitConfirmationDialogOptions,
    keybindings?: any
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.plan = options.plan;
    this.actions = options.actions;
    this.overview = options.overview;
    this.diffedFiles = options.diffedFiles;
    this.usage = options.usage;
    this.onDone = options.onDone;

    if (this.plan.stages.length > 0) {
      const first = this.plan.stages[0];
      const type = first.type.trim().toLowerCase();
      const scope = first.scope?.trim().toLowerCase();
      const subject = first.subject.trim().replace(/\.$/, "");
      this.headerLine = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
      this.fullMessage = first.body?.trim()
        ? `${this.headerLine}\n\n${first.body.trim()}`
        : this.headerLine;
    }
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      if (this.selectedIndex === 0) {
        this.onDone({ action: "commit", message: this.fullMessage, stages: this.plan.stages });
      } else if (this.selectedIndex === 1) {
        this.onDone({ action: "commit-and-push", message: this.fullMessage, stages: this.plan.stages });
      } else if (this.selectedIndex === 2) {
        this.onDone({ action: "edit", message: this.fullMessage, stages: this.plan.stages });
      } else {
        this.onDone({ action: "cancel" });
      }
      return true;
    }

    if (data.toLowerCase() === "c") {
      this.onDone({ action: "commit", message: this.fullMessage, stages: this.plan.stages });
      return true;
    }

    if (data.toLowerCase() === "p") {
      this.onDone({ action: "commit-and-push", message: this.fullMessage, stages: this.plan.stages });
      return true;
    }

    if (data.toLowerCase() === "e") {
      this.onDone({ action: "edit", message: this.fullMessage, stages: this.plan.stages });
      return true;
    }

    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "\x1b" ||
      data === "\x03" ||
      data.toLowerCase() === "q" ||
      (this.keybindings && typeof this.keybindings.matches === "function" && (
        this.keybindings.matches(data, "app.interrupt") ||
        this.keybindings.matches(data, "app.clear") ||
        this.keybindings.matches(data, "tui.select.cancel") ||
        this.keybindings.matches(data, "cancel")
      ))
    ) {
      this.onDone({ action: "cancel" });
      return true;
    }

    // Navigation
    if (matchesKey(data, "left")) {
      this.selectedIndex = (this.selectedIndex - 1 + 4) % 4;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % 4;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "up")) {
      if (this.isTwoRowLayout) {
        this.selectedIndex = (this.selectedIndex + 2) % 4;
      } else {
        this.selectedIndex = (this.selectedIndex - 1 + 4) % 4;
      }
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down")) {
      if (this.isTwoRowLayout) {
        this.selectedIndex = (this.selectedIndex + 2) % 4;
      } else {
        this.selectedIndex = (this.selectedIndex + 1) % 4;
      }
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
    const boxWidth = Math.min(Math.max(width - 2, 40), 96);
    const contentWidth = Math.max(10, boxWidth - 6);
    const padLeft = " ".repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));

    const rawLines: string[] = [];

    // 1. Top border
    const title = this.plan.isMultiStage
      ? ` Multi-Stage Commit Proposal (${this.plan.stages.length} commits) `
      : " Commit Proposal ";
    const fillDash = Math.max(0, boxWidth - visibleWidth(title) - 4);
    rawLines.push(borderFn(`┌─${boldFn(accentFn(title))}${"─".repeat(fillDash)}─┐`));

    // 2. Commit Message Header / Stages List
    rawLines.push(this.boxLine("", contentWidth, borderFn));

    if (this.plan.isMultiStage) {
      rawLines.push(
        this.boxLine(
          boldFn(accentFn(`Planned Commits (${this.plan.stages.length} atomic stages):`)),
          contentWidth,
          borderFn
        )
      );

      for (let i = 0; i < this.plan.stages.length; i++) {
        const stage = this.plan.stages[i];
        const type = stage.type.trim().toLowerCase();
        const scope = stage.scope?.trim().toLowerCase();
        const subject = stage.subject.trim().replace(/\.$/, "");
        const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
        const count = stage.files?.length;
        const countStr = count ? ` (${count} file${count === 1 ? "" : "s"})` : "";

        rawLines.push(
          this.boxLine(
            `  ${boldFn(`${i + 1}. ${header}`)}${countStr ? mutedFn(countStr) : ""}`,
            contentWidth,
            borderFn
          )
        );

        if (stage.body?.trim()) {
          const firstBodyLine = stage.body.trim().split("\n")[0].trim().replace(/^[-*•]\s*/, "");
          if (firstBodyLine) {
            rawLines.push(
              this.boxLine(
                `     ${dimFn("• " + truncateToWidth(firstBodyLine, contentWidth - 10, "…"))}`,
                contentWidth,
                borderFn
              )
            );
          }
        }
      }
    } else {
      const single = this.plan.stages[0];
      rawLines.push(this.boxLine(boldFn(accentFn("Commit Message:")), contentWidth, borderFn));
      const headerWrapped = wrapTextWithAnsi(this.headerLine, Math.max(10, contentWidth - 2));
      for (const hLine of headerWrapped) {
        rawLines.push(this.boxLine(`  ${boldFn(hLine)}`, contentWidth, borderFn));
      }

      // Commit Body
      if (single?.body?.trim()) {
        rawLines.push(this.boxLine("", contentWidth, borderFn));
        const rawBodyLines = single.body.trim().split("\n");
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
    const commitLabel = this.plan.isMultiStage
      ? `Commit All (${this.plan.stages.length})`
      : "Commit";
    const editLabel = this.plan.isMultiStage ? "Edit Plan" : "Edit Message";

    const btnCommit = this.selectedIndex === 0
      ? boldFn(accentFn(`→ [ ✓ ${commitLabel} ]`))
      : dimFn(`  [ ✓ ${commitLabel} ]`);
    const btnPush = this.selectedIndex === 1
      ? boldFn(accentFn("→ [ ⇡ Commit & Push ]"))
      : dimFn("  [ ⇡ Commit & Push ]");
    const btnEdit = this.selectedIndex === 2
      ? boldFn(accentFn(`→ [ ✎ ${editLabel} ]`))
      : dimFn(`  [ ✎ ${editLabel} ]`);
    const btnCancel = this.selectedIndex === 3
      ? boldFn(accentFn("→ [ ✗ Cancel ]"))
      : dimFn("  [ ✗ Cancel ]");

    const singleRowCandidate = `${btnCommit}   ${btnPush}   ${btnEdit}   ${btnCancel}`;
    if (contentWidth >= visibleWidth(singleRowCandidate)) {
      this.isTwoRowLayout = false;
      rawLines.push(this.boxLine(singleRowCandidate, contentWidth, borderFn));
    } else {
      this.isTwoRowLayout = true;
      const col1Width = Math.max(visibleWidth(btnCommit), visibleWidth(btnEdit));
      const col2Width = Math.max(visibleWidth(btnPush), visibleWidth(btnCancel));
      const gap = Math.max(3, Math.min(6, contentWidth - col1Width - col2Width));

      const row1Pad = Math.max(2, col1Width - visibleWidth(btnCommit) + gap);
      const row2Pad = Math.max(2, col1Width - visibleWidth(btnEdit) + gap);

      const row1 = `${btnCommit}${" ".repeat(row1Pad)}${btnPush}`;
      const row2 = `${btnEdit}${" ".repeat(row2Pad)}${btnCancel}`;

      rawLines.push(this.boxLine(row1, contentWidth, borderFn));
      rawLines.push(this.boxLine(row2, contentWidth, borderFn));
    }

    // 9. Navigation hint
    rawLines.push(this.boxLine("", contentWidth, borderFn));
    const navHint = "Enter select • ←→/Tab navigate • c commit • p push • e edit • Esc cancel";
    if (contentWidth >= visibleWidth(navHint)) {
      rawLines.push(this.boxLine(dimFn(navHint), contentWidth, borderFn));
    } else {
      const navHint1 = "Enter select • Tab/Arrows navigate";
      const navHint2 = "c commit • p push • e edit • Esc cancel";
      rawLines.push(this.boxLine(dimFn(navHint1), contentWidth, borderFn));
      rawLines.push(this.boxLine(dimFn(navHint2), contentWidth, borderFn));
    }

    // 10. Bottom border
    rawLines.push(borderFn(`└${"─".repeat(boxWidth - 2)}┘`));

    return rawLines.map((line) => `${padLeft}${line}`);
  }
}
