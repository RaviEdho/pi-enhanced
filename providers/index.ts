import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAntigravityProvider } from "./antigravity/index.js";
import { registerCodexFilter, registerOpenAIProvider } from "./codex/index.js";
import { registerCommandCodeProvider } from "./commandcode/index.js";
import { registerKenariProvider } from "./kenari/index.js";
import { registerOllamaProvider } from "./ollama/index.js";
import { registerCloudflareProvider } from "./cloudflare/index.js";

/**
 * Registers all custom inference providers and dynamic plan filters:
 * - Google Antigravity (Gemini Code Assist)
 * - Command Code (api.commandcode.ai)
 * - Kenari (kenari.id)
 * - OpenAI Codex dynamic plan filter
 * - OpenAI ChatGPT subscription wrapper & failover
 */
export async function registerProviders(pi: ExtensionAPI): Promise<void> {
  await registerAntigravityProvider(pi);
  await registerCommandCodeProvider(pi);
  await registerKenariProvider(pi);
  await registerOllamaProvider(pi);
  await registerCloudflareProvider(pi);
  await registerCodexFilter(pi);
  registerOpenAIProvider(pi);
}

export { registerAntigravityProvider } from "./antigravity/index.js";
export { registerCodexFilter, registerOpenAIProvider } from "./codex/index.js";
export { registerCommandCodeProvider } from "./commandcode/index.js";
export { registerKenariProvider } from "./kenari/index.js";
export { registerOllamaProvider } from "./ollama/index.js";
export { registerCloudflareProvider } from "./cloudflare/index.js";
