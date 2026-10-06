/**
 * TinyFish Fetch Provider.
 *
 * Connects to TinyFish Fetch API (https://api.fetch.tinyfish.ai).
 */

import { resolveSearchApiKey } from "../auth.js";
import { FetchProvider } from "./base.js";
import type { FetchParams, FetchResponse } from "./types.js";

const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";

export class TinyFishFetchProvider extends FetchProvider {
  readonly id = "tinyfish" as const;
  readonly label = "TinyFish";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey("tinyfish"));
  }

  async fetch(params: FetchParams): Promise<FetchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey("tinyfish");
    if (!apiKey) {
      throw new Error("No TinyFish API key found. Run `/login tinyfish` or set TINYFISH_API_KEY");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 20000);
    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const requestBody: Record<string, any> = {
      urls: [params.url],
      format: "markdown",
    };
    if (params.purpose) {
      requestBody.purpose = params.purpose;
    }

    let response: Response;
    try {
      response = await fetch(TINYFISH_FETCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`TinyFish Fetch failed (${response.status}): ${err}`);
    }

    const data: any = await response.json();
    const result = data?.results?.[0];
    if (!result) {
      const errorMsg = data?.errors?.[0]?.error || "Empty result";
      throw new Error(`TinyFish Fetch error: ${errorMsg}`);
    }

    const content = typeof result.text === "string" ? result.text : JSON.stringify(result.text || "");
    if (!content.trim()) {
      throw new Error("TinyFish Fetch returned no text content");
    }

    return {
      provider: this.id,
      url: result.final_url || result.url || params.url,
      title: result.title,
      content,
      publishedDate: result.published_date,
      durationMs: Date.now() - startTime,
    };
  }
}
