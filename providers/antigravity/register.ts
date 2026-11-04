import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../../accounts/store.js";
import { lazyStream } from "../lazy-stream.js";
import { isProviderNetworkEnabled } from "../network.js";
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
import { getAntigravityApiKey } from "./oauth.js";

/** Register cached discovery immediately; load auth flows and inference only when needed. */
export async function registerAntigravityProvider(pi: ExtensionAPI): Promise<void> {
  const store = AccountStore.getInstance();
  const models = loadCachedAntigravityModels() || DEFAULT_ANTIGRAVITY_MODELS;
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    api: "google-antigravity-api" as unknown as Api,
    models,
    async refreshModels(context) {
      if (context?.allowNetwork === false || !isProviderNetworkEnabled() || context?.signal?.aborted) {
        return loadCachedAntigravityModels() || models;
      }
      const currentActive = store.getActive(PROVIDER_ID);
      let activeToken: string | undefined;
      if (currentActive) {
        try {
          const { AccountBalancer } = await import("../../accounts/balancer.js");
          activeToken = await AccountBalancer.getInstance().ensureFreshToken(currentActive);
        } catch {
          // Keep cached discovery when authentication cannot be refreshed.
        }
      }
      if (!activeToken && context?.credential?.type === "oauth" && "access" in context.credential) {
        activeToken = (context.credential as { access: string }).access;
      }
      if (activeToken) {
        const liveModels = await fetchAndCollapseAntigravityModels(activeToken, context?.signal);
        if (liveModels?.length) return liveModels;
      }
      return loadCachedAntigravityModels() || models;
    },
    oauth: {
      name: PROVIDER_NAME,
      async login(callbacks) {
        const { loginAntigravity } = await import("./oauth.js");
        return loginAntigravity(callbacks);
      },
      async refreshToken(credentials, signal) {
        const { refreshAntigravityToken } = await import("./oauth.js");
        return refreshAntigravityToken(credentials, signal);
      },
      getApiKey: getAntigravityApiKey,
    },
    streamSimple(model, transcript, options) {
      return lazyStream(model, options, async () => {
        const [{ executeWithMultiAccountFailover }, { streamAntigravity }] = await Promise.all([
          import("../../accounts/wrapper.js"), import("./stream.js"),
        ]);
        return () => executeWithMultiAccountFailover(PROVIDER_ID, model, transcript, options,
          (m, ctx, opts, resolvedAuth) => {
            const apiKey = resolvedAuth.account.projectId
              ? JSON.stringify({ accessToken: resolvedAuth.token, projectId: resolvedAuth.account.projectId, email: resolvedAuth.account.email })
              : resolvedAuth.token;
            return streamAntigravity(m, ctx, { ...opts, apiKey });
          });
      });
    },
  });
}
