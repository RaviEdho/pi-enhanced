/**
 * Central web fetch orchestration pipeline.
 *
 * Resolves candidate fetch providers, executes with automatic failover,
 * and formats extracted page content within strict token/character budgets.
 */

import { ExaFetchProvider } from "./exa.js";
import { JinaFetchProvider } from "./jina.js";
import { ParallelFetchProvider } from "./parallel.js";
import { TavilyFetchProvider } from "./tavily.js";
import { TinyFishFetchProvider } from "./tinyfish.js";
import type { FetchParams, FetchProviderId, FetchResponse } from "./types.js";
import { FetchProvider } from "./base.js";

const DEFAULT_MAX_CHARACTERS = 15000;

export class FetchPipeline {
  private static instance?: FetchPipeline;
  private providers: Map<FetchProviderId, FetchProvider> = new Map();

  private constructor() {
    this.register(new ParallelFetchProvider());
    this.register(new TinyFishFetchProvider());
    this.register(new ExaFetchProvider());
    this.register(new TavilyFetchProvider());
    this.register(new JinaFetchProvider());
  }

  public static getInstance(): FetchPipeline {
    if (!FetchPipeline.instance) {
      FetchPipeline.instance = new FetchPipeline();
    }
    return FetchPipeline.instance;
  }

  public register(provider: FetchProvider): void {
    this.providers.set(provider.id, provider);
  }

  public getProvider(id: FetchProviderId): FetchProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Determine ordered candidate fetch providers.
   */
  public async getCandidates(explicitProvider?: FetchProviderId): Promise<FetchProvider[]> {
    if (explicitProvider) {
      const explicit = this.providers.get(explicitProvider);
      if (explicit) return [explicit];
      throw new Error(`Requested fetch provider "${explicitProvider}" is not registered`);
    }

    const candidates: FetchProvider[] = [];

    // 1. Parallel (ultra-fast semantic extract)
    const parallel = this.providers.get("parallel");
    if (parallel && (await parallel.isAvailable())) candidates.push(parallel);

    // 2. TinyFish (headless browser with anti-bot / full JS support)
    const tinyfish = this.providers.get("tinyfish");
    if (tinyfish && (await tinyfish.isAvailable())) candidates.push(tinyfish);

    // 3. Exa (fast neural content retriever)
    const exa = this.providers.get("exa");
    if (exa && (await exa.isAvailable())) candidates.push(exa);

    // 4. Tavily (agent-first extract)
    const tavily = this.providers.get("tavily");
    if (tavily && (await tavily.isAvailable())) candidates.push(tavily);

    // 5. Jina (free unauthenticated fallback)
    const jina = this.providers.get("jina");
    if (jina && (await jina.isAvailable())) candidates.push(jina);

    return candidates;
  }

  /**
   * Execute fetch with transparent provider failover.
   */
  public async execute(
    params: FetchParams,
    onProviderAttempt?: (provider: FetchProviderId) => void
  ): Promise<FetchResponse> {
    const candidates = await this.getCandidates(params.provider);
    if (candidates.length === 0) {
      throw new Error(
        "No web fetch provider is currently available. Configure an API key (/login parallel, /login tinyfish, /login exa, /login tavily)."
      );
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const candidate of candidates) {
      if (params.signal?.aborted) {
        throw new Error("Web fetch aborted by user");
      }

      onProviderAttempt?.(candidate.id);

      try {
        const response = await candidate.fetch(params);
        if (!response.content || !response.content.trim()) {
          throw new Error("Provider returned empty page content");
        }

        const maxChars = params.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
        const totalChars = response.content.length;
        let content = response.content;
        let truncated = false;

        if (content.length > maxChars) {
          truncated = true;
          // Slice at clean newline near budget
          const cutIndex = content.lastIndexOf("\n", maxChars);
          content = content.slice(0, cutIndex > maxChars * 0.8 ? cutIndex : maxChars);
          content += `\n\n[Content truncated at ${content.length} characters. Total page length was ${totalChars} characters.]`;
        }

        return {
          ...response,
          content,
          truncated,
          totalCharacters: totalChars,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ provider: candidate.label, error: message });

        // If explicitly requested a specific provider, do not failover
        if (params.provider) {
          throw new Error(`${candidate.label} failed: ${message}`);
        }
      }
    }

    const summary = errors.map((e) => `${e.provider}: ${e.error}`).join("; ");
    throw new Error(`All web fetch providers failed (${summary})`);
  }
}
