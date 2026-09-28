/**
 * Web search tool registration.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
      ],
      {
        description:
          "Explicitly select search provider. If omitted, uses automatic priority with fallback.",
      }
    )
  ),
});

export function createWebSearchToolDefinition(): ToolDefinition<typeof WebSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web for up-to-date documentation, APIs, code samples, and current events beyond training cutoff. Supports Google operators (site:, after:, before:, \"quotes\", -exclusions). Automatically fails over across configured search engines (Brave, Tavily, Google Antigravity, Exa, Parallel).",
    parameters: WebSearchParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      const pipeline = SearchPipeline.getInstance();

      try {
        const { response, notes } = await pipeline.execute({
          query: params.query,
          recency: params.recency,
          limit: params.limit,
          provider: params.provider as SearchProviderId | undefined,
          signal,
        });

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
  };
}
