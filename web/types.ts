/**
 * Core type definitions for web search subsystem.
 */

export type SearchProviderId = "antigravity" | "brave" | "tavily" | "exa" | "parallel" | "tinyfish";

export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  ageSeconds?: number;
}

export interface SearchCitation {
  url: string;
  title?: string;
  citedText?: string;
}

export interface SearchResponse {
  provider: SearchProviderId | "none";
  query: string;
  answer?: string;
  sources: SearchSource[];
  citations?: SearchCitation[];
  searchQueries?: string[];
  durationMs?: number;
}

export interface SearchParams {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  provider?: SearchProviderId;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchResultDetails {
  response: SearchResponse;
  error?: string;
}
