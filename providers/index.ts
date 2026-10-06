import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAntigravityProvider } from "./antigravity/index.js";
import { registerCodexFilter, registerOpenAIProvider } from "./codex/index.js";
import { registerHyperProvider } from "./hyper/index.js";

/**
 * Registers all custom inference providers and dynamic plan filters:
 * - Google Antigravity (Gemini Code Assist)
 * - Charm Hyper (hyper.charm.land)
 * - OpenAI Codex dynamic plan filter
 * - OpenAI ChatGPT subscription wrapper & failover
 */
export async function registerProviders(pi: ExtensionAPI): Promise<void> {
  await registerAntigravityProvider(pi);
  await registerHyperProvider(pi);
  registerCodexFilter(pi);
  registerOpenAIProvider(pi);
}

export { registerAntigravityProvider } from "./antigravity/index.js";
export { registerCodexFilter, registerOpenAIProvider } from "./codex/index.js";
export { registerHyperProvider } from "./hyper/index.js";
