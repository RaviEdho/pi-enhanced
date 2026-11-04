import type { ApiKeyAuth, ApiKeyCredential, Model, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProviderNetworkEnabled } from "../network.js";
import { fetchOllamaEntitlement, OLLAMA_FREE_RESTRICTED_MODELS, type OllamaEntitlement } from "./entitlements.js";
import { fetchOllamaModels, loadOllamaCatalog, saveOllamaCatalog, OLLAMA_BASE_URL, OLLAMA_PROVIDER_ID } from "./models.js";

/** Register Ollama Cloud using Pi's existing OpenAI-compatible streaming adapter. */
export async function registerOllamaProvider(pi: ExtensionAPI): Promise<void> {
  let resolvedEnvKey: string | undefined;
  // Keep account state memory-only and tied to the exact key.
  let account: { key: string; entitlement: OllamaEntitlement } | undefined;
  const resolveKey = async (credential: ApiKeyCredential | undefined, env: (name: string) => Promise<string | undefined>) => {
    const stored = credential?.key?.trim();
    if (stored) return { key: stored, source: "stored credential" };
    const key = (await env("OLLAMA_API_KEY"))?.trim() || process.env.OLLAMA_API_KEY?.trim();
    resolvedEnvKey = key;
    return key ? { key, source: "OLLAMA_API_KEY" } : undefined;
  };
  const apiKey: ApiKeyAuth = {
    name: "Ollama Cloud API key",
    async login(interaction) {
      const key = (await interaction.prompt({ type: "secret", message: "Enter your Ollama Cloud API key:", signal: interaction.signal })).trim();
      if (!key) throw new Error("Ollama Cloud API key cannot be empty");
      // Catalog endpoints are public; inspect account data rather than using
      // catalog access as evidence of a valid credential or plan.
      const entitlement = await fetchOllamaEntitlement(key, interaction.signal);
      account = { key, entitlement };
      return { type: "api_key", key };
    },
    async check({ ctx, credential }) {
      const result = await resolveKey(credential, (name) => ctx.env(name));
      return result ? { type: "api_key", source: result.source } : undefined;
    },
    async resolve({ ctx, credential }) {
      const result = await resolveKey(credential, (name) => ctx.env(name));
      return result ? { auth: { apiKey: result.key }, source: result.source } : undefined;
    },
  };
  const streams = openAICompletionsApi();
  // Registration is disk-only, even with an expired cache. The bundled snapshot
  // covers fresh installs; Pi's background refresh publishes live discovery.
  let models: Model<"openai-completions">[] = loadOllamaCatalog()?.models ?? [];
  const provider: Provider<"openai-completions"> = {
    id: OLLAMA_PROVIDER_ID, name: "Ollama Cloud", baseUrl: OLLAMA_BASE_URL,
    auth: { apiKey },
    getModels: () => models,
    async refreshModels(context) {
      if (context.signal.aborted) return;
      const restored = context.stored?.models.filter((model): model is Model<"openai-completions"> =>
        model.provider === OLLAMA_PROVIDER_ID && model.api === "openai-completions" && (!model.type || model.type === "chat"))
        .map((model) => ({ ...model, name: model.id }));
      if (restored?.length && !models.length) await context.publish({ update: () => { models = restored; } });
      if (!context.allowNetwork || !isProviderNetworkEnabled() || context.signal.aborted) return;
      const key = (context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined) || resolvedEnvKey || process.env.OLLAMA_API_KEY?.trim();
      // Publish account changes independently of slower catalog discovery.
      await Promise.all([
        (async () => {
          const entitlement = key ? await fetchOllamaEntitlement(key, context.signal) : undefined;
          if (!context.signal.aborted) await context.publish({ update: () => { account = key && entitlement ? { key, entitlement } : undefined; } });
        })(),
        (async () => {
          const live = await fetchOllamaModels(key, context.signal);
          if (live && !context.signal.aborted) {
            saveOllamaCatalog(live);
            await context.publish({ persist: { models: live, checkedAt: Date.now() }, update: () => { models = live; } });
          }
        })(),
      ]);
    },
    filterModels(available, credential) {
      const key = (credential?.type === "api_key" ? credential.key?.trim() : undefined) || resolvedEnvKey || process.env.OLLAMA_API_KEY?.trim();
      if (!key || account?.key !== key || account.entitlement.plan !== "free" || account.entitlement.purchasedBalance !== 0) return available;
      return available.filter((model) => !OLLAMA_FREE_RESTRICTED_MODELS.has(model.id));
    },
    stream: streams.stream,
    streamSimple: streams.streamSimple,
  };
  pi.registerProvider(provider);
}

export * from "./models.js";
export * from "./entitlements.js";
