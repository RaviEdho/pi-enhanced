import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { QuestionnaireComponent, type QuestionnaireResult } from "./component.js";
import {
  AskUserParametersSchema,
  type AskUserParameters,
  type AskUserResultDetails,
  type QuestionItem,
  type SingleAnswerDetail,
} from "./types.js";

const CUSTOM_CHOICE_LABEL = "✎ Type custom answer...";

/**
 * Creates the unified `ask_user` tool definition.
 * Seamlessly handles:
 * 1. Single open-ended questions via freeform text input (`ctx.ui.input`).
 * 2. Single structured decisions via choice selector (`ctx.ui.select`).
 * 3. Multiple sequential questions with Left/Right arrow navigation (without answering) and Enter to confirm.
 * 4. Preserves and marks original selection (✔ selected) when returning to a question.
 * 5. Pre-submission recap screen summarizing all responses with confirmation/edit options.
 */
export function createAskUserToolDefinition(): ToolDefinition<
  typeof AskUserParametersSchema,
  AskUserResultDetails
> {
  return {
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user for feedback, clarification, or decisions. Pauses execution and prompts the user in the interactive terminal. Supports single questions (via 'question' and optional 'choices') or multiple sequential questions (via 'questions'). For choices, recommended: 3 distinct clean options (e.g. ['PostgreSQL [recommended]', 'SQLite', 'MongoDB'] without 'Option 1:' prefixes). Reviews responses before submitting.",
    promptSnippet: "ask_user(question?, choices?, questions?): Prompt user for feedback, 3 choices, or multiple questions",
    promptGuidelines: [
      "Use 'ask_user' when you need information, preferences, clarification, or architectural direction before proceeding.",
      "To ask a single question, provide 'question'. For trade-offs or design choices, provide 'choices' with 3 distinct options (e.g. ['PostgreSQL [recommended]', 'SQLite', 'MongoDB']). Do NOT prefix with 'Option 1:' or 'Option 2:'.",
      "To ask multiple questions in one go without back-and-forth turns, provide 'questions' with an array of questions (each with its own question text, optional choices, and placeholder).",
      "Do not invent synthetic [Cancel] or [Back] options in choices; the user can dismiss via Esc at any time.",
    ],
    exposure: "model-only",
    parameters: AskUserParametersSchema,
    async execute(_toolCallId, params: AskUserParameters, signal, _onUpdate, ctx) {
      // 0. Guard if tool is disabled in settings
      const store = EnhancedSettingsStore.getInstance();
      if (!store.get("feedback.askUser")) {
        return {
          content: [
            {
              type: "text",
              text: "Interactive user feedback is currently disabled in settings ('feedback.askUser': false). Please proceed autonomously without prompting the user.",
            },
          ],
          details: {
            answers: [],
            cancelled: true,
          },
          isError: true,
        };
      }

      // 1. Normalize input into a list of questions
      const normalizedQuestions: QuestionItem[] = [];
      if (Array.isArray(params.questions) && params.questions.length > 0) {
        normalizedQuestions.push(...params.questions);
      } else if (params.question) {
        normalizedQuestions.push({
          question: params.question,
          choices: params.choices,
          placeholder: params.placeholder,
        });
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either 'question' (for a single question) or 'questions' (for multiple questions) must be provided to ask_user.",
            },
          ],
          details: {
            answers: [],
            cancelled: true,
          },
          isError: true,
        };
      }

      // 2. Guard non-interactive environments
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Interactive UI is not available in non-interactive environment (hasUI = false). Unable to prompt user. Please proceed autonomously using best judgment or standard conventions.",
            },
          ],
          details: {
            answers: [],
            cancelled: true,
          },
          isError: true,
        };
      }

      const total = normalizedQuestions.length;
      const shouldRecap = params.recap !== false;

      // 3. Primary: Dedicated interactive questionnaire component with Left/Right navigation
      if (typeof (ctx.ui as any)?.custom === "function") {
        try {
          const result = await (ctx.ui as any).custom(
            (tui: any, theme: any, _kb: any, done: (res: QuestionnaireResult | undefined) => void) => {
              if (signal?.aborted) {
                done(undefined);
              }
              signal?.addEventListener("abort", () => done(undefined), { once: true });

              return new QuestionnaireComponent(tui, theme, normalizedQuestions, done, {
                allowCustom: params.allow_custom ?? true,
                showRecap: shouldRecap,
              });
            }
          );

          if (!result || result.cancelled) {
            return {
              content: [
                {
                  type: "text",
                  text: "The user dismissed/cancelled the questions without submitting answers.",
                },
              ],
              details: {
                answers: [],
                cancelled: true,
              },
            };
          }

          // Single question result format
          if (total === 1) {
            const single = result.answers[0];
            if (single.cancelled) {
              return {
                content: [
                  {
                    type: "text",
                    text: "The user dismissed/cancelled the prompt without providing an answer.",
                  },
                ],
                details: {
                  question: normalizedQuestions[0]?.question,
                  answers: [],
                  cancelled: true,
                },
              };
            }

            const resultText = single.isChoice
              ? single.isCustom
                ? `Selected custom response: ${single.response}`
                : `Selected: ${single.response}`
              : single.response || "";

            return {
              content: [{ type: "text", text: resultText }],
              details: {
                question: single.question,
                response: single.response,
                isChoice: single.isChoice,
                isCustom: single.isCustom,
                answers: result.answers,
                cancelled: false,
              },
            };
          }

          // Multiple questions result format
          const lines: string[] = ["User responses:"];
          for (let i = 0; i < result.answers.length; i++) {
            const a = result.answers[i];
            lines.push(`${i + 1}. ${a.question}`);
            lines.push(`   Answer: ${a.response}`);
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              answers: result.answers,
              cancelled: false,
            },
          };
        } catch {
          // If custom component encounters an error, proceed to fallback below
        }
      }

      // 4. Fallback: Sequential ctx.ui.select / ctx.ui.input flow
      const answers: SingleAnswerDetail[] = [];
      const opts: { signal?: AbortSignal; timeout?: number } = {};
      if (signal) opts.signal = signal;
      if (params.timeout_seconds && params.timeout_seconds > 0) {
        opts.timeout = Math.round(params.timeout_seconds * 1000);
      }

      for (let i = 0; i < total; i++) {
        if (signal?.aborted) break;
        const item = normalizedQuestions[i];
        const stepPrefix = total > 1 ? `[${i + 1}/${total}] ` : "";
        const promptTitle = `${stepPrefix}${item.question}`;

        if (Array.isArray(item.choices) && item.choices.length > 0) {
          const options = [...item.choices];
          if (params.allow_custom ?? true) options.push(CUSTOM_CHOICE_LABEL);
          const selected = await ctx.ui.select(promptTitle, options, opts);
          if (selected === undefined) break;

          if (selected === CUSTOM_CHOICE_LABEL) {
            const custom = await ctx.ui.input(promptTitle, item.placeholder || "Enter your custom choice...", opts);
            if (custom === undefined) break;
            answers.push({
              question: item.question,
              response: custom.trim() || "(Empty custom response)",
              isChoice: true,
              isCustom: true,
              cancelled: false,
            });
          } else {
            answers.push({
              question: item.question,
              response: selected,
              isChoice: true,
              isCustom: false,
              cancelled: false,
            });
          }
        } else {
          const ans = await ctx.ui.input(promptTitle, item.placeholder, opts);
          if (ans === undefined) break;
          answers.push({
            question: item.question,
            response: ans.trim() || "(Empty response)",
            isChoice: false,
            isCustom: false,
            cancelled: false,
          });
        }
      }

      if (answers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "The user dismissed/cancelled the prompt without providing an answer.",
            },
          ],
          details: { answers: [], cancelled: true },
        };
      }

      const lines: string[] = ["User responses:"];
      for (let i = 0; i < answers.length; i++) {
        lines.push(`${i + 1}. ${answers[i].question}`);
        lines.push(`   Answer: ${answers[i].response}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { answers, cancelled: answers.length < total },
      };
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      if (Array.isArray(args?.questions) && args.questions.length > 1) {
        text += theme.fg("accent", `[${args.questions.length} questions] `);
        const first = args.questions[0]?.question ? args.questions[0].question.slice(0, 40) : "";
        if (first) {
          text += theme.fg("muted", `"${first}…"`);
        }
      } else {
        const q = args?.question || (Array.isArray(args?.questions) && args?.questions[0]?.question) || "";
        const shortQ = q ? q.slice(0, 50).replace(/\n/g, " ") : "";
        if (shortQ) {
          text += theme.fg("muted", `"${shortQ}" `);
        }
        const choices = args?.choices || (Array.isArray(args?.questions) && args?.questions[0]?.choices);
        if (Array.isArray(choices) && choices.length > 0) {
          text += theme.fg("dim", `[${choices.length} choices]`);
        }
      }
      const textComponent =
        (context?.lastComponent instanceof Text ? context.lastComponent : undefined) ?? new Text("", 0, 0);
      textComponent.setText(text);
      return textComponent;
    },
    renderResult(result, _options, theme, _context) {
      if (result.isError) {
        const errText = result.content[0]?.type === "text" ? result.content[0].text : "Failed to prompt user";
        return new Text(theme.fg("error", `✗ ${errText}`), 0, 0);
      }

      const details = result.details as AskUserResultDetails | undefined;
      const answers = details?.answers || [];

      if (answers.length === 0 && details?.cancelled) {
        return new Text(theme.fg("dim", "↷ Dismissed by user"), 0, 0);
      }

      if (answers.length > 1 || (details?.cancelled && answers.length > 0)) {
        if (details?.cancelled) {
          return new Text(
            `${theme.fg("warning", `⚠ Answered ${answers.length} question(s)`)} ${theme.fg("dim", "(dismissed remaining)")}`,
            0,
            0
          );
        }
        return new Text(
          `${theme.fg("accent", "✔ Answered ")}${theme.fg("success", `${answers.length} questions`)}`,
          0,
          0
        );
      }

      const single = answers[0];
      const resp = single?.response ?? details?.response ?? "";
      const shortResponse = resp.length > 70 ? resp.slice(0, 67) + "…" : resp;

      if (single?.isChoice || details?.isChoice) {
        const tag = single?.isCustom || details?.isCustom ? theme.fg("warning", "[custom] ") : "";
        return new Text(
          `${theme.fg("accent", "✔ Selected: ")}${tag}${theme.fg("success", `"${shortResponse}"`)}`,
          0,
          0
        );
      }

      return new Text(
        `${theme.fg("accent", "✔ User replied: ")}${theme.fg("success", `"${shortResponse}"`)}`,
        0,
        0
      );
    },
  };
}
