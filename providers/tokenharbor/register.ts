import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApiKeyAuth, ApiKeyCredential, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AccountStore } from "../../accounts/store.js";
import { maskedKeyIdentity } from "../../ux/usage/identity.js";
import { lazyStream } from "../lazy-stream.js";
import { isProviderNetworkEnabled } from "../network.js";
import { PROVIDER_ID, PROVIDER_NAME, TOKENHARBOR_BASE_URL } from "./constants.js";
import { tokenHarborAccountId } from "./credentials.js";
import { discoverTokenHarborModels, isTokenHarborModelVisible, loadTokenHarborCatalog, saveTokenHarborCatalog } from "./models.js";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";

/** No startup network requests, hardcoded model catalog, browser cookie import, or Pass inference. */
export function registerTokenHarborProvider(pi: ExtensionAPI): void {
  const store = AccountStore.getInstance();
  const storedKey = () => {
    const account = store.getActive(PROVIDER_ID);
    return account?.apiKey || account?.access;
  };
  const localKey = () => process.env.TOKENHARBOR_API_KEY?.trim() || storedKey();
  let resolvedKey = localKey();
  let models = resolvedKey ? loadTokenHarborCatalog(resolvedKey)?.models ?? [] : [];
  const resolveKey = async (
    credential: ApiKeyCredential | undefined,
    env: (name: string) => Promise<string | undefined>,
  ): Promise<{ key: string; source: string } | undefined> => {
    store.reloadIfModified(false, 0);
    const candidates = [
      [credential?.key?.trim(), "stored credential"],
      [(await env("TOKENHARBOR_API_KEY"))?.trim(), "TOKENHARBOR_API_KEY"],
      [process.env.TOKENHARBOR_API_KEY?.trim(), "TOKENHARBOR_API_KEY"],
      [storedKey(), "account store"],
    ];
    const result = candidates.find(([key]) => key);
    resolvedKey = result?.[0];
    return result ? { key: result[0]!, source: result[1]! } : undefined;
  };
  const apiKey: ApiKeyAuth = {
    name: "Token Harbor Universal Key",
    async login(interaction) {
      const key = (await interaction.prompt({ type: "secret", message: "Enter your Token Harbor Universal Key:", placeholder: "thk_live_…", signal: interaction.signal })).trim();
      if (!key) throw new Error("No Token Harbor API key provided");
      interaction.signal.throwIfAborted();
      interaction.notify({ type: "progress", message: "Validating Token Harbor key and loading verified model metadata…" });
      const catalog = await discoverTokenHarborModels(key, interaction.signal, true);
      interaction.signal.throwIfAborted();
      saveTokenHarborCatalog(catalog);
      const existing = store.list(PROVIDER_ID).find(account => account.apiKey === key || account.access === key);
      const id = existing?.id ?? tokenHarborAccountId(key);
      store.upsert({ ...existing, id, provider: PROVIDER_ID, type: "api_key", apiKey: key,
        label: existing?.label ?? maskedKeyIdentity(key), createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
        disabledCause: undefined, blockedUntil: null, blockedReason: null, requiresAuthRefresh: false });
      store.setActive(PROVIDER_ID, id);
      resolvedKey = key;
      interaction.notify({ type: "progress", message: `${catalog.models.length} models have verified metadata; ${catalog.skipped.length} omitted because metadata is incomplete. Catalog visibility does not guarantee Pass coverage. Use /usage for live Pass and free allowances.` });
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
  const streamWithAccounts: Provider<"openai-completions">["streamSimple"] = (model, transcript, options) =>
    startStream(model, transcript, options, true);
  const startStream = (
    model: Parameters<Provider<"openai-completions">["streamSimple"]>[0],
    transcript: Parameters<Provider<"openai-completions">["streamSimple"]>[1],
    options: SimpleStreamOptions | OpenAICompletionsOptions | undefined,
    simple: boolean,
  ) => lazyStream(model, options as SimpleStreamOptions | undefined, async () => {
    const [{ executeWithMultiAccountFailover }, { streamTokenHarbor, canFailoverTokenHarbor }] = await Promise.all([
      import("../../accounts/wrapper.js"), import("./stream.js"),
    ]);
    const key = options?.apiKey?.trim();
    store.reloadIfModified(false, 0);
    const preferred = key ? store.list(PROVIDER_ID).find(account => account.apiKey === key || account.access === key) : undefined;
    if (preferred?.disabledCause) throw new Error("The selected Token Harbor credential is unavailable; run /login tokenharbor.");
    if (key && !isTokenHarborModelVisible(key, model.id)) throw new Error("The model is not listed for the selected Token Harbor key; refresh discovery or choose another model.");
    // An explicit unmanaged key must never be replaced by the stored pool.
    if (key && !preferred) {
      return () => streamTokenHarbor(model, transcript, options, {
        account: { id: tokenHarborAccountId(key), provider: PROVIDER_ID, type: "api_key", apiKey: key, createdAt: Date.now(), updatedAt: Date.now() },
        token: key,
      }, simple);
    }
    return () => executeWithMultiAccountFailover(PROVIDER_ID, model, transcript, options as SimpleStreamOptions | undefined,
      (m, context, requestOptions, auth) => streamTokenHarbor(m, context, requestOptions, auth, simple), canFailoverTokenHarbor, preferred?.id);
  });
  const provider: Provider<"openai-completions"> = {
    id: PROVIDER_ID, name: PROVIDER_NAME, baseUrl: TOKENHARBOR_BASE_URL, auth: { apiKey },
    getModels: () => models,
    async refreshModels(context) {
      context.signal.throwIfAborted();
      const key = context.credential?.type === "api_key" ? context.credential.key?.trim() : resolvedKey ?? localKey();
      const cached = key ? loadTokenHarborCatalog(key) : undefined;
      if (!key || !context.allowNetwork || !isProviderNetworkEnabled()) {
        await context.publish({ update: () => { models = cached?.models ?? []; } });
        return;
      }
      try {
        const catalog = await discoverTokenHarborModels(key, context.signal, context.force);
        await context.publish({ update: () => {
          saveTokenHarborCatalog(catalog);
          models = catalog.models;
          resolvedKey = key;
        } });
      } catch (error) {
        if (!context.signal.aborted) await context.publish({ update: () => { models = cached?.models ?? []; } });
        throw error;
      }
    },
    filterModels(available, credential) {
      const key = credential?.type === "api_key" ? credential.key?.trim() : resolvedKey ?? localKey();
      const catalog = key ? loadTokenHarborCatalog(key) : undefined;
      if (!catalog) return [];
      const ids = new Set(catalog.models.map(model => model.id));
      return available.filter(model => ids.has(model.id));
    },
    stream(model, transcript, options) { return startStream(model, transcript, options as OpenAICompletionsOptions | undefined, false); },
    streamSimple: streamWithAccounts,
  };
  pi.registerProvider(provider);
}
