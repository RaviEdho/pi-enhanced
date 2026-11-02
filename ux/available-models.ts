import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Read authenticated, provider-filtered chat models without relying on Pi's synchronous snapshot. */
export async function getAvailablePickerModels(ctx: ExtensionCommandContext) {
  const available = await ctx.modelRegistry.getAvailableOfType("chat");
  const ids = new Set(available.map((model) => `${model.provider}\0${model.id}`));
  // Match the ordinary chat-model catalog, excluding any extra getAllModels entries.
  return ctx.modelRegistry.getAll().filter((model) => ids.has(`${model.provider}\0${model.id}`));
}
