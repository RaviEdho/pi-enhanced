/**
 * Exa Web Search Provider.
 *
 * Uses Exa Search REST API (https://api.exa.ai/search) when EXA_API_KEY or /login exa
 * is configured, or falls back to Exa's public MCP endpoint.
 */

import { resolveSearchApiKey } from "../auth.js";
import { parseSearchQuery } from "../query.js";
import type { SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

const EXA_API_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export class ExaSearchProvider extends SearchProvider {
  readonly id = "exa" as const;
  readonly label = "Exa Search";

  isAvailable(): boolean {
    // Available if API key configured OR via public MCP
    return true;
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

    const requestBody: Record<string, any> = {
      query: parsedQuery.text || params.query,
      numResults: limit,
      contents: {
        text: { maxCharacters: 1000 },
      },
    };

    if (parsedQuery.sites.length > 0) {
      requestBody.includeDomains = parsedQuery.sites;
    }
    if (parsedQuery.excludedSites.length > 0) {
      requestBody.excludeDomains = parsedQuery.excludedSites;
    }
    if (parsedQuery.after) {
      requestBody.startPublishedDate = parsedQuery.after;
    }
    if (parsedQuery.before) {
      requestBody.endPublishedDate = parsedQuery.before;
    }

    const timeout = params.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(EXA_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": apiKey,
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
      throw new Error(`Exa API search failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const rawResults = data?.results || [];

    const sources: SearchSource[] = [];
    for (const item of rawResults) {
      if (item.url && item.title) {
        sources.push({
          title: item.title,
          url: item.url,
          snippet: item.text,
          publishedDate: item.publishedDate,
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
    const limit = Math.min(20, Math.max(1, params.limit ?? 5));
    const mcpPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: params.query,
          num_results: limit,
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
      response = await fetch(EXA_MCP_URL, {
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
      throw new Error(`Exa MCP search failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (data.error) {
      throw new Error(`Exa MCP error: ${data.error.message || JSON.stringify(data.error)}`);
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
                  snippet: r.text || r.snippet,
                  publishedDate: r.publishedDate,
                });
              }
            }
          } catch {
            // Unstructured text fallback
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
