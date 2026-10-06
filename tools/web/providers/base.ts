/**
 * Abstract base class for web search providers.
 */

import type { SearchParams, SearchProviderId, SearchResponse } from "../types.js";

export abstract class SearchProvider {
  abstract readonly id: SearchProviderId;
  abstract readonly label: string;

  /**
   * Check whether this provider is currently available (credentials present).
   */
  abstract isAvailable(): Promise<boolean> | boolean;

  /**
   * Execute web search query and return parsed results.
   */
  abstract search(params: SearchParams): Promise<SearchResponse>;
}
