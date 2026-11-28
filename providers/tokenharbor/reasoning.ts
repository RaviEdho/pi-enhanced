import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface TokenHarborReasoning {
  efforts: string[] | null;
  default_effort: string | null;
  can_disable: boolean | null;
}

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const effort = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);

/** Unknown members stay unknown; an empty list is not the same as null. */
export function parseTokenHarborReasoning(value: unknown): TokenHarborReasoning {
  const r = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    efforts: Array.isArray(r.efforts) && r.efforts.every(v => effort(v) && v !== "none") ? [...new Set(r.efforts)] : null,
    default_effort: effort(r.default_effort) ? r.default_effort : null,
    can_disable: typeof r.can_disable === "boolean" ? r.can_disable : null,
  };
}

/**
 * Direct force-refresh probes on 2026-11-27 showed increasing completion/reasoning
 * output for none/low/high/max on deepseek-v4.1-flash:free and low/high/max on
 * glm-5.3-flash. GLM's `none` request still returned reasoning. Token Harbor returned
 * no applied-effort header; DeepSeek sibling IDs use the requested override but were
 * not independently probed.
 */
function reasoningForModel(id: string, value: unknown): TokenHarborReasoning {
  const reasoning = parseTokenHarborReasoning(value);
  const isDeepSeekV41Flash = id === "deepseek-v4.1-flash"
    || id.startsWith("deepseek-v4.1-flash:")
    || id.startsWith("deepseek-v4.1-flash-");
  if (isDeepSeekV41Flash) return { ...reasoning, efforts: ["low", "high", "max"] };
  if (id === "glm-5.3-flash") return { ...reasoning, efforts: ["low", "high", "max"], can_disable: false };
  return reasoning;
}

/** Explicit null mappings prevent Pi from inventing additional effort controls. */
export function withTokenHarborReasoning<T extends Model<"openai-completions">>(model: T, value: unknown): T & { tokenHarborReasoning: TokenHarborReasoning } {
  const r = reasoningForModel(model.id, value);
  const thinkingLevelMap = Object.fromEntries(levels.map(level => [level,
    level === "off" ? r.can_disable === true ? "none" : null : r.efforts?.includes(level) ? level : null,
  ])) as ThinkingLevelMap;
  const configurable = Object.values(thinkingLevelMap).some(value => typeof value === "string");
  return { ...model, tokenHarborReasoning: r, reasoning: configurable, thinkingLevelMap,
    compat: { ...model.compat, supportsReasoningEffort: configurable } };
}

export function isTokenHarborEffortSupported(r: TokenHarborReasoning, value: unknown): boolean {
  return value === "none" ? r.can_disable === true : typeof value === "string" && !!r.efforts?.includes(value);
}
