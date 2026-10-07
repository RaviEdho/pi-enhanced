/**
 * Brave Web Search Provider.
 *
 * Connects to Brave Search REST API (https://api.search.brave.com/res/v1/web/search).
 * Authentication via BRAVE_API_KEY or /login brave.
 */

import { resolveSearchApiKey } from "../auth.js";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query.js";
import type { SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export class BraveSearchProvider extends SearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave Search";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey(this.id));
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey(this.id);
    if (!apiKey) {
      throw new Error("No Brave API key found. Run `/login brave` or set BRAVE_API_KEY");
    }

    const parsedQuery = parseSearchQuery(params.query);
    const engineQuery = formatQuery(parsedQuery, {
      ...GOOGLE_QUERY_SYNTAX,
      dateRange: false, // Brave uses `freshness` param instead
    });

    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set("q", engineQuery);
    url.searchParams.set("count", String(Math.min(20, Math.max(1, params.limit ?? 5))));

    if (params.recency && RECENCY_MAP[params.recency]) {
      url.searchParams.set("freshness", RECENCY_MAP[params.recency]);
    } else if (parsedQuery.after || parsedQuery.before) {
      const start = parsedQuery.after ?? "1970-01-01";
      const end = parsedQuery.before ?? new Date().toISOString().slice(0, 10);
      url.searchParams.set("freshness", `${start}to${end}`);
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
          "X-Subscription-Token": apiKey,
          "User-Agent": "pi-coding-agent/1.0",
        },
        signal: params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Brave Search API failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const webResults = data?.web?.results || [];

    const sources: SearchSource[] = [];
    for (const item of webResults) {
      if (item.url && item.title) {
        sources.push({
          title: item.title,
          url: item.url,
          snippet: item.description,
          publishedDate: item.page_age,
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
