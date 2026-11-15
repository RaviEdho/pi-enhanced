import type { ApiKeyAuth, ApiKeyCredential, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../../accounts/store.js";
import { maskedKeyIdentity } from "../../ux/usage/identity.js";
import { lazyStream } from "../lazy-stream.js";
import { isProviderNetworkEnabled } from "../network.js";
import { BASE_URL, PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import { inferHubAccountId } from "./credentials.js";
import { InferHubHttpError } from "./http.js";
import { buildInferHubModels, discoverInferHubModels, loadInferHubCatalog, removeInferHubCatalog, saveInferHubCatalog } from "./models.js";

/** Consumer inference only: no management API, publisher credentials, or automatic key rotation. */
export function registerInferHubProvider(pi: ExtensionAPI): void {
  const store = AccountStore.getInstance();
  const localKey = () => process.env.INFERHUB_API_KEY?.trim() || store.getActive(PROVIDER_ID)?.apiKey;
  let resolvedKey = localKey();
  const initial = resolvedKey ? loadInferHubCatalog(resolvedKey) : undefined;
  let models = initial ? buildInferHubModels(initial) : [];
  const resolveKey = async (credential: ApiKeyCredential | undefined, env: (name: string) => Promise<string | undefined>) => {
    store.reloadIfModified(false, 0);
    const candidates = [
      { key: credential?.key?.trim(), source: "stored credential" },
      { key: (await env("INFERHUB_API_KEY"))?.trim(), source: "INFERHUB_API_KEY" },
      { key: localKey(), source: "INFERHUB_API_KEY or account store" },
    ];
    const selected = candidates.find(candidate => candidate.key);
    resolvedKey = selected?.key;
    return selected as { key: string; source: string } | undefined;
  };
  const apiKey: ApiKeyAuth = {
    name: "InferHub API key (inference-only recommended)",
    async login(interaction) {
      const key = (await interaction.prompt({ type: "secret", message: "Enter your InferHub inference-only API key:",
        placeholder: "sk-airo-…", signal: interaction.signal })).trim();
      if (!key) throw new Error("No InferHub API key provided.");
      interaction.signal.throwIfAborted();
      interaction.notify({ type: "progress", message: "Validating InferHub key and discovering text models…" });
      const catalog = await discoverInferHubModels(key, interaction.signal);
      interaction.signal.throwIfAborted();
      saveInferHubCatalog(catalog);
      const existing = store.list(PROVIDER_ID).find(account => account.apiKey === key);
      const id = existing?.id ?? inferHubAccountId(key);
      store.upsert({ ...existing, id, provider: PROVIDER_ID, type: "api_key", apiKey: key,
        label: existing?.label ?? maskedKeyIdentity(key), createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
        disabledCause: undefined, blockedUntil: null, blockedReason: null });
      store.setActive(PROVIDER_ID, id);
      resolvedKey = key;
      models = buildInferHubModels(catalog);
      interaction.notify({ type: "progress", message: `${models.length} text routes discovered. Costs use server usage.cost (zero when absent), not marketplace ask estimates.` });
      return { type: "api_key", key };
    },
    async check({ ctx, credential }) {
      const key = await resolveKey(credential, name => ctx.env(name));
      return key ? { type: "api_key", source: key.source } : undefined;
    },
    async resolve({ ctx, credential }) {
      const key = await resolveKey(credential, name => ctx.env(name));
      return key ? { auth: { apiKey: key.key }, source: key.source } : undefined;
    },
  };
  const startStream = (model: Parameters<Provider<"openai-completions">["streamSimple"]>[0],
    transcript: Parameters<Provider<"openai-completions">["streamSimple"]>[1],
    options: SimpleStreamOptions | OpenAICompletionsOptions | undefined, simple: boolean) => lazyStream(model, options as SimpleStreamOptions | undefined, async () => {
    const { streamInferHub } = await import("./stream.js");
    const key = options?.apiKey?.trim();
    // The exact selected key is always used. Never rotate credentials around budgets or allowlists.
    const account = key ? store.list(PROVIDER_ID).find(account => account.apiKey === key) : undefined;
    if (account && options?.sessionId) {
      const { AccountBalancer } = await import("../../accounts/balancer.js");
      AccountBalancer.getInstance().recordSessionBinding(options.sessionId, PROVIDER_ID, account.id);
    }
    return () => streamInferHub(model, transcript, options, simple);
  });
  const provider: Provider<"openai-completions"> = {
    id: PROVIDER_ID, name: PROVIDER_NAME, baseUrl: BASE_URL, auth: { apiKey },
    getModels: () => models,
    async refreshModels(context) {
      context.signal.throwIfAborted();
      const key = context.credential?.type === "api_key" ? context.credential.key?.trim() : resolvedKey ?? localKey();
      const cached = key ? loadInferHubCatalog(key) : undefined;
      const useCached = async () => context.publish({ update: () => { models = cached ? buildInferHubModels(cached) : []; } });
      if (!key || !context.allowNetwork || !isProviderNetworkEnabled()) {
        await useCached();
        return;
      }
      try {
        const catalog = await discoverInferHubModels(key, context.signal);
        await context.publish({ update: () => {
          saveInferHubCatalog(catalog);
          resolvedKey = key;
          models = buildInferHubModels(catalog);
        } });
      } catch (error) {
        if (!context.signal.aborted) {
          if (error instanceof InferHubHttpError && (error.status === 401 || error.status === 403)) {
            await context.publish({ update: () => { removeInferHubCatalog(key); models = []; } });
          } else await useCached();
        }
        throw error;
      }
    },
    filterModels(available, credential) {
      const key = credential?.type === "api_key" ? credential.key?.trim() : resolvedKey ?? localKey();
      const catalog = key ? loadInferHubCatalog(key) : undefined;
      const ids = new Set(catalog?.entries.map(entry => entry.id));
      return available.filter(model => ids.has(model.id));
    },
    stream: (model, transcript, options) => startStream(model, transcript, options as OpenAICompletionsOptions | undefined, false),
    streamSimple: (model, transcript, options) => startStream(model, transcript, options, true),
  };
  pi.registerProvider(provider);
}
