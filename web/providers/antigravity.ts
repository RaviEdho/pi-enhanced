/**
 * Google Antigravity Grounded Search Provider.
 *
 * Invokes Google Cloud Code Assist with Google Search Grounding (`googleSearch: {}`),
 * reusing active OAuth tokens and multi-account balancing from accounts.json / auth.json.
 */

import { randomUUID } from "node:crypto";
import { AccountBalancer } from "../../accounts/balancer.js";
import { AccountStore } from "../../accounts/store.js";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  getAntigravityUserAgent,
  PROVIDER_ID,
} from "../../providers/antigravity/constants.js";
import type { SearchCitation, SearchParams, SearchResponse, SearchSource } from "../types.js";
import { SearchProvider } from "./base.js";

interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

interface GroundingSupport {
  segment?: {
    text?: string;
  };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  webSearchQueries?: string[];
}

async function resolveRedirectUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (!url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
    return url;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const loc = res.headers.get("location");
    if (loc && (loc.startsWith("http://") || loc.startsWith("https://"))) {
      return loc;
    }
    return url;
  } catch {
    return url;
  }
}

export class AntigravitySearchProvider extends SearchProvider {
  readonly id = "antigravity" as const;
  readonly label = "Google Antigravity Grounding";

  async isAvailable(): Promise<boolean> {
    const store = AccountStore.getInstance();
    const active = store.getActive(PROVIDER_ID);
    return Boolean(active && (active.access || active.refresh));
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startTime = Date.now();
    const store = AccountStore.getInstance();
    const balancer = AccountBalancer.getInstance();

    const activeAccount = store.getActive(PROVIDER_ID);
    if (!activeAccount) {
      throw new Error("No active Google Antigravity account found in store");
    }

    const token = await balancer.ensureFreshToken(activeAccount);
    const projectId = activeAccount.projectId || "";

    const endpoint = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

    const envelope: Record<string, unknown> = {
      requestId: `agent-${randomUUID()}`,
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: params.query }],
          },
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.1,
        },
      },
      model: "gemini-2.5-flash",
      userAgent: "antigravity",
      requestType: "agent",
    };

    if (projectId) {
      envelope.project = projectId;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": getAntigravityUserAgent(),
    };

    const timeout = params.timeoutMs ?? 25000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    if (params.signal) {
      params.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Google Antigravity search failed (${response.status}): ${errText}`);
    }

    const rawText = await response.text();
    const answerParts: string[] = [];
    const sources: SearchSource[] = [];
    const citations: SearchCitation[] = [];
    const searchQueries: string[] = [];

    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;

      let chunk: any;
      try {
        chunk = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      const candidate = chunk.response?.candidates?.[0] ?? chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts || []) {
        if (part.text && !part.thought) {
          answerParts.push(part.text);
        }
      }

      const gm: GroundingMetadata | undefined = candidate.groundingMetadata;
      if (gm) {
        if (gm.groundingChunks) {
          for (const c of gm.groundingChunks) {
            if (c.web?.uri) {
              sources.push({
                title: c.web.title || c.web.uri,
                url: c.web.uri,
              });
            }
          }
        }

        if (gm.groundingSupports && gm.groundingChunks) {
          for (const s of gm.groundingSupports) {
            const citedText = s.segment?.text;
            for (const idx of s.groundingChunkIndices || []) {
              const c = gm.groundingChunks[idx];
              if (c?.web?.uri) {
                citations.push({
                  url: c.web.uri,
                  title: c.web.title || c.web.uri,
                  citedText,
                });
              }
            }
          }
        }

        if (gm.webSearchQueries) {
          for (const q of gm.webSearchQueries) {
            if (!searchQueries.includes(q)) {
              searchQueries.push(q);
            }
          }
        }
      }
    }

    const answer = answerParts.join("").trim();

    // Deduplicate sources by URL
    const seenUrls = new Set<string>();
    const uniqueSources: SearchSource[] = [];
    for (const s of sources) {
      if (!seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        uniqueSources.push(s);
      }
    }

    const limit = Math.min(20, Math.max(1, params.limit ?? 5));
    const cappedSources = uniqueSources.slice(0, limit);

    // Resolve grounding redirect URLs in parallel
    await Promise.all(
      cappedSources.map(async (src) => {
        src.url = await resolveRedirectUrl(src.url, params.signal);
      })
    );

    await Promise.all(
      citations.slice(0, 10).map(async (cit) => {
        cit.url = await resolveRedirectUrl(cit.url, params.signal);
      })
    );

    return {
      provider: this.id,
      query: params.query,
      answer: answer || undefined,
      sources: cappedSources,
      citations: citations.slice(0, 10),
      searchQueries,
      durationMs: Date.now() - startTime,
    };
  }
}
