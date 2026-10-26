import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type ApiKeyCredential,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  AccountBalancer,
  AccountStore,
  executeWithMultiAccountFailover,
} from "../../accounts/index.js";
import {
  HYPER_API_BASE_URL,
  PROVIDER_ID as HYPER_PROVIDER_ID,
  PROVIDER_NAME as HYPER_PROVIDER_NAME,
} from "./constants.js";
import {
  DEFAULT_HYPER_MODELS,
  fetchHyperModels,
  loadCachedModels,
} from "./models.js";
import {
  getHyperApiKey,
  loginHyper,
  refreshHyperToken,
  validateAndStoreHyperApiKey,
} from "./oauth.js";
import { streamHyper } from "./stream.js";

function prismLabel(value: string | undefined): string | undefined {
  return value !== undefined &&
    value.trim() !== "" &&
    value.length <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ? value.trim()
    : undefined;
}

/**
 * Registers Charm Hyper inference provider with dynamic model discovery and multi-account failover.
 */
export async function registerHyperProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  let collectingPrismRoute = false;
  let prismRoute: { modelName: string | undefined; modelId: string | undefined } | undefined;

  // Render Prism meta-routing indication (e.g. "Prism → DeepSeek V4.1 Flash")
  pi.registerEntryRenderer("hyper-prism-route", (entry, _options, theme) => {
    const data = entry.data;
    if (typeof data !== "object" || data === null) return undefined;
    const modelName =
      "modelName" in data && typeof data.modelName === "string" ? prismLabel(data.modelName) : undefined;
    const modelId =
      "modelId" in data && typeof data.modelId === "string" ? prismLabel(data.modelId) : undefined;
    const label = modelName ?? modelId;
    if (label) {
      return new Text(
        `${theme.fg("muted", "Prism")} ${theme.fg("dim", "→")} ${theme.fg("muted", label)}`,
        0,
        0
      );
    }
    return undefined;
  });

  pi.on("turn_start", () => {
    collectingPrismRoute = true;
    prismRoute = undefined;
  });

  pi.on("after_provider_response", (event) => {
    if (!collectingPrismRoute) return;
    const modelName = prismLabel(event.headers?.["x-prism-model-name"]);
    const modelId = prismLabel(event.headers?.["x-prism-model-id"]);
    if (modelName || modelId) {
      prismRoute = { modelName, modelId };
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      collectingPrismRoute = false;
    }
  });

  pi.on("turn_end", (event) => {
    const route = prismRoute;
    prismRoute = undefined;
    collectingPrismRoute = false;
    if (
      event.message.role !== "assistant" ||
      event.message.provider !== HYPER_PROVIDER_ID ||
      event.message.stopReason === "error" ||
      event.message.stopReason === "aborted"
    ) {
      return undefined;
    }
    if (route) {
      return {
        entries: [
          ...event.entries,
          { type: "custom", customType: "hyper-prism-route", data: route },
        ],
      };
    }
    return undefined;
  });

  // Always load from disk cache first, falling back to offline defaults.
  // Live discovery happens through the provider's fetchModels callback, so a
  // background fetch here would duplicate the request and could not update the
  // already-registered provider object.
  const hyperModels = loadCachedModels() || DEFAULT_HYPER_MODELS;

  const resolveApiKey = async (
    credential: ApiKeyCredential | undefined,
    env: (name: string) => Promise<string | undefined>
  ): Promise<{ key: string; source: string } | undefined> => {
    const storedKey = credential?.key?.trim();
    if (storedKey) return { key: storedKey, source: "stored credential" };

    const contextualKey = (await env("HYPER_API_KEY"))?.trim();
    if (contextualKey) return { key: contextualKey, source: "HYPER_API_KEY" };

    const envKey = process.env.HYPER_API_KEY?.trim();
    if (envKey) return { key: envKey, source: "HYPER_API_KEY" };

    const active = store.getActive(HYPER_PROVIDER_ID);
    const accountKey = active?.type === "api_key" ? active.apiKey || active.access : undefined;
    return accountKey ? { key: accountKey, source: "account store" } : undefined;
  };

  const apiKeyAuth: ApiKeyAuth = {
    name: "Charm Hyper API key",
    async login(interaction) {
      const input = await interaction.prompt({
        type: "secret",
        message: "Enter your Charm Hyper API key:",
        placeholder: "Paste Charm Hyper API key...",
      });
      const key = input.trim();
      if (!key) throw new Error("No Charm Hyper API key provided");
      await validateAndStoreHyperApiKey(key, interaction.signal, (message) =>
        interaction.notify({ type: "progress", message })
      );
      return { type: "api_key", key };
    },
    async check({ ctx, credential }) {
      const resolved = await resolveApiKey(credential, (name) => ctx.env(name));
      return resolved ? { type: "api_key", source: resolved.source } : undefined;
    },
    async resolve({ ctx, credential }) {
      const resolved = await resolveApiKey(credential, (name) => ctx.env(name));
      return resolved
        ? { auth: { apiKey: resolved.key }, source: resolved.source }
        : undefined;
    },
  };

  const oauthAuth: OAuthAuth = {
    name: HYPER_PROVIDER_NAME,
    async login(interaction) {
      const credentials = await loginHyper({
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
            message: "Enter the Charm Hyper authorization code:",
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
      return { ...credentials, type: "oauth" } as OAuthCredential;
    },
    async refresh(credential, signal) {
      return {
        ...await refreshHyperToken(credential, signal),
        type: "oauth",
      } as OAuthCredential;
    },
    async toAuth(credential) {
      return { apiKey: getHyperApiKey(credential) };
    },
  };

  const streamWithFailover = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options: SimpleStreamOptions | undefined
  ) =>
    executeWithMultiAccountFailover(
      HYPER_PROVIDER_ID,
      model,
      transcript,
      options,
      (m, ctx, opts, resolvedAuth) => streamHyper(m, ctx, opts, resolvedAuth)
    );

  const streams: ProviderStreams = {
    stream(model, transcript, options?: StreamOptions) {
      return streamWithFailover(model, transcript, options as SimpleStreamOptions | undefined);
    },
    streamSimple(model, transcript, options) {
      return streamWithFailover(model, transcript, options);
    },
  };

  const provider = createProvider<Api>({
    id: HYPER_PROVIDER_ID,
    name: HYPER_PROVIDER_NAME,
    baseUrl: HYPER_API_BASE_URL,
    auth: {
      apiKey: apiKeyAuth,
      oauth: oauthAuth,
    },
    models: hyperModels,
    api: streams,
    async fetchModels(context) {
      if (context.signal.aborted) return [];

      const credential = context.credential;
      const credentialToken = credential?.type === "api_key"
        ? credential.key
        : credential?.type === "oauth"
          ? getHyperApiKey(credential)
          : undefined;
      let token = credentialToken || process.env.HYPER_API_KEY?.trim();
      if (!token) {
        const currentActive = store.getActive(HYPER_PROVIDER_ID);
        if (currentActive) {
          try {
            token = await balancer.ensureFreshToken(currentActive);
          } catch {
            // Keep cached/default models if account refresh fails.
          }
        }
      }

      const live = await fetchHyperModels(token, context.signal);
      return live.length > 0 ? live : (loadCachedModels() || hyperModels);
    },
  });

  pi.registerProvider(provider);
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./stream.js";
export * from "./types.js";
