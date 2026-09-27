import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountBalancer } from "./accounts/balancer.js";
import { AccountStore } from "./accounts/store.js";
import { executeWithMultiAccountFailover } from "./accounts/wrapper.js";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./providers/antigravity/constants.js";
import {
  DEFAULT_ANTIGRAVITY_MODELS,
  fetchAndCollapseAntigravityModels,
} from "./providers/antigravity/models.js";
import {
  getAntigravityApiKey,
  loginAntigravity,
  refreshAntigravityToken,
} from "./providers/antigravity/oauth.js";
import { streamAntigravity } from "./providers/antigravity/stream.js";
import { registerCodexFilter } from "./providers/codex/index.js";
import {
  HYPER_API_BASE_URL,
  PROVIDER_ID as HYPER_PROVIDER_ID,
  PROVIDER_NAME as HYPER_PROVIDER_NAME,
} from "./providers/hyper/constants.js";
import {
  DEFAULT_HYPER_MODELS,
  fetchHyperModels,
} from "./providers/hyper/models.js";
import {
  getHyperApiKey,
  loginHyper,
  refreshHyperToken,
} from "./providers/hyper/oauth.js";
import { streamHyper } from "./providers/hyper/stream.js";
import { registerCommitCommand } from "./commit/index.js";
import { registerContinueShortcut } from "./continue/index.js";
import { registerOutputFilter } from "./filter/index.js";
import { registerSmartSearch } from "./search/index.js";
import { registerWorkingTimer } from "./timer/index.js";
import { registerUsageCommand, registerUsageFooter } from "./usage/index.js";

export default async function (pi: ExtensionAPI) {
  // Initialize multi-account store and sync credentials from Pi auth store
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  // Retrieve active token for initial model discovery
  let token: string | undefined;
  const activeAccount = store.getActive(PROVIDER_ID);
  if (activeAccount) {
    try {
      token = await balancer.ensureFreshToken(activeAccount);
    } catch {
      // Non-fatal if offline
    }
  }

  // Dynamically fetch and collapse live models from Google if token is available
  let models = DEFAULT_ANTIGRAVITY_MODELS;
  if (token) {
    try {
      const dynamicModels = await fetchAndCollapseAntigravityModels(token);
      if (dynamicModels && dynamicModels.length > 0) {
        models = dynamicModels;
      }
    } catch {
      // Keep defaults on network failure
    }
  }

  // Register Google Antigravity provider with multi-account failover and streaming support
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    api: "google-antigravity-api" as unknown as Api,

    models,

    async refreshModels(context) {
      if (context?.allowNetwork === false || context?.signal?.aborted) {
        return models;
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
          return liveModels;
        }
      }
      return models;
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

  // Register /usage quota monitor command and live footer display
  registerUsageCommand(pi);
  registerUsageFooter(pi);

  // Register dynamic OpenAI Codex plan filter and multi-account provider
  registerCodexFilter(pi);

  // Register elapsed working timer for the status indicator
  registerWorkingTimer(pi);

  // Register autonomous commit command
  registerCommitCommand(pi);

  // Register "." (literal dot) continue shortcut
  registerContinueShortcut(pi);

  // Register native output filter & token compressor (RTK port)
  registerOutputFilter(pi);

  // Register native pure TypeScript smart search engine & token compressor
  registerSmartSearch(pi);
}
