import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "./models.js";
import {
  getHyperApiKey,
  loginHyper,
  refreshHyperToken,
} from "./oauth.js";
import { streamHyper } from "./stream.js";

/**
 * Registers Charm Hyper inference provider with dynamic model discovery and multi-account failover.
 */
export async function registerHyperProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  // Retrieve active token for Charm Hyper initial model discovery
  let hyperToken: string | undefined = process.env.HYPER_API_KEY;
  const activeHyperAccount = store.getActive(HYPER_PROVIDER_ID);
  if (activeHyperAccount) {
    try {
      hyperToken = await balancer.ensureFreshToken(activeHyperAccount);
    } catch {
      // Non-fatal if offline
    }
  }

  // Dynamically fetch live models from Charm Hyper
  let hyperModels = DEFAULT_HYPER_MODELS;
  try {
    const dynamicHyperModels = await fetchHyperModels(hyperToken);
    if (dynamicHyperModels && dynamicHyperModels.length > 0) {
      hyperModels = dynamicHyperModels;
    }
  } catch {
    // Keep defaults on network failure
  }

  // Register Charm Hyper provider with multi-account failover and streaming support
  pi.registerProvider(HYPER_PROVIDER_ID, {
    name: HYPER_PROVIDER_NAME,
    baseUrl: HYPER_API_BASE_URL,
    apiKey: process.env.HYPER_API_KEY ? "$HYPER_API_KEY" : undefined,
    api: "openai-completions",

    models: hyperModels,

    async refreshModels(context) {
      if (context?.allowNetwork === false || context?.signal?.aborted) {
        return hyperModels;
      }
      const currentActive = store.getActive(HYPER_PROVIDER_ID);
      let activeToken = process.env.HYPER_API_KEY;
      if (currentActive) {
        try {
          activeToken = await balancer.ensureFreshToken(currentActive);
        } catch {
          // Ignore
        }
      }
      if (!activeToken && context?.credential) {
        if (context.credential.type === "api_key" && "key" in context.credential && context.credential.key) {
          activeToken = context.credential.key;
        } else if (context.credential.type === "oauth" && "access" in context.credential && context.credential.access) {
          activeToken = (context.credential as { access: string }).access;
        }
      }
      if (!activeToken) {
        return hyperModels;
      }
      const live = await fetchHyperModels(activeToken, context?.signal);
      return live && live.length > 0 ? live : hyperModels;
    },

    oauth: {
      name: HYPER_PROVIDER_NAME,
      login: loginHyper,
      refreshToken: refreshHyperToken,
      getApiKey: getHyperApiKey,
    },

    streamSimple(model, transcript, options) {
      return executeWithMultiAccountFailover(
        HYPER_PROVIDER_ID,
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => streamHyper(m, ctx, opts, resolvedAuth)
      );
    },
  });
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./stream.js";
export * from "./types.js";
