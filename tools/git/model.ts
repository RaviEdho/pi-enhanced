import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { MODEL_SETTING_SESSION_VALUE } from "../../ux/settings/types.js";
import { resolveSessionThinkingLevel } from "../../ux/thinking-levels.js";

/** Resolve the model and thinking level shared by commit and summary. */
export function resolveGitAgentOptions(ctx: ExtensionCommandContext) {
  const store = EnhancedSettingsStore.getInstance();
  const configured = store.get("git.commitModel");
  const model = configured === MODEL_SETTING_SESSION_VALUE
    ? ctx.model
    : ctx.modelRegistry.getAvailable().find((candidate) => `${candidate.provider}/${candidate.id}` === configured);
  if (!model) {
    const message = configured === MODEL_SETTING_SESSION_VALUE
      ? "No active model selected in Pi session."
      : `Configured Git agent model '${configured}' is unavailable. Choose an available model in /settings-enhanced.`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`${message}\n`);
    return undefined;
  }
  return { model, thinkingLevel: resolveSessionThinkingLevel(model, store.get("git.thinkingLevel"), ctx.thinkingLevel) };
}
