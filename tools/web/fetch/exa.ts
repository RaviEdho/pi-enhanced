/**
 * Exa Contents Fetch Provider.
 *
 * Connects to Exa Contents API (https://api.exa.ai/contents).
 */

import { resolveSearchApiKey } from "../auth.js";
import { FetchProvider } from "./base.js";
import type { FetchParams, FetchResponse } from "./types.js";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

export class ExaFetchProvider extends FetchProvider {
  readonly id = "exa" as const;
  readonly label = "Exa";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey("exa"));
  }

  async fetch(params: FetchParams): Promise<FetchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey("exa");
    if (!apiKey) {
      throw new Error("No Exa API key found. Run `/login exa` or set EXA_API_KEY");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 15000);
    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(EXA_CONTENTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify({
          urls: [params.url],
          text: true,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Exa Contents failed (${response.status}): ${err}`);
    }

    const data: any = await response.json();
    const result = data?.results?.[0];
    if (!result) {
      throw new Error("Exa Contents returned empty result");
    }

    const content = result.text || "";
    if (!content.trim()) {
      throw new Error("Exa Contents returned no text content");
    }

    return {
      provider: this.id,
      url: result.url || params.url,
      title: result.title,
      content,
      publishedDate: result.publishedDate,
      durationMs: Date.now() - startTime,
    };
  }
}
