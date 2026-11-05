import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FooterStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
}

/** Per-footer, raw data only: never cache theme strings or shared quota reports. */
export class FooterStatsCache {
  private cached?: {
    session: ExtensionContext["sessionManager"];
    sessionId: string | undefined;
    leafId: string | null | undefined;
    entryCount: number | undefined;
    model: ExtensionContext["model"];
    contextWindow: number | undefined;
    includeContext: boolean;
    stats: FooterStats;
  };

  invalidate(): void {
    this.cached = undefined;
  }

  read(ctx: ExtensionContext, includeContext: boolean): FooterStats {
    const session = ctx.sessionManager;
    const sessionId = session?.getSessionId?.();
    const leafId = session?.getLeafId?.();
    // getEntryCount is available on native managers, but not all readonly SDK facades.
    // Do not fall back to getEntries(): that would copy the whole session per frame.
    const entryCount = (session as typeof session & { getEntryCount?: () => number })?.getEntryCount?.();
    const model = ctx.model;
    const contextWindow = model?.contextWindow;
    const cached = this.cached;
    const cacheable = typeof session?.getLeafId === "function";
    if (cacheable && cached && cached.session === session && cached.sessionId === sessionId &&
      cached.leafId === leafId && cached.entryCount === entryCount && cached.model === model &&
      cached.contextWindow === contextWindow && cached.includeContext === includeContext) {
      return cached.stats;
    }

    const stats: FooterStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextUsage: undefined };
    // Retain the existing footer's active-branch accounting semantics.
    for (const entry of session?.getBranch?.() ?? []) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const usage = (entry.message as AssistantMessage).usage;
      if (!usage) continue;
      stats.input += usage.input || 0;
      stats.output += usage.output || 0;
      stats.cacheRead += usage.cacheRead || 0;
      stats.cacheWrite += usage.cacheWrite || 0;
      stats.cost += usage.cost?.total || 0;
      const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      stats.latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead || 0) / promptTokens) * 100 : undefined;
    }
    if (includeContext) stats.contextUsage = ctx.getContextUsage?.();
    this.cached = { session, sessionId, leafId, entryCount, model, contextWindow, includeContext, stats };
    return stats;
  }
}
