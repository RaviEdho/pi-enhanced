import type { Api, ApiStreamOptions, Model, Provider, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../../accounts/store.js";
import { lazyStream } from "../lazy-stream.js";
import { isOpenCodeGoEndpoint, OPENCODE_GO_ID, openCodeGoAccountId } from "./credentials.js";

/** Only retry recognized rate limits, not policy budgets, billing or access errors. */
export function canFailoverOpenCodeGo(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (/\b(?:401|402|403)\b|policy|budget|spend|billing|balance|payment|per.?ip|global|shared/i.test(text)) return false;
  return /\b429\b|\bGoUsageLimitError\b/i.test(text)
    || (typeof error === "object" && error !== null && "status" in error && error.status === 429);
}

/** Keep Pi's catalog, wire adapters, compatibility flags, and request headers. */
export function registerOpenCodeGoProvider(pi: ExtensionAPI): void {
  const base = builtinProviders().find((provider) => provider.id === OPENCODE_GO_ID);
  const auth = base?.auth.apiKey;
  const login = auth?.login;
  if (!base || !auth || !login) return;

  const stream: Provider["stream"] = <T extends Api>(model: Model<T>, transcript: TranscriptContext, options?: ApiStreamOptions<T>) =>
    withAccounts(model, transcript, options, (apiKey) => base.stream(model, transcript, { ...options, apiKey } as ApiStreamOptions<T>));
  const streamSimple: Provider["streamSimple"] = (model, transcript, options) =>
    withAccounts(model, transcript, options, (apiKey) => base.streamSimple(model, transcript, { ...options, apiKey }));

  function withAccounts(
    model: Parameters<Provider["streamSimple"]>[0],
    transcript: Parameters<Provider["streamSimple"]>[1],
    options: Pick<StreamOptions, "apiKey" | "signal" | "sessionId"> | undefined,
    start: (apiKey?: string) => ReturnType<Provider["streamSimple"]>,
  ) {
    const key = options?.apiKey;
    if (!isOpenCodeGoEndpoint(model.baseUrl)) return start(key);
    const store = AccountStore.getInstance();
    store.reloadIfModified(false, 0);
    const accounts = store.list(OPENCODE_GO_ID);
    const active = store.getActive(OPENCODE_GO_ID);
    // Do not substitute a key supplied independently of Pi's active credential.
    if (accounts.length < 2 || !active?.apiKey || (key && key !== active.apiKey)) return start(key);
    return lazyStream(model, options, async () => {
      const [{ AccountBalancer }, { executeWithMultiAccountFailover }] = await Promise.all([
        import("../../accounts/balancer.js"), import("../../accounts/wrapper.js"),
      ]);
      const boundId = AccountBalancer.getInstance().getBoundAccountId(options?.sessionId, OPENCODE_GO_ID);
      const preferred = accounts.find((account) => account.id === boundId) ?? active;
      return () => executeWithMultiAccountFailover(OPENCODE_GO_ID, model, transcript, options,
        (_model, _transcript, _options, resolved) => start(resolved.token), canFailoverOpenCodeGo, preferred.id);
    });
  }

  pi.registerProvider({
    ...base,
    auth: {
      ...base.auth,
      apiKey: {
        ...auth,
        async login(interaction) {
          const credential = await login(interaction);
          interaction.signal.throwIfAborted();
          const key = credential.key?.trim();
          if (!key) throw new Error("OpenCode Go API key cannot be empty.");
          const store = AccountStore.getInstance();
          store.reloadIfModified(false, 0);
          const id = openCodeGoAccountId(key);
          const existing = store.get(id);
          store.upsert({ ...existing, id, provider: OPENCODE_GO_ID, type: "api_key", apiKey: key,
            createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
            disabledCause: undefined, blockedUntil: null, blockedReason: null });
          store.setActive(OPENCODE_GO_ID, id);
          return { ...credential, key };
        },
      },
    },
    stream,
    streamSimple,
  });
}
