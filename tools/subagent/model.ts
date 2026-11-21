import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findAvailablePickerModel } from "../../ux/available-models.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { MODEL_SETTING_SESSION_VALUE } from "../../ux/settings/types.js";
import type { SubagentRunOptions } from "./types.js";

type ModelOptions = Pick<SubagentRunOptions, "model" | "thinkingLevel" | "modelRuntime">;

/** Snapshot the saved model at launch without mutating the parent session. */
export async function resolveSubagentModelOptions(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">,
  signal?: AbortSignal,
): Promise<{ options: ModelOptions } | { error: string }> {
  const configured = EnhancedSettingsStore.getInstance().get("subagent.model");
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
      thinkingLevel: clampThinkingLevel(model, ctx.thinkingLevel ?? "off"),
      modelRuntime: (ctx.modelRegistry as any).runtime,
    },
  };
}
