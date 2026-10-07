/**
 * Token-budgeted formatter for web search responses.
 */

import type { SearchResponse } from "./types.js";

function truncateSnippet(text: string, maxChars = 280): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

function formatAge(ageSeconds?: number): string | undefined {
  if (!ageSeconds || ageSeconds < 0) return undefined;
  if (ageSeconds < 60) return "just now";
  const days = Math.floor(ageSeconds / 86400);
  if (days === 0) {
    const minutes = Math.floor(ageSeconds / 60);
    if (minutes < 60) {
      return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
    }
    const hours = Math.floor(ageSeconds / 3600);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export function formatSearchResponseForLLM(
  response: SearchResponse,
  notes: readonly string[] = []
): string {
  const parts: string[] = [];

  for (const note of notes) {
    parts.push(`Note: ${note}`);
  }

  if (response.answer?.trim()) {
    parts.push(response.answer.trim());
    if (response.sources.length > 0) {
      parts.push(`\n## Sources (${response.sources.length})`);
    }
  }

  for (const [i, src] of response.sources.entries()) {
    const age = formatAge(src.ageSeconds) || src.publishedDate;
    const ageTag = age ? ` (${age})` : "";
    parts.push(`[${i + 1}] ${src.title}${ageTag}\n    ${src.url}`);
    if (src.snippet) {
      parts.push(`    ${truncateSnippet(src.snippet)}`);
    }
  }

  if (response.citations && response.citations.length > 0) {
    parts.push(`\n## Citations (${response.citations.length})`);
    for (const [i, citation] of response.citations.entries()) {
      const title = citation.title || citation.url;
      parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
      if (citation.citedText) {
        parts.push(`    "${truncateSnippet(citation.citedText, 160)}"`);
      }
    }
  }

  if (parts.length === 0) {
    return `No results found for "${response.query}".`;
  }

  return parts.join("\n");
}
