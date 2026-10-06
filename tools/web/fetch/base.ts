/**
 * Abstract base class for Web Fetch providers.
 */

import type { FetchParams, FetchProviderId, FetchResponse } from "./types.js";

export abstract class FetchProvider {
  abstract readonly id: FetchProviderId;
  abstract readonly label: string;

  abstract isAvailable(): boolean | Promise<boolean>;

  abstract fetch(params: FetchParams): Promise<FetchResponse>;
}
