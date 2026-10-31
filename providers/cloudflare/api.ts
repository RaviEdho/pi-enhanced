import type { CloudflareConnection } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read all pages or fail rather than silently returning a partial catalog/plan. */
export async function fetchAccountList(connection: CloudflareConnection, path: string): Promise<unknown[]> {
  if (!connection.accountId.trim() || !connection.apiToken.trim()) throw new Error("Cloudflare account ID and API token are required");
  const results: unknown[] = [];
  const perPage = 100;
  for (let page = 1; page <= 1000; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(connection.accountId)}/${path}`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const signal = connection.signal ? AbortSignal.any([connection.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await (connection.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${connection.apiToken}`, Accept: "application/json" }, signal,
    });
    if (!response.ok) throw new Error(`Cloudflare ${path} request failed (HTTP ${response.status})`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) {
      throw new Error(`Cloudflare ${path} returned an invalid or unsuccessful response`);
    }
    results.push(...payload.result);
    const info = isRecord(payload.result_info) ? payload.result_info : undefined;
    if (info && typeof info.page === "number" && info.page !== page) throw new Error(`Cloudflare ${path} returned an unexpected page`);
    const total = info?.total_count;
    if (path === "subscriptions" && typeof total === "number" && Number.isFinite(total) && total >= 0) {
      if (results.length >= total) return results;
      if (payload.result.length === 0) throw new Error("Cloudflare subscriptions returned an incomplete list");
      continue;
    }
    // Model search total_count can include records excluded from the response.
    const size = typeof info?.per_page === "number" && info.per_page > 0 ? info.per_page : perPage;
    if (payload.result.length < size) return results;
  }
  throw new Error(`Cloudflare ${path} pagination limit exceeded`);
}
