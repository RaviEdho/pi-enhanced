// These helpers deliberately keep absent provider metadata unknown rather than
// filling Pi's required Model fields with invented prices or token limits.
export interface CloudflareConnection {
  accountId: string;
  apiToken: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface CloudflareCatalogModel {
  id: string;
  /** Original catalog entry, including task, pricing and capability metadata. */
  raw: Record<string, unknown>;
  properties: Record<string, unknown>;
  requiresWorkersPaid: boolean | undefined;
}

export type CloudflareWorkersPlan = "paid" | "free" | "unknown";
