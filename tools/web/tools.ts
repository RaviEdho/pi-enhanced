/**
 * Web search tool registration.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { FetchProviderId, FetchResponse } from "./fetch/types.js";
import type { SearchProviderId } from "./types.js";

const WebSearchParametersSchema = Type.Object({
  query: Type.String({
    description:
      "Search query string. Supports Google-style operators: site:domain.com, -site:domain.com, after:YYYY-MM-DD, before:YYYY-MM-DD, \"exact phrase\", -term, filetype:pdf.",
  }),
  recency: Type.Optional(
    Type.Union(
      [
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ],
      {
        description: "Optional time filter to restrict results to recent documents.",
      }
    )
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of search results to return (default: 5, max: 20).",
    })
  ),
  provider: Type.Optional(
    Type.Union(
      [
        Type.Literal("brave"),
        Type.Literal("tavily"),
        Type.Literal("antigravity"),
        Type.Literal("tinyfish"),
        Type.Literal("exa"),
        Type.Literal("parallel"),
      ],
      {
        description:
          "Explicitly select search provider. If omitted, uses automatic priority with fallback.",
      }
    )
  ),
});

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  antigravity: "Google Antigravity",
  brave: "Brave",
  tavily: "Tavily",
  exa: "Exa",
  parallel: "Parallel",
  tinyfish: "TinyFish",
};

const activeSearchProviders = new Map<string, string>();

function trackActiveProvider(toolCallId: string, provider: string): void {
  if (activeSearchProviders.size > 200) {
    const firstKey = activeSearchProviders.keys().next().value;
    if (firstKey) activeSearchProviders.delete(firstKey);
  }
  activeSearchProviders.set(toolCallId, provider);
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof WebSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web for up-to-date documentation, APIs, code samples, and current events beyond training cutoff. Supports Google operators (site:, after:, before:, \"quotes\", -exclusions). Automatically fails over across configured search engines (Brave, Tavily, Google Antigravity, TinyFish, Exa, Parallel).",
    parameters: WebSearchParametersSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { SearchPipeline } = await import("./pipeline.js");
      const { formatSearchResponseForLLM } = await import("./formatter.js");
      const pipeline = SearchPipeline.getInstance();

      if (params.provider) {
        trackActiveProvider(toolCallId, params.provider);
      }

      try {
        const { response, notes } = await pipeline.execute(
          {
            query: params.query,
            recency: params.recency,
            limit: params.limit,
            provider: params.provider as SearchProviderId | undefined,
            signal,
          },
          (attemptedProvider) => {
            trackActiveProvider(toolCallId, attemptedProvider);
            onUpdate?.({
              content: [{ type: "text", text: `Searching with ${attemptedProvider}...` }],
              details: {
                response: {
                  provider: attemptedProvider,
                  query: params.query,
                  sources: [],
                },
              },
            });
          }
        );

        if (response.provider && response.provider !== "none") {
          trackActiveProvider(toolCallId, response.provider);
        }

        const formatted = formatSearchResponseForLLM(response, notes);

        return {
          content: [{ type: "text", text: formatted }],
          details: { response },
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Web search error: ${message}` }],
          details: {
            response: {
              provider: "none",
              query: params.query,
              sources: [],
            },
            error: message,
          },
        };
      }
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      if (args?.query) {
        const queryStr = args.query.length > 80 ? `${args.query.slice(0, 77)}...` : args.query;
        text += theme.fg("accent", `"${queryStr}"`);
      }
      const providerId = activeSearchProviders.get(context.toolCallId) || args?.provider;
      if (providerId && providerId !== "none") {
        const name = PROVIDER_DISPLAY_NAMES[providerId] || providerId;
        text += theme.fg("dim", " with ") + theme.fg("toolTitle", name);
      }
      return new Text(text, 0, 0);
    },
  };
}

const WebFetchParametersSchema = Type.Object({
  url: Type.String({
    description: "Target webpage URL to fetch and extract content from.",
  }),
  purpose: Type.Optional(
    Type.String({
      description:
        "Optional statement of why you need this page or what specific info to look for (helps extraction focus).",
    })
  ),
  maxCharacters: Type.Optional(
    Type.Integer({
      minimum: 500,
      maximum: 50000,
      description: "Maximum content characters to return (default: 15000, ~3750 tokens).",
    })
  ),
  provider: Type.Optional(
    Type.Union(
      [
        Type.Literal("tinyfish"),
        Type.Literal("parallel"),
        Type.Literal("exa"),
        Type.Literal("tavily"),
        Type.Literal("jina"),
      ],
      {
        description:
          "Explicitly select fetch provider. If omitted, uses automatic priority with fallback.",
      }
    )
  ),
});

const FETCH_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  parallel: "Parallel",
  tinyfish: "TinyFish",
  exa: "Exa",
  tavily: "Tavily",
  jina: "Jina Reader",
};

const activeFetchProviders = new Map<string, string>();

function trackActiveFetchProvider(toolCallId: string, provider: string): void {
  if (activeFetchProviders.size > 200) {
    const firstKey = activeFetchProviders.keys().next().value;
    if (firstKey) activeFetchProviders.delete(firstKey);
  }
  activeFetchProviders.set(toolCallId, provider);
}

function formatFetchResponseForLLM(res: FetchResponse): string {
  const parts: string[] = [];
  if (res.title) {
    parts.push(`# ${res.title}`);
  }
  parts.push(`URL: ${res.url}`);
  if (res.publishedDate) {
    parts.push(`Date: ${res.publishedDate}`);
  }
  parts.push("");
  parts.push(res.content);
  return parts.join("\n");
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof WebFetchParametersSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract clean Markdown content from any web page, documentation article, or blog post. Automatically handles JavaScript-rendered SPAs and anti-bot challenges with multi-provider failover (TinyFish, Parallel, Exa, Tavily, Jina Reader).",
    parameters: WebFetchParametersSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { FetchPipeline } = await import("./fetch/pipeline.js");
      const pipeline = FetchPipeline.getInstance();

      if (params.provider) {
        trackActiveFetchProvider(toolCallId, params.provider);
      }

      try {
        const response = await pipeline.execute(
          {
            url: params.url,
            purpose: params.purpose,
            maxCharacters: params.maxCharacters,
            provider: params.provider as FetchProviderId | undefined,
            signal,
          },
          (attemptedProvider) => {
            trackActiveFetchProvider(toolCallId, attemptedProvider);
            onUpdate?.({
              content: [{ type: "text", text: `Fetching with ${attemptedProvider}...` }],
              details: {
                response: {
                  provider: attemptedProvider,
                  url: params.url,
                  content: "",
                },
              },
            });
          }
        );

        if (response.provider && response.provider !== "none") {
          trackActiveFetchProvider(toolCallId, response.provider);
        }

        const formatted = formatFetchResponseForLLM(response);

        return {
          content: [{ type: "text", text: formatted }],
          details: { response },
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Web fetch error: ${message}` }],
          details: {
            response: {
              provider: "none",
              url: params.url,
              content: "",
            },
            error: message,
          },
        };
      }
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      if (args?.url) {
        const urlStr = args.url.length > 70 ? `${args.url.slice(0, 67)}...` : args.url;
        text += theme.fg("accent", `"${urlStr}"`);
      }
      const providerId = activeFetchProviders.get(context.toolCallId) || args?.provider;
      if (providerId && providerId !== "none") {
        const name = FETCH_PROVIDER_DISPLAY_NAMES[providerId] || providerId;
        text += theme.fg("dim", " with ") + theme.fg("toolTitle", name);
      }
      return new Text(text, 0, 0);
    },
  };
}
