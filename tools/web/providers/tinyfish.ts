/**
 * TinyFish Web Search Provider.
 *
 * Connects to TinyFish Search REST API (https://api.search.tinyfish.ai).
 * Authentication via TINYFISH_API_KEY or /login tinyfish.
 */

import { resolveSearchApiKey } from "../auth.js";
import { parseSearchQuery } from "../query.js";
import type { SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

const RECENCY_MINUTES: Record<"day" | "week" | "month" | "year", number> = {
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

export class TinyFishSearchProvider extends SearchProvider {
  readonly id = "tinyfish" as const;
  readonly label = "TinyFish Search";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey(this.id));
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey(this.id);
    if (!apiKey) {
      throw new Error("No TinyFish API key found. Run `/login tinyfish` or set TINYFISH_API_KEY");
    }

    const parsedQuery = parseSearchQuery(params.query);
    const limit = Math.min(20, Math.max(1, params.limit ?? 5));

    const url = new URL(TINYFISH_SEARCH_URL);
    url.searchParams.set("query", parsedQuery.text || params.query);

    // Optional purpose helps search quality
    if (parsedQuery.text && parsedQuery.text !== params.query) {
      url.searchParams.set("purpose", params.query);
    }

    if (parsedQuery.sites.length > 0) {
      url.searchParams.set("include_domains", parsedQuery.sites.join(","));
    }
    if (parsedQuery.excludedSites.length > 0) {
      url.searchParams.set("exclude_domains", parsedQuery.excludedSites.join(","));
    }

    // Date filters (recency_minutes cannot be combined with after_date / before_date per TinyFish docs)
    if (parsedQuery.after || parsedQuery.before) {
      if (parsedQuery.after) url.searchParams.set("after_date", parsedQuery.after);
      if (parsedQuery.before) url.searchParams.set("before_date", parsedQuery.before);
    } else if (params.recency && RECENCY_MINUTES[params.recency]) {
      url.searchParams.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
    }

    const timeout = params.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);


    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": apiKey,
          "User-Agent": "pi-coding-agent/1.0",
        },
        signal: params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new Error("Invalid or missing TinyFish API key. Run `/login tinyfish` or set TINYFISH_API_KEY");
      }
      if (response.status === 429) {
        throw new Error("TinyFish Search rate limit exceeded (30 req/min)");
      }
      throw new Error(`TinyFish Search API failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const rawResults = data?.results || [];

    const sources: SearchSource[] = [];
    for (const item of rawResults.slice(0, limit)) {
      if (item.url && item.title) {
        sources.push({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          publishedDate: item.date,
        });
      }
    }

    return {
      provider: this.id,
      query: params.query,
      sources,
      durationMs: Date.now() - startTime,
    };
  }
}
