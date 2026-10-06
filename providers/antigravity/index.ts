import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AccountBalancer,
  AccountStore,
  executeWithMultiAccountFailover,
} from "../../accounts/index.js";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.js";
import {
  DEFAULT_ANTIGRAVITY_MODELS,
  fetchAndCollapseAntigravityModels,
  loadCachedAntigravityModels,
} from "./models.js";
import {
  getAntigravityApiKey,
  loginAntigravity,
  refreshAntigravityToken,
} from "./oauth.js";
import { streamAntigravity } from "./stream.js";

/**
 * Registers Google Antigravity inference provider with dynamic model discovery and multi-account failover.
 */
export async function registerAntigravityProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  // Always load from disk cache first, falling back to offline defaults
  let models = loadCachedAntigravityModels() || DEFAULT_ANTIGRAVITY_MODELS;

  // Kick off non-blocking background discovery to refresh cached models if active account exists
  const activeAccount = store.getActive(PROVIDER_ID);
  if (activeAccount) {
    void (async () => {
      try {
        const token = await balancer.ensureFreshToken(activeAccount);
        if (token) {
          const dynamicModels = await fetchAndCollapseAntigravityModels(token);
          if (dynamicModels && dynamicModels.length > 0) {
            models = dynamicModels;
          }
        }
      } catch {
        // Non-fatal background refresh
      }
    })();
  }

  // Register Google Antigravity provider with multi-account failover and streaming support
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    api: "google-antigravity-api" as unknown as Api,

    models,

    async refreshModels(context) {
      if (context?.allowNetwork === false || context?.signal?.aborted) {
        return loadCachedAntigravityModels() || models;
      }
      const currentActive = store.getActive(PROVIDER_ID);
      let activeToken: string | undefined;
      if (currentActive) {
        try {
          activeToken = await balancer.ensureFreshToken(currentActive);
        } catch {
          // Ignore
        }
      }
      if (!activeToken && context?.credential?.type === "oauth" && "access" in context.credential) {
        activeToken = (context.credential as { access: string }).access;
      }
      if (activeToken) {
        const liveModels = await fetchAndCollapseAntigravityModels(activeToken, context?.signal);
        if (liveModels && liveModels.length > 0) {
          models = liveModels;
          return liveModels;
        }
      }
      return loadCachedAntigravityModels() || models;
    },

    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey: getAntigravityApiKey,
    },

    streamSimple(model, transcript, options) {
      return executeWithMultiAccountFailover(
        PROVIDER_ID,
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => {
          const apiKey = resolvedAuth.account.projectId
            ? JSON.stringify({
                accessToken: resolvedAuth.token,
                projectId: resolvedAuth.account.projectId,
                email: resolvedAuth.account.email,
              })
            : resolvedAuth.token;
          return streamAntigravity(m, ctx, {
            ...opts,
            apiKey,
          });
        }
      );
    },
  });
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./stream.js";
export * from "./types.js";
