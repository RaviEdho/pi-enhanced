import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAntigravityProvider } from "./antigravity/index.js";
import { registerCodexFilter } from "./codex/index.js";
import { registerCommandCodeProvider } from "./commandcode/index.js";
import { registerKenariProvider } from "./kenari/index.js";
import { registerOllamaProvider } from "./ollama/index.js";
import { refreshProviderCatalogs } from "./refresh.js";

/**
 * Registers all custom inference providers and dynamic plan filters:
 * - Google Antigravity (Gemini Code Assist)
 * - Command Code (api.commandcode.ai)
 * - Kenari (kenari.id)
 * - OpenAI Codex dynamic plan filter
 */
export async function registerProviders(pi: ExtensionAPI): Promise<void> {
  await registerAntigravityProvider(pi);
  await registerCommandCodeProvider(pi);
  await registerKenariProvider(pi);
  await registerOllamaProvider(pi);
  await registerCodexFilter(pi);
  pi.on("session_start", (_event, ctx) => {
    refreshProviderCatalogs(ctx);
  });
}

export { registerAntigravityProvider } from "./antigravity/index.js";
export { registerCodexFilter } from "./codex/index.js";
export { registerCommandCodeProvider } from "./commandcode/index.js";
export { registerKenariProvider } from "./kenari/index.js";
export { registerOllamaProvider } from "./ollama/index.js";
