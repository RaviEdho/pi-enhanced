/**
 * Registers search providers with Pi's provider system so they appear
 * in `/login` and `/logout` flows and save credentials in `auth.json`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SearchLoginRegistration {
  id: string;
  name: string;
  baseUrl: string;
}

const SEARCH_PROVIDERS: SearchLoginRegistration[] = [
  {
    id: "brave",
    name: "Brave Search",
    baseUrl: "https://api.search.brave.com",
  },
  {
    id: "tavily",
    name: "Tavily Search",
    baseUrl: "https://api.tavily.com",
  },
  {
    id: "exa",
    name: "Exa Search",
    baseUrl: "https://api.exa.ai",
  },
  {
    id: "parallel",
    name: "Parallel Search",
    baseUrl: "https://search.parallel.ai",
  },
  {
    id: "tinyfish",
    name: "TinyFish Search",
    baseUrl: "https://api.search.tinyfish.ai",
  },
];

export function registerSearchLoginProviders(pi: ExtensionAPI): void {
  for (const prov of SEARCH_PROVIDERS) {
    try {
      pi.registerProvider(prov.id, {
        name: prov.name,
        baseUrl: prov.baseUrl,
        models: [],
      });
    } catch {
      // Non-fatal if already registered or running in constrained environment
    }
  }
}
