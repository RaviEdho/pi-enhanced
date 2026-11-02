import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDERS = [
  "google-antigravity",
  "commandcode",
  "kenari",
  "openai-codex",
  "cloudflare-workers-ai",
  "ollama-cloud",
];

// A registry belongs to a Pi runtime. Do not share refreshes across runtimes.
const pending = new WeakMap<ExtensionContext["modelRegistry"], Promise<void>>();

/** Refresh in the background; callers continue using the current filtered catalog. */
export function refreshProviderCatalogs(ctx: ExtensionContext): Promise<void> | undefined {
  if (process.env.PI_OFFLINE !== undefined || process.argv.includes("--offline")) return undefined;
  const registry = ctx.modelRegistry;
  const active = pending.get(registry);
  if (active) return active;
  const refresh = registry.refresh({
    allowNetwork: true,
    providers: PROVIDERS,
    signal: AbortSignal.timeout(15_000),
  }).then(() => {}, () => {}).finally(() => { pending.delete(registry); });
  pending.set(registry, refresh);
  return refresh;
}
