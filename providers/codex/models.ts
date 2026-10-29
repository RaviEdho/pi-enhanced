import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CodexModelSummary } from "./types.js";

export function isVisibleCodexModel(model: CodexModelSummary): boolean {
  return model.supportedInApi !== false && model.visibility !== "hide";
}

function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Merge discovery with exact built-in metadata, never with another model's capabilities or prices. */
export function mergeCodexModels(
  baseline: readonly Model<Api>[],
  catalog: readonly CodexModelSummary[] | null,
  baseUrl = "https://chatgpt.com/backend-api"
): Model<Api>[] {
  const models = new Map(baseline.map((model) => [model.id, model]));
  for (const entry of catalog ?? []) {
    if (!isVisibleCodexModel(entry)) {
      models.delete(entry.slug);
      continue;
    }

    const known = models.get(entry.slug);
    const contextWindow = positiveLimit(entry.contextWindow) ?? known?.contextWindow;
    // A usable context limit is required before registering a previously unknown model.
    if (!contextWindow) continue;

    const modalities = entry.inputModalities?.filter(
      (value): value is "text" | "image" => value === "text" || value === "image"
    );
    const levels = entry.reasoningLevels;
    let thinkingLevelMap: ThinkingLevelMap | undefined = known?.thinkingLevelMap;
    if (levels) {
      thinkingLevelMap = {};
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const effort = level === "off" ? "none" : level;
        thinkingLevelMap[level] = levels.includes(effort) ? effort : null;
      }
    }

    models.set(entry.slug, {
      ...known,
      id: entry.slug,
      name: entry.displayName || entry.slug,
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: known?.baseUrl ?? baseUrl,
      input: modalities?.length ? modalities : known?.input ?? ["text"],
      reasoning: levels ? levels.some((level) => level !== "none") : known?.reasoning ?? false,
      thinkingLevelMap,
      // The subscription catalog has no token prices. Zero means unpriced, not an inferred API rate.
      cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      // Unknown output limits get a conservative local cap, not a claimed server maximum.
      maxTokens: Math.min(
        positiveLimit(entry.maxOutputTokens) ?? known?.maxTokens ?? 16384,
        contextWindow
      ),
    });
  }
  return [...models.values()];
}
