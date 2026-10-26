import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type ApiKeyCredential,
  type Credential,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AccountStore,
  executeWithMultiAccountFailover,
} from "../../accounts/index.js";
import {
  COMMANDCODE_PROVIDER_V1_URL,
  PROVIDER_ID as COMMANDCODE_PROVIDER_ID,
  PROVIDER_NAME as COMMANDCODE_PROVIDER_NAME,
} from "./constants.js";
import {
  DEFAULT_COMMANDCODE_MODELS,
  fetchCommandCodeModels,
  loadCachedModels,
} from "./models.js";
import {
  getCommandCodeApiKey,
  loginCommandCode,
  refreshCommandCodeToken,
  resolveCommandCodeApiKey,
  validateAndStoreCommandCodeApiKey,
} from "./oauth.js";
import {
  fetchBillingInfo,
  isModelAllowedForBilling,
} from "./plan.js";
import { streamCommandCode } from "./stream.js";

/**
 * Registers Command Code with native account/API-key login, dynamic discovery,
 * plan filtering, and multi-account failover.
 */
export async function registerCommandCodeProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const commandCodeModels = loadCachedModels() || DEFAULT_COMMANDCODE_MODELS;

  const getAccountBilling = () => {
    const account = store.getActive(COMMANDCODE_PROVIDER_ID);
    return account
      ? {
          planId: account.planType,
          purchasedCredits: 0,
          freeCredits: 0,
          monthlyCredits: 0,
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

    const contextualKey = (await env("COMMANDCODE_API_KEY"))?.trim();
    if (contextualKey) return { key: contextualKey, source: "COMMANDCODE_API_KEY" };

    const key = resolveCommandCodeApiKey()?.trim();
    if (!key) return undefined;
    return {
      key,
      source: process.env.COMMANDCODE_API_KEY?.trim() ? "COMMANDCODE_API_KEY" : "account store",
    };
  };

  const apiKeyAuth: ApiKeyAuth = {
    name: "Command Code API key",
    async login(interaction) {
      const input = await interaction.prompt({
        type: "secret",
        message: "Enter your Command Code API key from https://commandcode.ai/studio/billing:",
        placeholder: "Paste Command Code API key...",
      });
      const key = input.trim();
      if (!key) throw new Error("No Command Code API key provided");
      await validateAndStoreCommandCodeApiKey(key, (message) =>
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
      return resolved
        ? { auth: { apiKey: resolved.key }, source: resolved.source }
        : undefined;
    },
  };

  const oauthAuth: OAuthAuth = {
    name: COMMANDCODE_PROVIDER_NAME,
    async login(interaction) {
      const credentials = await loginCommandCode({
        onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
        onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
        onPrompt: (prompt) =>
          interaction.prompt({
            type: "text",
            message: prompt.message,
            placeholder: prompt.placeholder,
            signal: interaction.signal,
          }),
        onProgress: (message) => interaction.notify({ type: "progress", message }),
        onManualCodeInput: () =>
          interaction.prompt({
            type: "manual_code",
            message: "Paste the Command Code redirect URL:",
            signal: interaction.signal,
          }),
        onSelect: (prompt) =>
          interaction.prompt({
            type: "select",
            message: prompt.message,
            options: prompt.options,
            signal: interaction.signal,
          }),
        signal: interaction.signal,
      });
      return {
        ...credentials,
        type: "oauth",
        access: getCommandCodeApiKey(credentials),
      } as OAuthCredential;
    },
    async refresh(credential, signal) {
      return {
        ...await refreshCommandCodeToken(credential, signal),
        type: "oauth",
      } as OAuthCredential;
    },
    async toAuth(credential) {
      return { apiKey: getCommandCodeApiKey(credential) };
    },
  };

  const streamWithFailover = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options: SimpleStreamOptions | undefined
  ) =>
    executeWithMultiAccountFailover(
      COMMANDCODE_PROVIDER_ID,
      model,
      transcript,
      options,
      (m, ctx, opts, resolvedAuth) => streamCommandCode(m, ctx, opts, resolvedAuth)
    );

  const streams: ProviderStreams = {
    stream(model, transcript, options?: StreamOptions) {
      return streamWithFailover(model, transcript, options as SimpleStreamOptions | undefined);
    },
    streamSimple(model, transcript, options) {
      return streamWithFailover(model, transcript, options);
    },
  };

  const initialToken = resolveCommandCodeApiKey();
  if (initialToken) void fetchBillingInfo(initialToken).catch(() => {});

  const provider = createProvider<Api>({
    id: COMMANDCODE_PROVIDER_ID,
    name: COMMANDCODE_PROVIDER_NAME,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    auth: {
      apiKey: apiKeyAuth,
      oauth: oauthAuth,
    },
    models: commandCodeModels,
    api: streams,
    async fetchModels(context) {
      if (context.signal.aborted) return [];

      const credential = context.credential;
      const credentialToken = credential?.type === "api_key"
        ? credential.key
        : credential?.type === "oauth"
          ? getCommandCodeApiKey(credential)
          : undefined;
      const token = credentialToken || resolveCommandCodeApiKey();
      const currentActive = store.getActive(COMMANDCODE_PROVIDER_ID);

      if (token) {
        void fetchBillingInfo(token, context.signal).then((billing) => {
          if (billing && currentActive && billing.planId && billing.planId !== currentActive.planType) {
            currentActive.planType = billing.planId;
            currentActive.updatedAt = Date.now();
            store.upsert(currentActive);
          }
        }).catch(() => {});
      }

      const live = token ? await fetchCommandCodeModels(token, context.signal) : null;
      const allModels = live && live.length > 0
        ? live
        : loadCachedModels() || commandCodeModels;
      const cachedBilling = currentActive
        ? {
            planId: currentActive.planType,
            purchasedCredits: 0,
            freeCredits: 0,
            monthlyCredits: 0,
            fetchedAt: currentActive.updatedAt,
          }
        : null;
      return allModels.filter((model) => isModelAllowedForBilling(model.id, cachedBilling));
    },
    filterModels(models: readonly Model<Api>[], _credential: Credential | undefined) {
      return models.filter((model) => isModelAllowedForBilling(model.id, getAccountBilling()));
    },
  });

  pi.registerProvider(provider);
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./plan.js";
export * from "./stream.js";
export * from "./types.js";
