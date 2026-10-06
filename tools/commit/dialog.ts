import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { formatCost, formatDuration } from "./format.js";
import type {
  CommitActionEntry,
  CommitConfirmationResult,
  CommitPlanProposal,
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
  private overview: GitStagedOverview;
  private usage: CommitUsageCost;
  private onDone: (result: CommitConfirmationResult) => void;
  private keybindings?: any;
  private selectedIndex: number = 0; // 0 = Commit, 1 = Commit & Push, 2 = Edit
  private fullMessage: string = "";
  private headerLine: string = "";

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
    this.overview = options.overview;
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
      } else {
        this.onDone({ action: "edit", message: this.fullMessage, stages: this.plan.stages });
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
    if (matchesKey(data, "up") || data.toLowerCase() === "k") {
      this.selectedIndex = (this.selectedIndex - 1 + 3) % 3;
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down") || data.toLowerCase() === "j" || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % 3;
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const isMulti = this.plan.stages.length > 1;
    const accentFn = (s: string) => (this.theme?.fg ? this.theme.fg("accent", s) : s);
    const borderFn = (s: string) => (this.theme?.fg ? this.theme.fg("border", s) : s);
    const boldFn = (s: string) => (this.theme?.bold ? this.theme.bold(s) : s);
    const dimFn = (s: string) => (this.theme?.fg ? this.theme.fg("dim", s) : s);
    const mutedFn = (s: string) => (this.theme?.fg ? this.theme.fg("muted", s) : s);
    const textFn = (s: string) => (this.theme?.fg ? this.theme.fg("text", s) : s);

    const titleText = isMulti ? "Multi-Stage Commit Proposal" : "Commit Proposal";
    const costBadge = this.usage.totalCost > 0
      ? formatCost(this.usage.totalCost)
      : `${this.usage.totalTokens.toLocaleString()} tokens`;
    const rightBadge = `${this.usage.modelId} • ${costBadge}`;

    // Top border line: ── Title ──────────────────────── badge ──
    const leftPart = `${borderFn("── ")}${boldFn(accentFn(titleText))} `;
    const leftVisible = visibleWidth(`── ${titleText} `);
    const rightPart = ` ${dimFn(rightBadge)}${borderFn(" ──")}`;
    const rightVisible = visibleWidth(` ${rightBadge} ──`);

    let topBorder: string;
    if (leftVisible + rightVisible + 2 <= width) {
      const fillCount = Math.max(1, width - leftVisible - rightVisible);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${rightPart}`;
    } else {
      const fillCount = Math.max(1, width - leftVisible - 2);
      topBorder = `${leftPart}${borderFn("─".repeat(fillCount))}${borderFn("──")}`;
    }

    const lines: string[] = [topBorder, ""];

    // Message preview
    if (isMulti) {
      for (let i = 0; i < this.plan.stages.length; i++) {
        const stage = this.plan.stages[i];
        const count = stage.files?.length || 0;
        const countStr = count ? ` (${count} file${count === 1 ? "" : "s"})` : "";
        const typeScope = stage.scope ? `${stage.type}(${stage.scope})` : stage.type;
        const stageTitle = `${i + 1}. ${typeScope}: ${stage.subject}`;

        lines.push(`  ${boldFn(textFn(stageTitle))}${countStr ? mutedFn(countStr) : ""}`);

        if (stage.body?.trim()) {
          const firstBodyLine = stage.body.trim().split("\n")[0].trim().replace(/^[-*•]\s*/, "");
          if (firstBodyLine) {
            lines.push(`     ${dimFn("• " + truncateToWidth(firstBodyLine, Math.max(10, width - 8), "…"))}`);
          }
        }
        if (i < this.plan.stages.length - 1) {
          lines.push("");
        }
      }
    } else {
      const single = this.plan.stages[0];
      const headerWrapped = wrapTextWithAnsi(this.headerLine, Math.max(10, width - 4));
      for (const hLine of headerWrapped) {
        lines.push(`  ${boldFn(accentFn(hLine))}`);
      }

      if (single?.body?.trim()) {
        lines.push("");
        const rawBodyLines = single.body.trim().split("\n");
        for (const rawLine of rawBodyLines) {
          const trimmed = rawLine.trim();
          if (!trimmed) {
            lines.push("");
            continue;
          }
          const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ");
          const textAfterBullet = isBullet ? trimmed.slice(2).trim() : trimmed;

          if (isBullet) {
            const wrapped = wrapTextWithAnsi(textAfterBullet, Math.max(10, width - 6));
            wrapped.forEach((line, idx) => {
              const prefix = idx === 0 ? "  • " : "    ";
              lines.push(`${prefix}${textFn(line)}`);
            });
          } else {
            const wrapped = wrapTextWithAnsi(trimmed, Math.max(10, width - 4));
            wrapped.forEach((line) => {
              lines.push(`  ${textFn(line)}`);
            });
          }
        }
      }
    }

    lines.push("");

    // Staged overview line
    const stagedCount = this.overview.stagedFiles.length;
    const statSummary = this.overview.statSummary ? ` (${this.overview.statSummary.split("\n")[0].trim()})` : "";
    const turnsInfo = `${this.usage.turns} turn${this.usage.turns === 1 ? "" : "s"} in ${formatDuration(this.usage.durationMs)}`;
    lines.push(mutedFn(`  Staged: ${stagedCount} file${stagedCount === 1 ? "" : "s"}${statSummary} • ${turnsInfo}`));

    lines.push("");

    // Vertical Action List
    const actions = [
      isMulti ? `Commit all (${this.plan.stages.length} stages)` : "Commit",
      isMulti ? "Commit & push all" : "Commit & push",
      isMulti ? "Edit plan" : "Edit message",
    ];

    for (let i = 0; i < actions.length; i++) {
      const isSelected = i === this.selectedIndex;
      if (isSelected) {
        lines.push(`  ${accentFn(">")} ${boldFn(accentFn(actions[i]))}`);
      } else {
        lines.push(`    ${textFn(actions[i])}`);
      }
    }

    lines.push("");

    // Native Key Hints
    const hints = [
      rawKeyHint("↑↓", "navigate"),
      keyHint("tui.select.confirm", "confirm"),
      rawKeyHint("c", "commit"),
      rawKeyHint("p", "push"),
      rawKeyHint("e", "edit"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");

    lines.push(`  ${hints}`);
    lines.push("");

    // Bottom border
    lines.push(borderFn("─".repeat(Math.max(1, width))));

    return lines;
  }
}
