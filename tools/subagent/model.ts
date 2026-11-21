import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findAvailablePickerModel } from "../../ux/available-models.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { MODEL_SETTING_SESSION_VALUE } from "../../ux/settings/types.js";
import { resolveSessionThinkingLevel } from "../../ux/thinking-levels.js";
import type { SubagentRunOptions } from "./types.js";

type ModelOptions = Pick<SubagentRunOptions, "model" | "thinkingLevel" | "modelRuntime">;

/** Snapshot the model and thinking preference without mutating the parent session. */
export async function resolveSubagentModelOptions(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">,
  signal?: AbortSignal,
): Promise<{ options: ModelOptions } | { error: string }> {
  const store = EnhancedSettingsStore.getInstance();
  const configured = store.get("subagent.model");
  const thinking = store.get("subagent.thinkingLevel");
  const inheritModel = configured === MODEL_SETTING_SESSION_VALUE;
  const model = inheritModel
    ? ctx.model
    : await findAvailablePickerModel(ctx, configured, signal).catch(() => undefined);

  if (signal?.aborted) return { error: "Subagent execution was cancelled before starting." };
  if (!model) {
    return {
      error: inheritModel
        ? "No active model selected in Pi session. Please select a model first."
        : `Configured subagent model '${configured}' is unavailable. Choose an available model or 'Use session model' in /settings-enhanced.`,
    };
  }

  return {
    options: {
      model,
      thinkingLevel: resolveSessionThinkingLevel(model, thinking, ctx.thinkingLevel),
      modelRuntime: (ctx.modelRegistry as any).runtime,
    },
  };
}
