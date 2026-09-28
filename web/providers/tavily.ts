/**
 * Tavily Web Search Provider.
 *
 * Connects to Tavily Agent Search REST API (https://api.tavily.com/search).
 * Authentication via TAVILY_API_KEY or /login tavily.
 */

import { resolveSearchApiKey } from "../auth.js";
import { parseSearchQuery } from "../query.js";
import type { SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export class TavilySearchProvider extends SearchProvider {
  readonly id = "tavily" as const;
  readonly label = "Tavily Search";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey(this.id));
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey(this.id);
    if (!apiKey) {
      throw new Error("No Tavily API key found. Run `/login tavily` or set TAVILY_API_KEY");
    }

    const parsedQuery = parseSearchQuery(params.query);
    const limit = Math.min(20, Math.max(1, params.limit ?? 5));

    const requestBody: Record<string, any> = {
      api_key: apiKey,
      query: parsedQuery.text || params.query,
      max_results: limit,
      include_answer: true,
      search_depth: "basic",
    };

    if (parsedQuery.sites.length > 0) {
      requestBody.include_domains = parsedQuery.sites;
    }
    if (parsedQuery.excludedSites.length > 0) {
      requestBody.exclude_domains = parsedQuery.excludedSites;
    }
    if (parsedQuery.after) {
      requestBody.start_date = parsedQuery.after;
    }
    if (parsedQuery.before) {
      requestBody.end_date = parsedQuery.before;
    }

    const timeout = params.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Tavily Search API failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const rawResults = data?.results || [];

    const sources: SearchSource[] = [];
    for (const item of rawResults) {
      if (item.url && item.title) {
        sources.push({
          title: item.title,
          url: item.url,
          snippet: item.content,
          publishedDate: item.published_date,
        });
      }
    }

    return {
      provider: this.id,
      query: params.query,
      answer: typeof data?.answer === "string" ? data.answer.trim() : undefined,
      sources,
      durationMs: Date.now() - startTime,
    };
  }
}
