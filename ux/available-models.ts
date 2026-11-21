import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Read authenticated, provider-filtered chat models without relying on Pi's synchronous snapshot. */
export async function getAvailablePickerModels(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  provider?: string,
  signal?: AbortSignal,
) {
  const available = await ctx.modelRegistry.getAvailableOfType("chat", provider, { signal });
  const ids = new Set(available.map((model) => `${model.provider}\0${model.id}`));
  // Match the ordinary chat-model catalog, excluding any extra getAllModels entries.
  return ctx.modelRegistry.getAll().filter((model) => ids.has(`${model.provider}\0${model.id}`));
}

/** Resolve an exact picker value; model IDs may themselves contain slashes. */
export async function findAvailablePickerModel(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  modelRef: string,
  signal?: AbortSignal,
) {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) return undefined;
  const models = await getAvailablePickerModels(ctx, modelRef.slice(0, separator), signal);
  return models.find((model) => `${model.provider}/${model.id}` === modelRef);
}
