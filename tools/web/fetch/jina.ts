/**
 * Jina Reader Fetch Provider.
 *
 * Free, zero-auth public fallback reader (https://r.jina.ai/).
 */

import { FetchProvider } from "./base.js";
import type { FetchParams, FetchResponse } from "./types.js";

const JINA_READER_BASE = "https://r.jina.ai/";

export class JinaFetchProvider extends FetchProvider {
  readonly id = "jina" as const;
  readonly label = "Jina Reader";

  isAvailable(): boolean {
    return true; // Free, unauthenticated fallback
  }

  async fetch(params: FetchParams): Promise<FetchResponse> {
    const startTime = Date.now();
    const targetUrl = params.url.startsWith("http") ? params.url : `https://${params.url}`;
    const endpoint = `${JINA_READER_BASE}${targetUrl}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 15000);
    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "text/plain",
          "User-Agent": "pi-coding-agent/1.0",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Jina Reader failed (${response.status}): ${err}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error("Jina Reader returned empty response");
    }

    const titleMatch = text.match(/^Title:\s*(.+)$/m) || text.match(/^#\s+(.+)$/m);

    return {
      provider: this.id,
      url: targetUrl,
      title: titleMatch ? titleMatch[1].trim() : undefined,
      content: text,
      durationMs: Date.now() - startTime,
    };
  }
}
