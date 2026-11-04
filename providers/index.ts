import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAntigravityProvider } from "./antigravity/register.js";
import { registerCodexFilter } from "./codex/index.js";
import { registerCommandCodeProvider } from "./commandcode/register.js";
import { registerKenariProvider } from "./kenari/register.js";
import { registerOllamaProvider } from "./ollama/index.js";

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
  // Pi refreshes providers in the background after initializing its TUI/RPC
  // interface. A second session_start refresh would supersede/duplicate it.
}

export {
  registerAntigravityProvider,
  registerCodexFilter,
  registerCommandCodeProvider,
  registerKenariProvider,
  registerOllamaProvider,
};
