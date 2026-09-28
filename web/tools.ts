/**
 * Web search tool registration.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatSearchResponseForLLM } from "./formatter.js";
import { SearchPipeline } from "./pipeline.js";
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
        Type.Literal("antigravity"),
        Type.Literal("brave"),
        Type.Literal("tavily"),
        Type.Literal("exa"),
        Type.Literal("parallel"),
        Type.Literal("tinyfish"),
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
      "Search the live web for up-to-date documentation, APIs, code samples, and current events beyond training cutoff. Supports Google operators (site:, after:, before:, \"quotes\", -exclusions). Automatically fails over across configured search engines (Brave, Tavily, Google Antigravity, Exa, Parallel, TinyFish).",
    parameters: WebSearchParametersSchema,
    execute: async (toolCallId, params, signal, onUpdate) => {
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
