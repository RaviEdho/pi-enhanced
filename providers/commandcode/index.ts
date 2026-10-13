import type { Credential, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AccountBalancer,
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
} from "./oauth.js";
import {
  fetchBillingInfo,
  isModelAllowedForBilling,
} from "./plan.js";
import { streamCommandCode } from "./stream.js";

/**
 * Registers Command Code provider with dynamic model discovery, plan tier filtering,
 * and multi-account failover.
 */
export async function registerCommandCodeProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  const commandCodeModels = loadCachedModels() || DEFAULT_COMMANDCODE_MODELS;

  // Preload billing info for existing active account in background
  const activeToken = resolveCommandCodeApiKey();
  if (activeToken) {
    void fetchBillingInfo(activeToken).catch(() => {});
  }

  pi.registerProvider(COMMANDCODE_PROVIDER_ID, {
    name: COMMANDCODE_PROVIDER_NAME,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    apiKey: process.env.COMMANDCODE_API_KEY ? "$COMMANDCODE_API_KEY" : undefined,
    api: "openai-completions",

    models: commandCodeModels,

    async refreshModels(context) {
      if (context?.allowNetwork === false || context?.signal?.aborted) {
        return loadCachedModels() || commandCodeModels;
      }
      const currentActive = store.getActive(COMMANDCODE_PROVIDER_ID);
      let token = process.env.COMMANDCODE_API_KEY;
      if (currentActive) {
        try {
          token = await balancer.ensureFreshToken(currentActive);
        } catch {
          // Ignore
        }
      }
      if (!token && context?.credential) {
        if (context.credential.type === "api_key" && "key" in context.credential && context.credential.key) {
          token = context.credential.key;
        } else if (context.credential.type === "oauth" && "access" in context.credential && context.credential.access) {
          token = (context.credential as { access: string }).access;
        }
      }

      // Also trigger a background refresh of plan billing status
      if (token) {
        void fetchBillingInfo(token, context?.signal).then((b) => {
          if (b && currentActive && b.planId && b.planId !== currentActive.planType) {
            currentActive.planType = b.planId;
            currentActive.updatedAt = Date.now();
            store.upsert(currentActive);
          }
        }).catch(() => {});
      }

      const live = await fetchCommandCodeModels(token, context?.signal);
      const allModels = live && live.length > 0 ? live : (loadCachedModels() || commandCodeModels);
      const cachedBilling = currentActive
        ? {
            planId: currentActive.planType,
            purchasedCredits: 0,
            freeCredits: 0,
            monthlyCredits: 0,
            fetchedAt: currentActive.updatedAt,
          }
        : null;
      return allModels.filter((m) => isModelAllowedForBilling(m.id, cachedBilling));
    },

    oauth: {
      name: COMMANDCODE_PROVIDER_NAME,
      login: loginCommandCode,
      refreshToken: refreshCommandCodeToken,
      getApiKey: getCommandCodeApiKey,
      modifyModels(models, _credentials) {
        const activeAccount = store.getActive(COMMANDCODE_PROVIDER_ID);
        const cachedBilling = activeAccount
          ? {
              planId: activeAccount.planType,
              purchasedCredits: 0,
              freeCredits: 0,
              monthlyCredits: 0,
              fetchedAt: activeAccount.updatedAt,
            }
          : null;
        return models.filter((m) => isModelAllowedForBilling(m.id, cachedBilling));
      },
    },

    streamSimple(model, transcript, options) {
      return executeWithMultiAccountFailover(
        COMMANDCODE_PROVIDER_ID,
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => streamCommandCode(m, ctx, opts, resolvedAuth)
      );
    },
  });
}

export * from "./constants.js";
export * from "./models.js";
export * from "./oauth.js";
export * from "./plan.js";
export * from "./stream.js";
export * from "./types.js";
