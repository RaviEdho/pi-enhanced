import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { DialogFrame } from "../../ux/dialog.js";
import { formatCommitFiles, formatCost, formatDuration } from "./format.js";
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
  private frame: DialogFrame;
  private followSelection = false;
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
    this.frame = new DialogFrame(tui, theme);
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
    if (this.frame.handleInput(data)) return true;
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
      this.followSelection = true;
      this.frame.resetScroll();
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down") || data.toLowerCase() === "j" || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % 3;
      this.followSelection = true;
      this.frame.resetScroll();
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const isMulti = this.plan.stages.length > 1;
    const accentFn = (s: string) => (this.theme?.fg ? this.theme.fg("accent", s) : s);
    const boldFn = (s: string) => (this.theme?.bold ? this.theme.bold(s) : s);
    const mutedFn = (s: string) => (this.theme?.fg ? this.theme.fg("muted", s) : s);
    const textFn = (s: string) => (this.theme?.fg ? this.theme.fg("text", s) : s);

    const titleText = isMulti ? "Multi-Stage Commit Proposal" : "Commit Proposal";
    const costBadge = this.usage.totalCost > 0
      ? formatCost(this.usage.totalCost)
      : `${this.usage.totalTokens.toLocaleString()} tokens`;
    const rightBadge = `${this.usage.modelId} • ${costBadge}`;

    const lines: string[] = [];
    const append = (text: string, indent: number, style: (text: string) => string) => {
      for (const rawLine of text.split(/\r?\n/)) {
        for (const line of wrapTextWithAnsi(rawLine, Math.max(1, width - indent))) {
          lines.push(`${" ".repeat(indent)}${style(line)}`);
        }
      }
    };
    const appendBody = (body: string, indent: number) => {
      for (const rawLine of body.trim().split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          lines.push("");
          continue;
        }
        const isBullet = /^[-*•] /.test(trimmed);
        const text = isBullet ? trimmed.slice(2).trim() : trimmed;
        wrapTextWithAnsi(text, Math.max(1, width - indent - (isBullet ? 2 : 0)))
          .forEach((line, index) => {
            const prefix = " ".repeat(indent) + (isBullet ? (index === 0 ? "• " : "  ") : "");
            lines.push(`${prefix}${textFn(line)}`);
          });
      }
    };

    // Message preview
    if (isMulti) {
      for (let i = 0; i < this.plan.stages.length; i++) {
        const stage = this.plan.stages[i];
        const selectedFileCount = (stage.files?.length ?? 0) + new Set((stage.hunks ?? []).map((selection) => selection.filePath)).size;
        const selectedHunkCount = (stage.hunks ?? []).reduce((count, selection) => count + selection.hunkIds.length, 0);
        const countStr = selectedFileCount
          ? ` (${selectedFileCount} file${selectedFileCount === 1 ? "" : "s"}${selectedHunkCount ? `, ${selectedHunkCount} hunk${selectedHunkCount === 1 ? "" : "s"}` : ""})`
          : "";
        const typeScope = stage.scope ? `${stage.type}(${stage.scope})` : stage.type;
        const stageTitle = `${i + 1}. ${typeScope}: ${stage.subject}`;

        append(`${boldFn(textFn(stageTitle))}${countStr ? mutedFn(countStr) : ""}`, 2, (text) => text);

        const files = formatCommitFiles(stage);
        if (files) {
          append(`Files: ${files}`, 5, mutedFn);
        }
        if (stage.body?.trim()) {
          appendBody(stage.body, 5);
        }
        if (i < this.plan.stages.length - 1) {
          lines.push("");
        }
      }
    } else {
      const single = this.plan.stages[0];
      append(this.headerLine, 2, (text) => boldFn(accentFn(text)));

      if (single?.files?.length || single?.hunks?.length) {
        lines.push("");
        const files = formatCommitFiles(single);
        if (files) {
          append(`Files: ${files}`, 2, mutedFn);
        }
      }

      if (single?.body?.trim()) {
        lines.push("");
        appendBody(single.body, 2);
      }
    }

    lines.push("");

    // Staged overview line
    const stagedCount = this.overview.stagedFiles.length;
    const statSummary = this.overview.statSummary ? ` (${this.overview.statSummary.split("\n")[0].trim()})` : "";
    const turnsInfo = `${this.usage.turns} turn${this.usage.turns === 1 ? "" : "s"} in ${formatDuration(this.usage.durationMs)}`;
    const overviewLabel = this.overview.label ?? "Staged";
    append(`${overviewLabel}: ${stagedCount} file${stagedCount === 1 ? "" : "s"}${statSummary} • ${turnsInfo}`, 2, mutedFn);

    lines.push("");

    // Vertical Action List
    const actions = [
      isMulti ? `Commit all (${this.plan.stages.length} stages)` : "Commit",
      isMulti ? "Commit & push all" : "Commit & push",
      isMulti ? "Edit plan" : "Edit message",
    ];

    let focusLine: number | undefined;
    for (let i = 0; i < actions.length; i++) {
      const isSelected = i === this.selectedIndex;
      if (isSelected) {
        focusLine = lines.length;
        lines.push(`  ${accentFn("→")} ${boldFn(accentFn(actions[i]))}`);
      } else {
        lines.push(`    ${textFn(actions[i])}`);
      }
    }

    return this.frame.render(width, {
      title: titleText,
      metadata: rightBadge,
      content: lines,
      // Start with the proposal, then follow explicit action navigation. A stable
      // focusLine lets PgUp/PgDn inspect the entire preview without snapping back.
      focusLine: this.followSelection ? focusLine : undefined,
      hints: [
        rawKeyHint("↑↓", "navigate"),
        keyHint("tui.select.confirm", "confirm"),
        rawKeyHint("c", "commit"),
        rawKeyHint("p", "push"),
        rawKeyHint("e", "edit"),
        keyHint("tui.select.cancel", "cancel"),
      ],
    });
  }
}
