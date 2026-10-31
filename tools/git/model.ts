import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { COMMIT_MODEL_SESSION_VALUE } from "../../ux/settings/types.js";

/** Resolve the shared Git agent model, reporting unavailable configuration consistently. */
export function resolveGitAgentModel(ctx: ExtensionCommandContext) {
  const configured = EnhancedSettingsStore.getInstance().get("git.commitModel");
  const model = configured === COMMIT_MODEL_SESSION_VALUE
    ? ctx.model
    : ctx.modelRegistry.getAvailable().find((candidate) => `${candidate.provider}/${candidate.id}` === configured);
  if (!model) {
    const message = configured === COMMIT_MODEL_SESSION_VALUE
      ? "No active model selected in Pi session."
      : `Configured Git agent model '${configured}' is unavailable. Choose an available model in /settings-enhanced.`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`${message}\n`);
  }
  return model;
}
