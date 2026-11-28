import { fetchTokenHarborUsage } from "../../ux/usage/tokenharbor.js";
import { isProviderNetworkEnabled } from "../network.js";
import { VERIFICATION_TTL_MS } from "./constants.js";
import { tokenHarborCredentialHash } from "./credentials.js";
import { fetchTokenHarborCatalog, isTokenHarborModelVisible } from "./models.js";
import { parseTokenHarborReasoning, type TokenHarborReasoning } from "./reasoning.js";

export interface TokenHarborAccess {
  revision: number;
  checkedAt: number;
  planName?: string;
  passExhausted?: boolean;
  error?: string;
  listing: Awaited<ReturnType<typeof fetchTokenHarborCatalog>>;
  models: Map<string, { coveredByPlans: string[] | null; reasoning: TokenHarborReasoning }>;
}

// Coverage is credential-scoped, short-lived, and never persisted as entitlement.
const snapshots = new Map<string, TokenHarborAccess>();
const pending = new Map<string, Promise<TokenHarborAccess>>();
let revision = 0;

export async function readTokenHarborAccess(key: string, signal?: AbortSignal): Promise<TokenHarborAccess> {
  signal?.throwIfAborted();
  const requestedRevision = ++revision;
  const [listing, report] = await Promise.all([
    fetchTokenHarborCatalog(key, signal), fetchTokenHarborUsage(key, undefined, signal),
  ]);
  signal?.throwIfAborted();
  const pass = report.groups.flatMap(group => group.buckets).find(bucket => bucket.bucketId === "tokenharbor-pass");
  return {
    revision: requestedRevision,
    checkedAt: Math.min(Date.now(), report.fetchedAt),
    planName: report.error ? undefined : report.planType,
    passExhausted: pass?.exhausted,
    error: report.error,
    listing,
    models: new Map(listing.map(item => [item.id as string, {
      coveredByPlans: Array.isArray(item.covered_by_plans) && item.covered_by_plans.every(plan =>
        typeof plan === "string" && plan.length > 0 && plan.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(plan))
        ? [...item.covered_by_plans] as string[] : null,
      reasoning: parseTokenHarborReasoning(item.reasoning),
    }])),
  };
}

/** Publish only inside an accepted native refresh update or a completed runtime check. */
export function publishTokenHarborAccess(key: string, access: TokenHarborAccess): void {
  const hash = tokenHarborCredentialHash(key);
  if ((snapshots.get(hash)?.revision ?? -1) > access.revision) return;
  snapshots.set(hash, access);
}

export function invalidateTokenHarborAccess(key: string): void {
  snapshots.delete(tokenHarborCredentialHash(key));
}

// The published snapshot inherits the allowance lookup's data age, so its validity
// window must match the per-request verification budget; a narrower window here would
// reject mid-request a coverage check that verification just accepted.
function freshAccess(key: string): TokenHarborAccess | undefined {
  const access = snapshots.get(tokenHarborCredentialHash(key));
  return isProviderNetworkEnabled() && access && Date.now() - access.checkedAt < VERIFICATION_TTL_MS ? access : undefined;
}

/** Synchronous account/picker predicate. Unknown paid coverage is never permission. */
export function isTokenHarborModelAllowed(key: string, id: string, requireAllowance = false): boolean {
  if (!isTokenHarborModelVisible(key, id)) return false;
  if (id.endsWith(":free")) return true;
  const access = freshAccess(key);
  return !!access?.planName && (!requireAllowance || access.passExhausted === false)
    && !!access.models.get(id)?.coveredByPlans?.includes(access.planName);
}

export async function refreshTokenHarborAccess(key: string, signal?: AbortSignal, force = false): Promise<TokenHarborAccess> {
  signal?.throwIfAborted();
  if (!isProviderNetworkEnabled()) throw new Error("Token Harbor paid-model coverage cannot be verified offline; choose an explicit :free route.");
  const cached = freshAccess(key);
  if (!force && cached) return cached;
  const hash = tokenHarborCredentialHash(key);
  let request = pending.get(hash);
  if (!request) {
    request = readTokenHarborAccess(key, signal).then(access => {
      signal?.throwIfAborted();
      publishTokenHarborAccess(key, access);
      return access;
    }).catch(() => {
      invalidateTokenHarborAccess(key);
      throw new Error("Token Harbor could not verify current Pass coverage; paid calls are blocked. Check /usage and refresh models.");
    }).finally(() => { if (pending.get(hash) === request) pending.delete(hash); });
    pending.set(hash, request);
  }
  const access = await request;
  signal?.throwIfAborted();
  const latest = freshAccess(key);
  return latest && latest.revision > access.revision ? latest : access;
}

/** Re-read coverage before each paid call, even for manually supplied models/keys. */
export async function verifyTokenHarborRequest(key: string, id: string, signal?: AbortSignal): Promise<TokenHarborReasoning | undefined> {
  signal?.throwIfAborted();
  if (id.endsWith(":free")) {
    if (!isTokenHarborModelVisible(key, id)) throw new Error("Token Harbor free model is not listed for this key; refresh models.");
    return undefined;
  }
  const access = await refreshTokenHarborAccess(key, signal, true);
  if (Date.now() - access.checkedAt >= VERIFICATION_TTL_MS) throw new Error("Token Harbor Pass verification expired before the request; refresh models.");
  const model = access.models.get(id);
  if (!access.planName || !model?.coveredByPlans?.includes(access.planName)) {
    throw new Error("Token Harbor model is not verified as covered by this key's active Pass. Unknown and wallet-only access are blocked.");
  }
  if (access.passExhausted !== false) throw new Error("Token Harbor Pass allowance is exhausted or unknown; wallet continuation is not permitted by this integration.");
  return model.reasoning;
}
