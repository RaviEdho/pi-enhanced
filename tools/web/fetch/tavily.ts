/**
 * Tavily Extract Fetch Provider.
 *
 * Connects to Tavily Extract API (https://api.tavily.com/extract).
 */

import { resolveSearchApiKey } from "../auth.js";
import { FetchProvider } from "./base.js";
import type { FetchParams, FetchResponse } from "./types.js";

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

export class TavilyFetchProvider extends FetchProvider {
  readonly id = "tavily" as const;
  readonly label = "Tavily";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey("tavily"));
  }

  async fetch(params: FetchParams): Promise<FetchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey("tavily");
    if (!apiKey) {
      throw new Error("No Tavily API key found. Run `/login tavily` or set TAVILY_API_KEY");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 15000);

    let response: Response;
    try {
      response = await fetch(TAVILY_EXTRACT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify({
          api_key: apiKey,
          urls: [params.url],
        }),
        signal: params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Tavily Extract failed (${response.status}): ${err}`);
    }

    const data: any = await response.json();
    const result = data?.results?.[0];
    if (!result) {
      const fail = data?.failed_results?.[0]?.error || "Empty result";
      throw new Error(`Tavily Extract error: ${fail}`);
    }

    const content = result.raw_content || "";
    if (!content.trim()) {
      throw new Error("Tavily Extract returned no text content");
    }

    return {
      provider: this.id,
      url: result.url || params.url,
      title: result.title,
      content,
      durationMs: Date.now() - startTime,
    };
  }
}
