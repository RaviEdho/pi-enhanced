import type { ApiKeyCredential, Credential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchCloudflareModels } from "./models.js";
import { detectCloudflareWorkersPlan } from "./plan.js";
import type { CloudflareCatalogModel, CloudflareWorkersPlan } from "./types.js";

const PROVIDER_ID = "cloudflare-workers-ai";

type Connection = { apiToken: string; accountId: string };
export function connectionFor(credential?: Credential): Connection | undefined {
  const apiKey = credential?.type === "api_key" ? credential as ApiKeyCredential : undefined;
  // Match Pi's per-field precedence, including explicitly empty values.
  const apiToken = apiKey?.key ?? process.env.CLOUDFLARE_API_KEY;
  const accountId = apiKey?.env?.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  return apiToken?.trim() && accountId?.trim() ? { apiToken, accountId } : undefined;
}
function sameConnection(a: Connection | undefined, b: Connection | undefined): boolean {
  return !!a && !!b && a.apiToken === b.apiToken && a.accountId === b.accountId;
}

/** Add account-scoped discovery to Pi's native Workers AI provider. */
export async function registerCloudflareProvider(pi: ExtensionAPI): Promise<void> {
  const base = builtinProviders().find((provider) => provider.id === PROVIDER_ID);
  if (!base) return;
  let state: { connection: Connection; catalog?: CloudflareCatalogModel[]; plan: CloudflareWorkersPlan } | undefined;

  async function discover(connection: Connection, signal: AbortSignal) {
    const [catalog, plan] = await Promise.all([
      fetchCloudflareModels({ ...connection, signal }).catch(() => undefined),
      detectCloudflareWorkersPlan({ ...connection, signal }).catch(() => "unknown" as const),
    ]);
    return { connection, catalog, plan };
  }

  // Pi's initial registry refresh can be offline-only, including --list-models.
  // Never persist account-specific discovery or credentials to the model cache.
  if (process.env.PI_OFFLINE === undefined && !process.argv.includes("--offline")) {
    let credential: Credential | undefined;
    try { credential = readStoredCredential(PROVIDER_ID); } catch { /* no readable auth store */ }
    const connection = connectionFor(credential);
    if (connection) state = await discover(connection, AbortSignal.timeout(5000));
  }

  const allowed = <T extends { id: string }>(models: readonly T[], credential?: Credential): readonly T[] => {
    const connection = connectionFor(credential);
    if (!sameConnection(state?.connection, connection) || !state?.catalog) return [];
    const catalog = new Map(state.catalog.map((model) => [model.id, model]));
    return models.filter((model) => {
      const entry = catalog.get(model.id);
      if (!entry) return false;
      // An omitted flag is not a guarantee of access, but Cloudflare's catalog
      // omits it on ordinary models. Reject malformed or conflicting flag values.
      if (Object.hasOwn(entry.properties, "require_workers_paid") && entry.requiresWorkersPaid === undefined) return false;
      return entry.requiresWorkersPaid !== true || state?.plan === "paid";
    });
  };
  const provider: Provider = {
    ...base,
    filterModels(models, credential) {
      return allowed(base.filterModels ? base.filterModels(models, credential) : models, credential);
    },
    async refreshModels(context) {
      if (context.signal.aborted) return;
      if (base.refreshModels) await base.refreshModels(context);
      const connection = connectionFor(context.credential);
      // Clear stale account data even for offline refreshes or missing credentials.
      if (!sameConnection(state?.connection, connection)) {
        await context.publish({ update: () => { state = undefined; } });
      }
      if (!connection || !context.allowNetwork || context.signal.aborted) return;
      const result = await discover(connection, context.signal);
      if (context.signal.aborted) return;
      await context.publish({ update: () => {
        state = result;
      } });
    },
  };
  pi.registerProvider(provider);
}
