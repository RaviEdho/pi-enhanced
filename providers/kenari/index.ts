import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ApiKeyAuth,
  ApiKeyCredential,
  Credential,
  OAuthAuth,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  AccountStore,
  executeWithMultiAccountFailover,
} from "../../accounts/index.js";
import {
  KENARI_API_BASE_URL,
  PROVIDER_ID as KENARI_PROVIDER_ID,
  PROVIDER_NAME as KENARI_PROVIDER_NAME,
} from "./constants.js";
import {
  DEFAULT_KENARI_MODELS,
  fetchKenariModels,
  loadCachedModels,
} from "./models.js";
import {
  getKenariApiKey,
  loginKenari,
  refreshKenariToken,
  resolveKenariApiKey,
  validateAndStoreKenariApiKey,
} from "./oauth.js";
import {
  fetchKenariBillingInfo,
  fetchKenariPlans,
  filterKenariModelsForBilling,
  getCachedKenariBilling,
  loadCachedPlans,
} from "./plan.js";
import { streamKenari } from "./stream.js";

/** Registers Kenari with native API-key/browser auth, discovery, and failover. */
export async function registerKenariProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  let models = loadCachedModels() || DEFAULT_KENARI_MODELS;

  const credentialKey = (credential?: Credential) => credential?.type === "api_key"
    ? credential.key
    : credential?.type === "oauth"
      ? getKenariApiKey(credential)
      : undefined;

  const getBilling = (token?: string) => {
    const cached = getCachedKenariBilling(token);
    if (cached) return cached;
    const account = store.getActive(KENARI_PROVIDER_ID);
    return account && token && (account.apiKey === token || account.access === token) &&
      account.planType && account.planType !== "Free" && account.planType !== "PAYG"
      ? {
          planName: account.planType,
          availableMicroIdr: 0,
          hasBalance: false,
          fetchedAt: account.updatedAt,
        }
      : null;
  };

  const resolveKey = async (
    credential: ApiKeyCredential | undefined,
    env: (name: string) => Promise<string | undefined>
  ): Promise<{ key: string; source: string } | undefined> => {
    const storedKey = credential?.key?.trim();
    if (storedKey) return { key: storedKey, source: "stored credential" };
    const contextualKey = (await env("KENARI_API_KEY"))?.trim();
    if (contextualKey) return { key: contextualKey, source: "KENARI_API_KEY" };
    const envKey = process.env.KENARI_API_KEY?.trim();
    if (envKey) return { key: envKey, source: "KENARI_API_KEY" };
    const account = store.getActive(KENARI_PROVIDER_ID);
    const key = account?.type === "api_key" ? account.apiKey || account.access : undefined;
    return key ? { key, source: "account store" } : undefined;
  };

  const apiKeyAuth: ApiKeyAuth = {
    name: "Kenari API key",
    async login(interaction) {
      const input = await interaction.prompt({
        type: "secret",
        message: "Enter your Kenari API key:",
        placeholder: "kn-...",
        signal: interaction.signal,
      });
      const key = input.trim();
      await validateAndStoreKenariApiKey(key, interaction.signal, (message) =>
        interaction.notify({ type: "progress", message })
      );
      return { type: "api_key", key };
    },
    async check({ ctx, credential }) {
      const resolved = await resolveKey(credential, (name) => ctx.env(name));
      return resolved ? { type: "api_key", source: resolved.source } : undefined;
    },
    async resolve({ ctx, credential }) {
      const resolved = await resolveKey(credential, (name) => ctx.env(name));
      return resolved ? { auth: { apiKey: resolved.key }, source: resolved.source } : undefined;
    },
  };

  const oauthAuth: OAuthAuth = {
    name: KENARI_PROVIDER_NAME,
    async login(interaction) {
      const credentials = await loginKenari({
        onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
        onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
        onSelect: (prompt) => interaction.prompt({
          type: "select",
          message: prompt.message,
          options: prompt.options,
          signal: interaction.signal,
        }),
        onPrompt: (prompt) => interaction.prompt({
          type: "manual_code",
          message: prompt.message,
          placeholder: prompt.placeholder,
          signal: interaction.signal,
        }),
        onProgress: (message) => interaction.notify({ type: "progress", message }),
        signal: interaction.signal,
      });
      return { ...credentials, type: "oauth" };
    },
    async refresh(credential) {
      return { ...await refreshKenariToken(credential), type: "oauth" };
    },
    async toAuth(credential) {
      return { apiKey: getKenariApiKey(credential) };
    },
  };

  const activeToken = resolveKenariApiKey();
  if (activeToken) void fetchKenariBillingInfo(activeToken).catch(() => {});
  void fetchKenariPlans().catch(() => {});

  const streamWithFailover: Provider<"openai-completions">["streamSimple"] = (model, transcript, options) =>
    executeWithMultiAccountFailover(
      KENARI_PROVIDER_ID,
      model,
      transcript,
      options,
      (m, ctx, opts, resolvedAuth) => streamKenari(m, ctx, opts, resolvedAuth)
    );

  const provider: Provider<"openai-completions"> = {
    id: KENARI_PROVIDER_ID,
    name: KENARI_PROVIDER_NAME,
    baseUrl: KENARI_API_BASE_URL,
    auth: { apiKey: apiKeyAuth, oauth: oauthAuth },
    getModels: () => models,
    async refreshModels(context) {
      if (context.signal.aborted) return;
      const token = credentialKey(context.credential) || resolveKenariApiKey();
      if (context.allowNetwork) {
        await fetchKenariPlans(context.signal).catch(() => {});
      }
      let nextModels = loadCachedModels() || models;
      if (context.allowNetwork) {
        const live = await fetchKenariModels(token, context.signal);
        if (live?.length) nextModels = live;
        const billing = token
          ? await fetchKenariBillingInfo(token, context.signal).catch(() => null)
          : null;
        const account = store.getActive(KENARI_PROVIDER_ID);
        if (billing?.planName && account && (account.apiKey === token || account.access === token) &&
          billing.planName !== account.planType) {
          account.planType = billing.planName;
          store.upsert(account);
        }
      }
      await context.publish({ update: () => { models = nextModels; } });
    },
    filterModels(available, credential) {
      const token = credentialKey(credential) || resolveKenariApiKey();
      return filterKenariModelsForBilling(available, getBilling(token), loadCachedPlans());
    },
    stream(model, transcript, options) {
      return streamWithFailover(model, transcript, options as SimpleStreamOptions | undefined);
    },
    streamSimple: streamWithFailover,
  };
  pi.registerProvider(provider);
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./plan.js";
export * from "./stream.js";
export * from "./types.js";
