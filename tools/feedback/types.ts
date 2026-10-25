import { Type, type Static } from "typebox";

export const QuestionItemSchema = Type.Object({
  question: Type.String({
    description:
      "A short, direct question to show the user. Include only the question itself—not reasoning, rationale, analysis, or a preamble. Add only essential context if needed.",
  }),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 2,
      maxItems: 6,
      description:
        "Optional list of structured choices (recommended: 3 clear options). Do NOT prefix with 'Option 1:' or 'Option 2:'; provide direct, clean labels (e.g. ['PostgreSQL [recommended]', 'SQLite', 'MongoDB']).",
    })
  ),
  placeholder: Type.Optional(
    Type.String({
      description:
        "Optional placeholder text for the text input box when choices are not provided or when typing a custom response.",
    })
  ),
});

export type QuestionItem = Static<typeof QuestionItemSchema>;

export const AskUserParametersSchema = Type.Object({
  question: Type.Optional(
    Type.String({
      description:
        "A short, direct question to show the user. Include only the question itself—not reasoning, rationale, analysis, or a preamble. Provide either 'question' for one question or 'questions' for several.",
    })
  ),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 2,
      maxItems: 6,
      description:
        "Optional list of structured choices (recommended: 3 clear, distinct options). Do NOT prefix choices with 'Option 1:' or 'Option 2:'; provide direct labels (e.g. ['PostgreSQL [recommended]', 'SQLite', 'MongoDB']).",
    })
  ),
  placeholder: Type.Optional(
    Type.String({
      description: "Optional placeholder text for single question text input.",
    })
  ),
  questions: Type.Optional(
    Type.Array(QuestionItemSchema, {
      minItems: 1,
      maxItems: 6,
      description:
        "Optional list of short, direct questions to ask sequentially in a single turn. Each question can independently be freeform text or a 3-choice selector; include no reasoning or preamble in the question text.",
    })
  ),
  allow_custom: Type.Optional(
    Type.Boolean({
      description:
        "When choices are provided, whether to include a '✎ Type custom answer...' option allowing the user to type their own response if none of the options fit (default: true).",
    })
  ),
  recap: Type.Optional(
    Type.Boolean({
      description:
        "Whether to display a review/recap screen summarizing all answers before final submission (default: true).",
    })
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Optional timeout in seconds per question before automatically closing without an answer (default: none).",
    })
  ),
});

export type AskUserParameters = Static<typeof AskUserParametersSchema>;

export interface SingleAnswerDetail {
  question: string;
  response?: string;
  isChoice?: boolean;
  isCustom?: boolean;
  cancelled: boolean;
}

export interface AskUserResultDetails {
  question?: string;
  response?: string;
  isChoice?: boolean;
  isCustom?: boolean;
  answers: SingleAnswerDetail[];
  cancelled: boolean;
  timedOut?: boolean;
}
