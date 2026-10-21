import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Credential, Model } from "@earendil-works/pi-ai";
import {
  AccountBalancer,
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
} from "./oauth.js";
import {
  fetchKenariBillingInfo,
  fetchKenariPlans,
  filterKenariModelsForBilling,
  getCachedKenariBilling,
  isKenariFreeModel,
  loadCachedPlans,
} from "./plan.js";
import { streamKenari } from "./stream.js";

/**
 * Registers Kenari inference provider with dynamic model catalog discovery,
 * subscription plan & balance tier filtering, and multi-account failover.
 */
export async function registerKenariProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  const rawKenariModels = loadCachedModels() || DEFAULT_KENARI_MODELS;
  const cachedPlans = loadCachedPlans();

  // Preload plans and billing info in background if credentials exist
  const activeToken = resolveKenariApiKey();
  let initialBilling = getCachedKenariBilling(activeToken);
  if (!initialBilling && activeToken) {
    const currentActive = store.getActive(KENARI_PROVIDER_ID);
    if (
      currentActive &&
      currentActive.planType &&
      currentActive.planType !== "Free" &&
      currentActive.planType !== "PAYG"
    ) {
      initialBilling = {
        planName: currentActive.planType,
        availableMicroIdr: 0,
        hasBalance: false,
        fetchedAt: currentActive.updatedAt,
      };
    }
  }

  if (activeToken) {
    void fetchKenariBillingInfo(activeToken).catch(() => {});
  }
  void fetchKenariPlans().catch(() => {});

  const initialModels = filterKenariModelsForBilling(rawKenariModels, initialBilling, cachedPlans);

  pi.registerProvider(KENARI_PROVIDER_ID, {
    name: KENARI_PROVIDER_NAME,
    baseUrl: KENARI_API_BASE_URL,
    apiKey: "$KENARI_API_KEY",
    api: "openai-completions",

    models: initialModels,

    async refreshModels(context) {
      const plans = await fetchKenariPlans(context?.signal).catch(() => loadCachedPlans());

      if (context?.allowNetwork === false || context?.signal?.aborted) {
        const cached = loadCachedModels() || rawKenariModels;
        const currentActive = store.getActive(KENARI_PROVIDER_ID);
        const token = currentActive?.apiKey || currentActive?.access || process.env.KENARI_API_KEY;
        const billing = getCachedKenariBilling(token);
        return filterKenariModelsForBilling(cached, billing, plans);
      }

      const currentActive = store.getActive(KENARI_PROVIDER_ID);
      let token = process.env.KENARI_API_KEY;
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

      const live = await fetchKenariModels(token, context?.signal);
      const allModels = live && live.length > 0 ? live : (loadCachedModels() || rawKenariModels);

      let billing = token ? await fetchKenariBillingInfo(token, context?.signal).catch(() => null) : null;
      if (!billing && token) {
        billing = getCachedKenariBilling(token);
      }

      if (billing?.planName && currentActive && billing.planName !== currentActive.planType) {
        currentActive.planType = billing.planName;
        currentActive.updatedAt = Date.now();
        store.upsert(currentActive);
      }

      return filterKenariModelsForBilling(allModels, billing, plans);
    },

    oauth: {
      name: KENARI_PROVIDER_NAME,
      login: loginKenari,
      refreshToken: refreshKenariToken,
      getApiKey: getKenariApiKey,
      modifyModels(models, credentials) {
        const token = credentials.access;
        const billing = getCachedKenariBilling(token);
        const plans = loadCachedPlans();
        return filterKenariModelsForBilling(
          models as Model<"openai-completions">[],
          billing,
          plans
        );
      },
    },

    streamSimple(model, transcript, options) {
      return executeWithMultiAccountFailover(
        KENARI_PROVIDER_ID,
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => streamKenari(m, ctx, opts, resolvedAuth)
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
