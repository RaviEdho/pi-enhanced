import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAntigravityProvider } from "./antigravity/register.js";
import { registerCodexFilter } from "./codex/index.js";
import { registerCommandCodeProvider } from "./commandcode/register.js";
import { registerKenariProvider } from "./kenari/register.js";
import { registerTokenHarborProvider } from "./tokenharbor/register.js";
import { registerInferHubProvider } from "./inferhub/register.js";
import { registerOllamaProvider } from "./ollama/index.js";
import { registerOpenCodeGoProvider } from "./opencode-go/register.js";

/**
 * Registers all custom inference providers and dynamic plan filters:
 * - Google Antigravity (Gemini Code Assist)
 * - Command Code (api.commandcode.ai)
 * - Kenari (kenari.id)
 * - Token Harbor (tokenharbor.ai)
 * - InferHub consumer marketplace (inferhub.dev)
 * - OpenAI Codex dynamic plan filter
 * - OpenCode Go native-provider account support
 */
export async function registerProviders(pi: ExtensionAPI): Promise<void> {
  await registerAntigravityProvider(pi);
  await registerCommandCodeProvider(pi);
  await registerKenariProvider(pi);
  registerTokenHarborProvider(pi);
  registerInferHubProvider(pi);
  registerOpenCodeGoProvider(pi);
  await registerOllamaProvider(pi);
  await registerCodexFilter(pi);
  // Pi refreshes providers in the background after initializing its TUI/RPC
  // interface. A second session_start refresh would supersede/duplicate it.
}

// Provider-only SDK entry point for the standalone Discord routing runtime.
export default registerProviders;

export {
  registerAntigravityProvider,
  registerCodexFilter,
  registerCommandCodeProvider,
  registerKenariProvider,
  registerTokenHarborProvider,
  registerInferHubProvider,
  registerOllamaProvider,
};
