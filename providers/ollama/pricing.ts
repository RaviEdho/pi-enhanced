/** Ollama's published USD prices per million tokens. Null means not published. */
export interface OllamaTokenPrices {
  input: number | null;
  cacheRead: number | null;
  output: number | null;
}

export interface OllamaModelPricing {
  /** The exact model name in the pricing table. */
  model: string;
  regular: OllamaTokenPrices;
  offPeak: OllamaTokenPrices | null;
  /** Regular rates are only an approximation of actual cost when off-peak rates exist. */
  approximate: boolean;
}

export type OllamaPricingMap = ReadonlyMap<string, OllamaModelPricing>;

const URL = "https://ollama.com/pricing";
const MAX_HTML_BYTES = 2_000_000;
const CACHE_MS = 60 * 60 * 1000;
let cache: { prices: OllamaPricingMap; fetchedAt: number } | undefined;

// This deliberately recognizes only the small, inert subset needed by the table.
// Unknown entities or unexpected markup make the row invalid rather than guessing.
function text(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
      const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
      if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
      const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
    }).replace(/\s+/g, " ").trim();
}

function cells(row: string, tag: "th" | "td"): string[] {
  return Array.from(row.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi")), (m) => text(m[1]));
}

function price(value: string): number | null | undefined {
  if (/^(?:-|–|—)$/.test(value)) return null;
  if (!/^\$(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const n = Number(value.slice(1));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse only a recognizable complete pricing table. Returns null on format changes or invalid data. */
export function parseOllamaPricing(html: string): OllamaPricingMap | null {
  if (typeof html !== "string" || html.length > MAX_HTML_BYTES) return null;
  // Ignore inert comments and executable blocks; they must not create fake tables or cells.
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  if (!/prices\s+are\s+per\s+million\s+tokens/i.test(text(clean))) return null;
  const tables = Array.from(clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi));
  const candidates = tables.filter((table) => {
    const rows = Array.from(table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi));
    return rows.some((row) => cells(row[1], "th").map((v) => v.toLowerCase()).join("|") === "model|input|cached input|output");
  });
  if (candidates.length !== 1) return null;
  const rows = Array.from(candidates[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi));
  const regular = new Map<string, OllamaTokenPrices>();
  const offPeak = new Map<string, OllamaTokenPrices>();
  for (const row of rows) {
    if (/<th\b/i.test(row[1])) continue;
    const values = cells(row[1], "td");
    if (values.length !== 4) return null;
    const isOffPeak = /\s+\(off-peak\)$/i.test(values[0]);
    const name = values[0].replace(/\s+\(off-peak\)$/i, "");
    // Model identifiers are ASCII, so entities, labels and unexpected content fail closed.
    if (!/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(name)) return null;
    const input = price(values[1]);
    const cacheRead = price(values[2]);
    const output = price(values[3]);
    if (input === undefined || cacheRead === undefined || output === undefined) return null;
    const target = isOffPeak ? offPeak : regular;
    if (target.has(name)) return null;
    target.set(name, Object.freeze({ input, cacheRead, output }));
  }
  if (!regular.size || [...offPeak.keys()].some((name) => !regular.has(name))) return null;
  const result = new Map<string, OllamaModelPricing>();
  for (const [model, rates] of regular) {
    const discounted = offPeak.get(model) ?? null;
    result.set(model, Object.freeze({ model, regular: rates, offPeak: discounted, approximate: discounted !== null }));
  }
  return result;
}

/** Exact table name first; otherwise only a unique tag-delimited prefix can match. */
export function findOllamaModelPricing(prices: OllamaPricingMap, model: string): OllamaModelPricing | null {
  const exact = prices.get(model);
  if (exact) return exact;
  const matches = [...prices.values()].filter(({ model: name }) =>
    model.startsWith(name + (name.includes(":") ? "-" : ":")),
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Fetch official pricing; failures return the last validated cache, or null when unknown. */
export async function fetchOllamaPricing(signal?: AbortSignal): Promise<OllamaPricingMap | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return new Map(cache.prices);
  try {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const response = await fetch(URL, { headers: { Accept: "text/html" }, redirect: "error", signal: combined });
    if (!response.ok || !response.body) throw new Error("Pricing fetch failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_HTML_BYTES) throw new Error("Pricing page too large");
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
    } finally {
      if (size > MAX_HTML_BYTES) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const prices = parseOllamaPricing(html);
    if (!prices) throw new Error("Invalid pricing table");
    cache = { prices, fetchedAt: Date.now() };
  } catch { /* Unknown without a validated cache; retain stale data on refresh failure. */ }
  return cache ? new Map(cache.prices) : null;
}
