import {
  Input,
  matchesKey,
  wrapTextWithAnsi,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { QuestionItem, SingleAnswerDetail } from "./types.js";
import { DialogFrame } from "../../ux/dialog.js";

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
export class QuestionnaireComponent implements Component, Focusable {
  public focused = false;
  private frame: DialogFrame;
  private renderedIndex = -1;
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
    this.frame = new DialogFrame(tui, theme);
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
        prompt: "",
        placeholder: item.placeholder || "Type your response...",
        placeholderStyle: (text) => this.theme.fg("dim", text),
      });
      const customInput = new Input({
        prompt: "",
        placeholder: "Type custom answer...",
        placeholderStyle: (text) => this.theme.fg("dim", text),
      });

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

  public invalidate(): void {
    for (const st of this.states) {
      st.textInput.invalidate();
      st.customInput.invalidate();
    }
  }

  private requestRender(): void {
    // A control interaction should reveal the active row, even after paging away.
    // Ordinary renders and PgUp/PgDn leave the viewport alone.
    this.frame.resetScroll();
    this.tui.requestRender();
  }

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

    if (this.frame.handleInput(data)) return true;

    const total = this.states.length;
    const isRecapScreen = this.currentIndex === total;

    // 2. Recap Screen Input Handling
    if (isRecapScreen) {
      // Navigate back to previous question using Left Arrow or Shift-Tab
      if (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") {
        this.currentIndex = Math.max(0, total - 1);
        this.syncHighlightedChoice(this.currentIndex);
        this.requestRender();
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
        this.requestRender();
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
          this.requestRender();
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
          this.requestRender();
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
            this.requestRender();
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
            this.requestRender();
            return true;
          } else if (this.showRecap && this.currentIndex === total - 1) {
            this.currentIndex = total;
            this.requestRender();
            return true;
          }
          return true;
        }

        // Immediately handle typing (printable characters, backspace, cursor movement)
        st.customInput.handleInput(data);
        this.requestRender();
        return true;
      }

      // Standard Choice Navigation (not on custom option)
      // Left Arrow: Navigate to previous question without answering
      if (matchesKey(data, "left") || data === "\x1b[D" || data === "\x1b[Z") {
        if (this.currentIndex > 0) {
          this.currentIndex--;
          this.syncHighlightedChoice(this.currentIndex);
          this.requestRender();
          return true;
        }
        return true;
      }

      // Right Arrow: Navigate to next question without answering
      if (matchesKey(data, "right") || data === "\x1b[C" || data === "\t") {
        if (this.currentIndex < total - 1) {
          this.currentIndex++;
          this.syncHighlightedChoice(this.currentIndex);
          this.requestRender();
          return true;
        } else if (this.showRecap && this.currentIndex === total - 1) {
          this.currentIndex = total;
          this.requestRender();
          return true;
        }
        return true;
      }

      // Up / Down: Move highlighted choice
      if (matchesKey(data, "up") || data === "k") {
        st.highlightedIndex = Math.max(0, st.highlightedIndex - 1);
        this.requestRender();
        return true;
      }

      if (matchesKey(data, "down") || data === "j") {
        st.highlightedIndex = Math.min(st.options.length - 1, st.highlightedIndex + 1);
        this.requestRender();
        return true;
      }

      // Numeric shortcut: pressing 1..9 jumps to that choice
      if (data.length === 1 && data >= "1" && data <= "9") {
        const numIdx = parseInt(data, 10) - 1;
        if (numIdx >= 0 && numIdx < st.options.length) {
          st.highlightedIndex = numIdx;
          this.requestRender();
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
        this.requestRender();
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
        this.requestRender();
        return true;
      } else if (this.showRecap && this.currentIndex === total - 1) {
        this.currentIndex = total;
        this.requestRender();
        return true;
      }
      return true;
    }

    // Delegate text typing, cursor movement, Kitty keys to Input component
    st.textInput.handleInput(data);
    this.requestRender();
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
    this.requestRender();
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
    if (this.renderedIndex !== this.currentIndex) {
      this.frame.resetScroll();
      this.renderedIndex = this.currentIndex;
    }
    for (const st of this.states) {
      st.textInput.focused = false;
      st.customInput.focused = false;
    }

    // Wrap all user-provided content before handing it to the bounded viewport.
    const append = (text: string, prefix: string, style: (text: string) => string, continuation = prefix) => {
      wrapQuestion(text, width - Math.max(visibleWidth(prefix), visibleWidth(continuation)))
        .forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${style(line)}`));
    };
    const color = (token: string) => (text: string) => this.theme.fg(token, text);
    let focusLine: number | undefined;

    if (total > 1) {
      const tabs = this.states.map((st, index) => {
        const label = `Q${index + 1} ${st.answered ? "●" : "○"}`;
        return this.currentIndex === index
          ? this.theme.fg("accent", this.theme.bold(`[ ${label} ]`))
          : this.theme.fg(st.answered ? "success" : "dim", label);
      });
      if (this.showRecap) {
        tabs.push(isRecap
          ? this.theme.fg("accent", this.theme.bold("[ Review ]"))
          : this.theme.fg("dim", "Review"));
      }
      append(tabs.join("  "), "  ", (text) => text);
      lines.push("");
    }

    if (isRecap) {
      append("Review your responses:", "  ", (text) => this.theme.fg("accent", this.theme.bold(text)));
      lines.push("");
      for (let i = 0; i < total; i++) {
        const st = this.states[i];
        const prefix = `  ${i + 1}. `;
        append(st.item.question, prefix, color("text"), " ".repeat(visibleWidth(prefix)));
        const response = st.answered
          ? `${st.isCustom ? this.theme.fg("warning", "[custom] ") : ""}${this.theme.fg("success", st.selectedText || "")}`
          : this.theme.fg("dim", "(skipped / not answered)");
        append(response, "     → ", (text) => text, "       ");
      }
      lines.push("");
      append("Proceed with these responses?", "  ", color("muted"));
      lines.push("");
      ["Submit responses", "Edit answers"].forEach((option, index) => {
        const selected = index === this.recapChoiceIndex;
        if (selected) focusLine = lines.length;
        append(option, selected ? this.theme.fg("accent", "  → ") : "    ",
          selected ? (text) => this.theme.fg("accent", this.theme.bold(text)) : color("dim"), "    ");
      });
    } else {
      const st = this.states[this.currentIndex];
      append(st.item.question, "  ", (text) => this.theme.fg("accent", this.theme.bold(text)));
      lines.push("");

      if (st.isChoiceMode) {
        st.options.forEach((option, index) => {
          const highlighted = index === st.highlightedIndex;
          const originallySelected = st.answered && st.selectedOptionIndex === index;
          if (highlighted) focusLine = lines.length;
          if (option === CUSTOM_CHOICE_LABEL) {
            if (highlighted) {
              st.customInput.focused = this.focused;
              const prefix = this.theme.fg("accent", "  → ✎ ");
              lines.push(prefix + st.customInput.render(Math.max(1, width - visibleWidth(prefix)))[0]);
            } else {
              const label = st.isCustom && st.selectedText
                ? `✎ ${this.theme.fg("success", `"${st.selectedText}" ✔ (selected)`)}`
                : CUSTOM_CHOICE_LABEL;
              append(label, "    ", color("dim"));
            }
          } else {
            const label = this.theme.fg(highlighted ? "accent" : "text", option)
              + (originallySelected ? `  ${this.theme.fg("success", "✔ (selected)")}` : "");
            append(label, highlighted ? this.theme.fg("accent", "  → ") : "    ", (text) => text, "    ");
          }
        });
      } else {
        append("Type your response (press Enter to confirm):", "  ", color("muted"));
        lines.push("");
        st.textInput.focused = this.focused;
        focusLine = lines.length;
        const prefix = "  ❯ ";
        lines.push(prefix + st.textInput.render(Math.max(1, width - visibleWidth(prefix)))[0]);
        if (st.answered && st.selectedText) {
          lines.push("");
          append(`${this.theme.fg("dim", "Confirmed answer: ")}${this.theme.fg("success", `"${st.selectedText}"`)}`,
            "  ", (text) => text);
        }
      }
    }

    const active = !isRecap ? this.states[this.currentIndex] : undefined;
    return this.frame.render(width, {
      title: "Ask User",
      metadata: isRecap ? "Review" : `Question ${this.currentIndex + 1} of ${total}`,
      content: lines,
      focusLine,
      hints: [
        ...(total > 1 ? ["←/→ navigate questions"] : []),
        ...(isRecap ? ["↑/↓ toggle"] : active?.isChoiceMode ? ["↑/↓ choose"] : []),
        "Enter confirm",
        "Esc cancel",
      ],
    });
  }
}
