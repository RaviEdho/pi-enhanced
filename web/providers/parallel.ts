/**
 * Parallel Web Search Provider.
 *
 * Connects to Parallel Search API (https://search.parallel.ai/v1beta/search)
 * or public MCP endpoint (https://search.parallel.ai/mcp).
 */

import { resolveSearchApiKey } from "../auth.js";
import { parseSearchQuery } from "../query.js";
import type { SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

const PARALLEL_SEARCH_URL = "https://search.parallel.ai/v1beta/search";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const PARALLEL_BETA_HEADER = "search-extract-2025-02-10";

export class ParallelSearchProvider extends SearchProvider {
  readonly id = "parallel" as const;
  readonly label = "Parallel Search";

  isAvailable(): boolean {
    return true; // Available via API key or public MCP
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey(this.id);

    if (apiKey) {
      return this.searchWithApiKey(apiKey, params, startTime);
    }
    return this.searchWithMcp(params, startTime);
  }

  private async searchWithApiKey(
    apiKey: string,
    params: SearchParams,
    startTime: number
  ): Promise<SearchResponse> {
    const parsedQuery = parseSearchQuery(params.query);
    const limit = Math.min(20, Math.max(1, params.limit ?? 5));

    const sourcePolicy: Record<string, any> = {};
    if (parsedQuery.sites.length > 0) sourcePolicy.include_domains = parsedQuery.sites;
    else if (parsedQuery.excludedSites.length > 0) sourcePolicy.exclude_domains = parsedQuery.excludedSites;
    if (parsedQuery.after) sourcePolicy.after_date = parsedQuery.after;

    const requestBody = {
      objective: params.query,
      search_queries: [parsedQuery.text || params.query],
      mode: "fast",
      max_results: limit,
      excerpts: {
        max_chars_per_result: 2000,
      },
      ...(Object.keys(sourcePolicy).length > 0 && { source_policy: sourcePolicy }),
    };

    const timeout = params.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(PARALLEL_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": apiKey,
          "parallel-beta": PARALLEL_BETA_HEADER,
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
      throw new Error(`Parallel Search API failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const rawResults = data?.results || [];

    const sources: SearchSource[] = [];
    for (const item of rawResults) {
      if (item.url && item.title) {
        sources.push({
          title: item.title,
          url: item.url,
          snippet: item.excerpts?.[0] || item.snippet || item.text,
          publishedDate: item.published_date,
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

  private async searchWithMcp(params: SearchParams, startTime: number): Promise<SearchResponse> {
    const mcpPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          objective: params.query,
          search_queries: [params.query],
        },
      },
    };

    const timeout = params.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(PARALLEL_MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify(mcpPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Parallel MCP search failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (data.error) {
      throw new Error(`Parallel MCP error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const content = data?.result?.content;
    const sources: SearchSource[] = [];

    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text" && typeof item.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const results = parsed.results || (Array.isArray(parsed) ? parsed : []);
            for (const r of results) {
              if (r.url && r.title) {
                sources.push({
                  title: r.title,
                  url: r.url,
                  snippet: r.snippet || r.text || r.excerpts?.[0],
                  publishedDate: r.published_date,
                });
              }
            }
          } catch {
            // Non-JSON content
          }
        }
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
