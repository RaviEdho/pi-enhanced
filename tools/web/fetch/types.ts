/**
 * Type definitions for web fetch subsystem.
 */

export type FetchProviderId = "tinyfish" | "parallel" | "exa" | "tavily" | "jina";

export interface FetchParams {
  url: string;
  purpose?: string;
  maxCharacters?: number;
  provider?: FetchProviderId;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FetchResponse {
  provider: FetchProviderId | "none";
  url: string;
  title?: string;
  content: string;
  publishedDate?: string;
  durationMs?: number;
  truncated?: boolean;
  totalCharacters?: number;
}
