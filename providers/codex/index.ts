import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isModelType,
  type Api,
  type Credential,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../../accounts/store.js";
import { executeWithMultiAccountFailover } from "../../accounts/wrapper.js";
import {
  DEFAULT_FALLBACK_FREE_MODELS,
  fetchLiveCodexCatalog,
  loadCachedCatalog,
  saveCachedCatalog,
} from "./catalog.js";
import { isVisibleCodexModel, mergeCodexModels } from "./models.js";
import { getCodexAccountId, getCodexPlanType } from "./plan.js";

/**
 * Reads stored openai-codex credentials directly from ~/.pi/agent/auth.json or AccountStore.
 */
function getStoredCodexCredential(): { access?: string; accountId?: string } | null {
  const store = AccountStore.getInstance();
  const active = store.getActive("openai-codex");
  if (active?.access) {
    return {
      access: active.access,
      accountId: active.accountId || (getCodexAccountId(active.access) ?? undefined),
    };
  }

  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw);
    const cred = parsed?.["openai-codex"];
    if (cred && typeof cred === "object" && typeof cred.access === "string") {
      return {
        access: cred.access,
        accountId: typeof cred.accountId === "string" ? cred.accountId : getCodexAccountId(cred.access) ?? undefined,
      };
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Registers OpenAI Codex discovery and plan filtering with multi-account failover.
 */
export async function registerCodexFilter(pi: ExtensionAPI): Promise<void> {
  const baseCodex = builtinProviders().find((p) => p.id === "openai-codex");
  if (!baseCodex) {
    return;
  }

  // Startup model selection and --list-models only run offline refreshes. Bootstrap
  // missing/legacy caches before registration, then use Pi's native refresh lifecycle.
  let catalog = loadCachedCatalog();
  if (!catalog || catalog.some((model) => !model.inputModalities)) {
    const stored = getStoredCodexCredential();
    if (stored?.access && stored.accountId) {
      try {
        const live = await fetchLiveCodexCatalog(stored.access, stored.accountId, AbortSignal.timeout(5000));
        if (live.length > 0) {
          catalog = live;
          saveCachedCatalog(live);
        }
      } catch {
        // Offline startup keeps the cache and built-in catalog.
      }
    }
  }
  const getModels = () => mergeCodexModels(baseCodex.getModels(), catalog, baseCodex.baseUrl);

  // Keep the built-in authentication and wire implementation; add discovered models and failover.
  const filteredCodexProvider: Provider = {
    ...baseCodex,
    getModels,
    getAllModels: () => [
      ...(baseCodex.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat")),
      ...getModels(),
    ],

    filterModels(
      models: readonly Model<Api>[],
      credential?: Credential
    ): readonly Model<Api>[] {
      const store = AccountStore.getInstance();
      const accounts = store.list("openai-codex").filter((a) => !a.disabledCause);

      const tokens: string[] = [];
      if (credential && credential.type === "oauth" && credential.access) {
        tokens.push(credential.access);
      }
      for (const a of accounts) {
        if (a.access && !tokens.includes(a.access)) {
          tokens.push(a.access);
        }
      }

      if (tokens.length === 0) {
        return models;
      }

      const plans = new Set<string>();
      for (const t of tokens) {
        const p = getCodexPlanType(t);
        if (p) plans.add(p);
      }

      if (plans.size === 0) {
        return models;
      }

      if (catalog && catalog.length > 0) {
        const allowedSlugs = new Set(
          catalog
            .filter((m) => isVisibleCodexModel(m) && m.availableInPlans.some((plan) => plans.has(plan)))
            .map((m) => m.slug)
        );
        return models.filter((m) => allowedSlugs.has(m.id));
      }

      // Fallback if catalog has not been cached yet
      if (plans.size === 1 && plans.has("free")) {
        return models.filter((m) => DEFAULT_FALLBACK_FREE_MODELS.includes(m.id));
      }

      return models;
    },

    async refreshModels(context) {
      if (context.signal.aborted) return;
      if (baseCodex.refreshModels) {
        await baseCodex.refreshModels(context);
      }
      if (!context.allowNetwork || context.signal.aborted) return;

      const credential = context.credential?.type === "oauth" ? context.credential : undefined;
      const stored = credential?.access ? undefined : getStoredCodexCredential();
      const access = credential?.access ?? stored?.access;
      const accountId = (access && getCodexAccountId(access)) ||
        (credential as { accountId?: string } | undefined)?.accountId || stored?.accountId;
      if (!access || !accountId) return;

      try {
        const live = await fetchLiveCodexCatalog(access, accountId, context.signal);
        if (live.length === 0 || context.signal.aborted) return;
        await context.publish({
          update: () => {
            catalog = live;
            saveCachedCatalog(live);
          },
        });
      } catch {
        // Keep cached discovery and built-in models on network/authentication failure.
      }
    },

    streamSimple(model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) {
      return executeWithMultiAccountFailover(
        "openai-codex",
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => {
          return baseCodex.streamSimple(m, ctx, {
            ...opts,
            apiKey: resolvedAuth.token,
          });
        }
      );
    },
  };

  pi.registerProvider(filteredCodexProvider);
}

/**
 * Registers the OpenAI provider wrapper with multi-account failover for ChatGPT subscription accounts.
 */
export function registerOpenAIProvider(pi: ExtensionAPI): void {
  const baseOpenAI = builtinProviders().find((p) => p.id === "openai");
  if (!baseOpenAI) {
    return;
  }

  const wrappedOpenAI: Provider = {
    ...baseOpenAI,

    streamSimple(model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) {
      const store = AccountStore.getInstance();
      const accounts = store.list("openai").filter((a) => !a.disabledCause);

      // If no accounts or only 1 static API key without OAuth, pass through standard streamSimple
      if (accounts.length === 0 || (accounts.length === 1 && accounts[0].type === "api_key")) {
        return baseOpenAI.streamSimple(model, transcript, options);
      }

      return executeWithMultiAccountFailover(
        "openai",
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => {
          return baseOpenAI.streamSimple(m, ctx, {
            ...opts,
            apiKey: resolvedAuth.token,
          });
        }
      );
    },
  };

  pi.registerProvider(wrappedOpenAI);
}
