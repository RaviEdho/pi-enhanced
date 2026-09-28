/**
 * Central web search orchestration pipeline.
 *
 * Resolves candidate search providers, executes with automatic failover,
 * and post-filters results leniently.
 */

import { AntigravitySearchProvider } from "./providers/antigravity.js";
import { SearchProvider } from "./providers/base.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { ExaSearchProvider } from "./providers/exa.js";
import { ParallelSearchProvider } from "./providers/parallel.js";
import { TavilySearchProvider } from "./providers/tavily.js";
import { applyQueryConstraints, parseSearchQuery } from "./query.js";
import type { SearchParams, SearchProviderId, SearchResponse } from "./types.js";

export class SearchPipeline {
  private static instance?: SearchPipeline;
  private providers: Map<SearchProviderId, SearchProvider> = new Map();

  private constructor() {
    this.register(new AntigravitySearchProvider());
    this.register(new BraveSearchProvider());
    this.register(new TavilySearchProvider());
    this.register(new ExaSearchProvider());
    this.register(new ParallelSearchProvider());
  }

  public static getInstance(): SearchPipeline {
    if (!SearchPipeline.instance) {
      SearchPipeline.instance = new SearchPipeline();
    }
    return SearchPipeline.instance;
  }

  public register(provider: SearchProvider): void {
    this.providers.set(provider.id, provider);
  }

  public getProvider(id: SearchProviderId): SearchProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Determine ordered candidate providers for a search request.
   */
  public async getCandidates(explicitProvider?: SearchProviderId): Promise<SearchProvider[]> {
    if (explicitProvider) {
      const explicit = this.providers.get(explicitProvider);
      if (explicit) return [explicit];
      throw new Error(`Requested search provider "${explicitProvider}" is not registered`);
    }

    const candidates: SearchProvider[] = [];

    // Check providers in preferential order:
    // 1. Brave (fast dedicated index, if API key present)
    const brave = this.providers.get("brave");
    if (brave && (await brave.isAvailable())) candidates.push(brave);

    // 2. Tavily (agent-first search, if API key present)
    const tavily = this.providers.get("tavily");
    if (tavily && (await tavily.isAvailable())) candidates.push(tavily);

    // 3. Antigravity (Google Search Grounding, if Google OAuth active)
    const antigravity = this.providers.get("antigravity");
    if (antigravity && (await antigravity.isAvailable())) candidates.push(antigravity);

    // 4. Exa (neural search with API key or MCP)
    const exa = this.providers.get("exa");
    if (exa && (await exa.isAvailable())) candidates.push(exa);

    // 5. Parallel (search with API key or MCP)
    const parallel = this.providers.get("parallel");
    if (parallel && (await parallel.isAvailable())) candidates.push(parallel);

    return candidates;
  }

  /**
   * Execute search with transparent provider failover.
   */
  public async execute(
    params: SearchParams
  ): Promise<{ response: SearchResponse; notes: string[] }> {
    const candidates = await this.getCandidates(params.provider);
    if (candidates.length === 0) {
      throw new Error(
        "No web search provider is currently available. Configure an API key (/login brave, /login tavily, /login exa, /login parallel) or Google Antigravity account."
      );
    }

    const parsedQuery = parseSearchQuery(params.query);
    const errors: Array<{ provider: string; error: string }> = [];

    for (const candidate of candidates) {
      if (params.signal?.aborted) {
        throw new Error("Search aborted by user");
      }

      try {
        const response = await candidate.search(params);

        // Check if response has any content
        if (response.sources.length === 0 && !response.answer?.trim()) {
          throw new Error("Provider returned zero search results");
        }

        // Apply lenient query constraints (site:, inurl:, intitle:, etc.)
        let finalSources = response.sources;
        const notes: string[] = [];

        if (parsedQuery.hasConstraints && response.sources.length > 0) {
          const filtered = applyQueryConstraints(response.sources, parsedQuery);
          finalSources = filtered.sources;
          for (const droppedConstraint of filtered.dropped) {
            notes.push(`no results matched \`${droppedConstraint}\`; constraint was relaxed`);
          }
        }

        return {
          response: {
            ...response,
            sources: finalSources,
          },
          notes,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ provider: candidate.label, error: message });
      }
    }

    const summary = errors.map((e) => `${e.provider}: ${e.error}`).join("; ");
    throw new Error(`All web search providers failed (${summary})`);
  }
}
