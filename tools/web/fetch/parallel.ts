/**
 * Parallel Extract Fetch Provider.
 *
 * Connects to Parallel Extract API (https://api.parallel.ai/v1beta/extract).
 */

import { resolveSearchApiKey } from "../auth.js";
import { FetchProvider } from "./base.js";
import type { FetchParams, FetchResponse } from "./types.js";

const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1beta/extract";

export class ParallelFetchProvider extends FetchProvider {
  readonly id = "parallel" as const;
  readonly label = "Parallel";

  isAvailable(): boolean {
    return Boolean(resolveSearchApiKey("parallel"));
  }

  async fetch(params: FetchParams): Promise<FetchResponse> {
    const startTime = Date.now();
    const apiKey = resolveSearchApiKey("parallel");
    if (!apiKey) {
      throw new Error("No Parallel API key found. Run `/login parallel` or set PARALLEL_API_KEY");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 15000);
    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(PARALLEL_EXTRACT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "parallel-beta": "search-extract-2025-02-10",
          "User-Agent": "pi-coding-agent/1.0",
        },
        body: JSON.stringify({
          urls: [params.url],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Parallel Extract failed (${response.status}): ${err}`);
    }

    const data: any = await response.json();
    const result = data?.results?.[0];
    if (!result) {
      throw new Error("Parallel Extract returned empty result");
    }

    const content =
      result.full_content ||
      result.markdown ||
      result.text ||
      (Array.isArray(result.excerpts) ? result.excerpts.join("\n\n") : "");

    if (!content.trim()) {
      throw new Error("Parallel Extract returned no text content");
    }

    return {
      provider: this.id,
      url: result.url || params.url,
      title: result.title,
      content,
      publishedDate: result.publish_date,
      durationMs: Date.now() - startTime,
    };
  }
}
