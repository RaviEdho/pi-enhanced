import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
export const SESSION_THINKING_VALUE = "session";
export const SESSION_THINKING_LABEL = "Use session thinking";
export type SessionThinkingSetting = ModelThinkingLevel | typeof SESSION_THINKING_VALUE;

/** Inherited models can change between sessions; fixed models only offer supported levels. */
export function getThinkingLevelOptions(models: readonly Model<Api>[], modelRef?: string) {
  const model = modelRef === undefined ? undefined : models.find((item) => `${item.provider}/${item.id}` === modelRef);
  const levels: readonly ModelThinkingLevel[] = modelRef === undefined ? THINKING_LEVELS : model ? getSupportedThinkingLevels(model) : [];
  return { model, levels };
}

/** Show the effective level without overwriting the saved preference when a model changes. */
export function formatThinkingOverride(level: ModelThinkingLevel, model?: Model<Api>): string {
  const effective = model && clampThinkingLevel(model, level);
  return effective && effective !== level ? `${level} (uses ${effective})` : level;
}

export function resolveSessionThinkingLevel(model: Model<Api>, choice: SessionThinkingSetting, session?: ModelThinkingLevel): ModelThinkingLevel {
  return clampThinkingLevel(model, choice === SESSION_THINKING_VALUE ? session ?? "off" : choice);
}
