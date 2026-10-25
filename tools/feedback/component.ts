import {
  Input,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { QuestionItem, SingleAnswerDetail } from "./types.js";

const CUSTOM_CHOICE_LABEL = "✎ Type custom answer...";

function wrapQuestion(text: string, width: number): string[] {
  return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

interface InternalQuestionState {
  item: QuestionItem;
  isChoiceMode: boolean;
  options: string[];
  highlightedIndex: number;
  answered: boolean;
  selectedOptionIndex: number | null;
  selectedText: string | null;
  isCustom: boolean;
  textInput: Input;
  customInput: Input;
}

export interface QuestionnaireResult {
  answers: SingleAnswerDetail[];
  cancelled: boolean;
}

/**
 * Interactive multi-step question form component.
 *
 * Supports:
 * - Navigating next/back using Right (→) and Left (←) arrow keys without answering.
 * - Answering questions strictly via Enter.
 * - Instant typing on custom choice: simply arrow down to it and start typing immediately (no Enter required to start input).
 * - Preserving and visually marking previously answered choices (✔ selected) when returning to a question.
 * - Clean option labels without synthetic "Option 1:" prefixes.
 * - In-place editing and recap screen before submission.
 */
export class QuestionnaireComponent implements Component {
  private tui: TUI;
  private theme: any;
  private onDone: (result: QuestionnaireResult | undefined) => void;
  private states: InternalQuestionState[];
  private currentIndex: number; // 0..states.length - 1 (questions), or states.length (recap screen)
  private recapChoiceIndex = 0; // 0 = Submit, 1 = Edit
  private allowCustom: boolean;
  private showRecap: boolean;

  constructor(
    tui: TUI,
    theme: any,
    questions: QuestionItem[],
    onDone: (result: QuestionnaireResult | undefined) => void,
    options?: {
      allowCustom?: boolean;
      showRecap?: boolean;
    }
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.allowCustom = options?.allowCustom ?? true;
    this.showRecap = options?.showRecap ?? true;
    this.currentIndex = 0;

    this.states = questions.map((item) => {
      const isChoiceMode = Array.isArray(item.choices) && item.choices.length > 0;
      const opts: string[] = isChoiceMode ? [...item.choices!] : [];
      if (isChoiceMode && this.allowCustom) {
        opts.push(CUSTOM_CHOICE_LABEL);
      }

      const textInput = new Input({
        prompt: "  ❯ ",
      });
      textInput.focused = true;

      const customInput = new Input({
        prompt: "",
      });
      customInput.focused = true;

      return {
        item,
        isChoiceMode,
        options: opts,
        highlightedIndex: 0,
        answered: false,
        selectedOptionIndex: null,
        selectedText: null,
        isCustom: false,
        textInput,
        customInput,
      };
    });
  }

  public invalidate(): void {}

  public handleInput(data: string): boolean {
    // 1. Cancellation / Dismissal (Esc, Ctrl+C)
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "\x1b" ||
      data === "\x03"
    ) {
      this.onDone(undefined);
      return true;
    }

    const total = this.states.length;
    const isRecapScreen = this.currentIndex === total;

    // 2. Recap Screen Input Handling
    if (isRecapScreen) {
      // Navigate back to previous question using Left Arrow or Shift-Tab
      if (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") {
        this.currentIndex = Math.max(0, total - 1);
        this.syncHighlightedChoice(this.currentIndex);
        this.tui.requestRender();
        return true;
      }

      // Up / Down to toggle between "Submit answers" and "Edit answers"
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        data === "k" ||
        data === "j" ||
        data === "\t"
      ) {
        this.recapChoiceIndex = this.recapChoiceIndex === 0 ? 1 : 0;
        this.tui.requestRender();
        return true;
      }

      // Enter on Recap screen
      if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
        if (this.recapChoiceIndex === 0) {
          // Submit answers!
          const answers: SingleAnswerDetail[] = this.states.map((st) => ({
            question: st.item.question,
            response: st.answered ? (st.selectedText ?? "") : "(skipped / not answered)",
            isChoice: st.isChoiceMode,
            isCustom: st.isCustom,
            cancelled: !st.answered,
          }));

          this.onDone({
            answers,
            cancelled: false,
          });
          return true;
        } else {
          // Edit answers: jump back to question 0
          this.currentIndex = 0;
          this.syncHighlightedChoice(this.currentIndex);
          this.tui.requestRender();
          return true;
        }
      }

      return true;
    }

    // 3. Question Form Input Handling
    const st = this.states[this.currentIndex];

    // Branch A: Choice Mode
    if (st.isChoiceMode) {
      const isCustomHighlighted = st.options[st.highlightedIndex] === CUSTOM_CHOICE_LABEL;

      // When highlighted on the custom choice, allow immediate direct typing!
      if (isCustomHighlighted) {
        // Enter: confirm typed custom answer
        if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
          const trimmed = st.customInput.getValue().trim();
          st.answered = true;
          st.selectedOptionIndex = st.options.length - 1;
          st.selectedText = trimmed.length > 0 ? trimmed : "(Empty custom response)";
          st.isCustom = true;

          this.advanceNextQuestion();
          return true;
        }

        // Up Arrow: move highlight up to standard choices
        if (matchesKey(data, "up") || data === "\x1b[A") {
          st.highlightedIndex = Math.max(0, st.highlightedIndex - 1);
          this.tui.requestRender();
          return true;
        }

        // Left Arrow at beginning of custom text: navigate back to previous question without answering
        if (
          (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") &&
          ((st.customInput as any).cursor === 0)
        ) {
          if (this.currentIndex > 0) {
            this.currentIndex--;
            this.syncHighlightedChoice(this.currentIndex);
            this.tui.requestRender();
            return true;
          }
          return true;
        }

        // Right Arrow at end of custom text: navigate forward to next question without answering
        if (
          (matchesKey(data, "right") || data === "\x1b[C" || data === "\t") &&
          ((st.customInput as any).cursor === st.customInput.getValue().length)
        ) {
          if (this.currentIndex < total - 1) {
            this.currentIndex++;
            this.syncHighlightedChoice(this.currentIndex);
            this.tui.requestRender();
            return true;
          } else if (this.showRecap && this.currentIndex === total - 1) {
            this.currentIndex = total;
            this.tui.requestRender();
            return true;
          }
          return true;
        }

        // Immediately handle typing (printable characters, backspace, cursor movement)
        st.customInput.handleInput(data);
        this.tui.requestRender();
        return true;
      }

      // Standard Choice Navigation (not on custom option)
      // Left Arrow: Navigate to previous question without answering
      if (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") {
        if (this.currentIndex > 0) {
          this.currentIndex--;
          this.syncHighlightedChoice(this.currentIndex);
          this.tui.requestRender();
          return true;
        }
        return true;
      }

      // Right Arrow: Navigate to next question without answering
      if (matchesKey(data, "right") || data === "\x1b[C" || data === "\t") {
        if (this.currentIndex < total - 1) {
          this.currentIndex++;
          this.syncHighlightedChoice(this.currentIndex);
          this.tui.requestRender();
          return true;
        } else if (this.showRecap && this.currentIndex === total - 1) {
          this.currentIndex = total;
          this.tui.requestRender();
          return true;
        }
        return true;
      }

      // Up / Down: Move highlighted choice
      if (matchesKey(data, "up") || data === "k") {
        st.highlightedIndex = Math.max(0, st.highlightedIndex - 1);
        this.tui.requestRender();
        return true;
      }

      if (matchesKey(data, "down") || data === "j") {
        st.highlightedIndex = Math.min(st.options.length - 1, st.highlightedIndex + 1);
        this.tui.requestRender();
        return true;
      }

      // Numeric shortcut: pressing 1..9 jumps to that choice
      if (data.length === 1 && data >= "1" && data <= "9") {
        const numIdx = parseInt(data, 10) - 1;
        if (numIdx >= 0 && numIdx < st.options.length) {
          st.highlightedIndex = numIdx;
          this.tui.requestRender();
          return true;
        }
      }

      // Enter: Confirm answer for standard choice
      if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
        const chosen = st.options[st.highlightedIndex];
        st.answered = true;
        st.selectedOptionIndex = st.highlightedIndex;
        st.selectedText = chosen;
        st.isCustom = false;

        this.advanceNextQuestion();
        return true;
      }

      return false;
    }

    // Branch B: Freeform Text Input Mode
    // Enter: Confirm answer for text input
    if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      const trimmed = st.textInput.getValue().trim();
      st.answered = true;
      st.selectedText = trimmed.length > 0 ? trimmed : "(Empty response)";
      st.isCustom = false;

      this.advanceNextQuestion();
      return true;
    }

    // Left Arrow at beginning of input: Go back to previous question without answering
    if (
      (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") &&
      ((st.textInput as any).cursor === 0)
    ) {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        this.syncHighlightedChoice(this.currentIndex);
        this.tui.requestRender();
        return true;
      }
      return true;
    }

    // Right Arrow at end of input: Go to next question without answering
    if (
      (matchesKey(data, "right") || data === "\x1b[C" || data === "\t") &&
      ((st.textInput as any).cursor === st.textInput.getValue().length)
    ) {
      if (this.currentIndex < total - 1) {
        this.currentIndex++;
        this.syncHighlightedChoice(this.currentIndex);
        this.tui.requestRender();
        return true;
      } else if (this.showRecap && this.currentIndex === total - 1) {
        this.currentIndex = total;
        this.tui.requestRender();
        return true;
      }
      return true;
    }

    // Delegate text typing, cursor movement, Kitty keys to Input component
    st.textInput.handleInput(data);
    this.tui.requestRender();
    return true;
  }

  private advanceNextQuestion(): void {
    const total = this.states.length;
    if (this.currentIndex < total - 1) {
      this.currentIndex++;
      this.syncHighlightedChoice(this.currentIndex);
    } else {
      if (this.showRecap) {
        this.currentIndex = total;
      } else {
        const answers: SingleAnswerDetail[] = this.states.map((st) => ({
          question: st.item.question,
          response: st.answered ? (st.selectedText ?? "") : "(skipped)",
          isChoice: st.isChoiceMode,
          isCustom: st.isCustom,
          cancelled: !st.answered,
        }));
        this.onDone({ answers, cancelled: false });
        return;
      }
    }
    this.tui.requestRender();
  }

  /**
   * If a question was previously answered, sync its highlight to the original choice.
   */
  private syncHighlightedChoice(index: number): void {
    if (index >= 0 && index < this.states.length) {
      const s = this.states[index];
      if (s.isChoiceMode && s.answered && s.selectedOptionIndex !== null) {
        s.highlightedIndex = s.selectedOptionIndex;
      }
    }
  }

  public render(width: number): string[] {
    const lines: string[] = [];
    const total = this.states.length;
    const isRecap = this.currentIndex === total;

    // Titled top border
    const title = width >= 11 ? " Ask User " : "";
    const borderFill = Math.max(0, width - title.length - 1);
    lines.push(
      `${this.theme.fg("border", "─")}${title ? this.theme.fg("accent", this.theme.bold(title)) : ""}${this.theme.fg("border", "─".repeat(borderFill))}`
    );

    // Header tabs (if multiple questions)
    if (total > 1) {
      const tabParts: string[] = [];
      for (let i = 0; i < total; i++) {
        const s = this.states[i];
        const isCurrent = this.currentIndex === i;
        const statusMark = s.answered ? "●" : "○";
        const label = `Q${i + 1} ${statusMark}`;

        if (isCurrent) {
          tabParts.push(this.theme.fg("accent", this.theme.bold(`[ ${label} ]`)));
        } else if (s.answered) {
          tabParts.push(this.theme.fg("success", label));
        } else {
          tabParts.push(this.theme.fg("dim", label));
        }
      }

      if (this.showRecap) {
        const reviewLabel = "Review";
        if (isRecap) {
          tabParts.push(this.theme.fg("accent", this.theme.bold(`[ ${reviewLabel} ]`)));
        } else {
          tabParts.push(this.theme.fg("dim", reviewLabel));
        }
      }

      lines.push("  " + tabParts.join("  "));
      lines.push("");
    }

    // Body content
    if (isRecap) {
      lines.push(
        "  " + this.theme.fg("accent", this.theme.bold("Review your responses:"))
      );
      lines.push("");

      for (let i = 0; i < total; i++) {
        const s = this.states[i];
        const num = `${i + 1}.`;
        const questionPrefix = `  ${num} `;
        const wrappedQuestion = wrapQuestion(s.item.question, Math.max(1, width - 8));
        for (let lineIndex = 0; lineIndex < wrappedQuestion.length; lineIndex++) {
          const prefix =
            lineIndex === 0
              ? `  ${this.theme.fg("dim", num)} `
              : " ".repeat(questionPrefix.length);
          lines.push(`${prefix}${this.theme.fg("text", wrappedQuestion[lineIndex] || "")}`);
        }

        if (s.answered) {
          const customTag = s.isCustom ? this.theme.fg("warning", "[custom] ") : "";
          lines.push(`     → ${customTag}${this.theme.fg("success", s.selectedText || "")}`);
        } else {
          lines.push(`     → ${this.theme.fg("dim", "(skipped / not answered)")}`);
        }
      }

      lines.push("");
      lines.push("  " + this.theme.fg("muted", "Proceed with these responses?"));
      lines.push("");

      const options = ["Submit responses", "Edit answers"];
      for (let j = 0; j < options.length; j++) {
        const isSel = j === this.recapChoiceIndex;
        if (isSel) {
          lines.push(
            "  " +
              this.theme.fg("accent", "→ ") +
              this.theme.fg("accent", this.theme.bold(options[j]))
          );
        } else {
          lines.push("    " + this.theme.fg("dim", options[j]));
        }
      }
    } else {
      const st = this.states[this.currentIndex];
      if (total > 1) {
        lines.push(
          "  " +
            this.theme.fg("muted", `[Question ${this.currentIndex + 1} of ${total}]`)
        );
      }
      const wrappedQuestion = wrapQuestion(st.item.question, Math.max(1, width - 4));
      for (const questionLine of wrappedQuestion) {
        lines.push("  " + this.theme.fg("accent", this.theme.bold(questionLine)));
      }
      lines.push("");

      if (st.isChoiceMode) {
        for (let optIdx = 0; optIdx < st.options.length; optIdx++) {
          const opt = st.options[optIdx];
          const isHighlighted = optIdx === st.highlightedIndex;
          const isOriginallySelected = st.answered && st.selectedOptionIndex === optIdx;

          if (opt === CUSTOM_CHOICE_LABEL) {
            if (isHighlighted) {
              // Active inline typing for custom choice with normal white full block cursor
              const customVal = st.customInput.getValue();
              const cursor = (st.customInput as any).cursor ?? customVal.length;
              const before = customVal.slice(0, cursor);

              let cursorDisplay: string;
              if (customVal.length === 0) {
                const firstChar = "\x1b[30;47mT\x1b[0m";
                const rest = this.theme.fg("dim", "ype custom answer...");
                cursorDisplay = `${firstChar}${rest}`;
              } else if (cursor < customVal.length) {
                const charUnder = customVal[cursor];
                cursorDisplay = `\x1b[30;47m${charUnder}\x1b[0m${customVal.slice(cursor + 1)}`;
              } else {
                cursorDisplay = "\x1b[97m█\x1b[39m";
              }

              const displayVal =
                customVal.length === 0
                  ? cursorDisplay
                  : `${before}${cursorDisplay}`;

              lines.push(`  ${this.theme.fg("accent", "→ ✎ ")}${displayVal}`);
            } else {
              if (st.isCustom && st.selectedText) {
                lines.push(
                  `    ${this.theme.fg("dim", "✎ ")}${this.theme.fg("success", `"${st.selectedText}" ✔ (selected)`)}`
                );
              } else {
                lines.push(`    ${this.theme.fg("dim", "✎ Type custom answer...")}`);
              }
            }
          } else {
            const cursorPrefix = isHighlighted
              ? this.theme.fg("accent", "→ ")
              : "  ";

            let labelText = isHighlighted
              ? this.theme.fg("accent", opt)
              : this.theme.fg("text", opt);

            // Visually mark the original choice if this question was already answered!
            if (isOriginallySelected) {
              labelText += `  ${this.theme.fg("success", "✔ (selected)")}`;
            }

            lines.push("  " + cursorPrefix + labelText);
          }
        }
      } else {
        lines.push("  " + this.theme.fg("muted", "Type your response (press Enter to confirm):"));
        lines.push("");

        const val = st.textInput.getValue();
        const cursor = (st.textInput as any).cursor ?? val.length;

        if (val.length === 0) {
          const placeholder = st.item.placeholder || "Type your response...";
          const firstChar = placeholder[0] || " ";
          const rest = placeholder.slice(1);
          const cursorChar = `\x1b[30;47m${firstChar}\x1b[0m`;
          const restFaded = this.theme.fg("dim", rest);
          lines.push(`  ❯ ${cursorChar}${restFaded}`);
        } else {
          const before = val.slice(0, cursor);
          let cursorDisplay: string;
          if (cursor < val.length) {
            const charUnder = val[cursor];
            cursorDisplay = `\x1b[30;47m${charUnder}\x1b[0m${val.slice(cursor + 1)}`;
          } else {
            cursorDisplay = "\x1b[97m█\x1b[39m";
          }
          lines.push(`  ❯ ${before}${cursorDisplay}`);
        }

        if (st.answered && st.selectedText) {
          lines.push("");
          lines.push(
            "  " +
              this.theme.fg("dim", "Confirmed answer: ") +
              this.theme.fg("success", `"${st.selectedText}"`)
          );
        }
      }
    }

    lines.push("");

    // Bottom navigation hints
    const navHint =
      total > 1
        ? "←/→ navigate questions  •  "
        : "";
    const activeSt = !isRecap ? this.states[this.currentIndex] : undefined;

    const actionHint = isRecap
      ? "↑/↓ toggle  •  Enter confirm  •  Esc cancel"
      : activeSt?.isChoiceMode
      ? "↑/↓ choose  •  Enter confirm  •  Esc cancel"
      : "Enter confirm  •  Esc cancel";

    lines.push(
      "  " + this.theme.fg("dim", `${navHint}${actionHint}`)
    );

    // Bottom border
    lines.push(this.theme.fg("border", "─".repeat(Math.max(1, width))));

    return lines;
  }
}
