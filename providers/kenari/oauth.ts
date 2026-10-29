import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AccountStore } from "../../accounts/store.js";
import { oauthErrorHtml, oauthSuccessHtml } from "../oauth-page.js";
import {
  ACCOUNT_BALANCE_URL,
  ACCOUNT_QUOTA_URL,
  API_TIMEOUT_MS,
  CLI_AUTH_URL,
  CLI_TOKEN_URL,
  KENARI_USER_AGENT,
  LOGIN_TIMEOUT_MS,
  PROVIDER_ID,
} from "./constants.js";
import { updateCachedKenariBilling } from "./plan.js";
import { fetchKenariModels } from "./models.js";
import type {
  KenariBalanceResponse,
  KenariCliTokenResponse,
  KenariQuotaResponse,
} from "./types.js";

/**
 * Validates a Kenari API key by querying quota or balance.
 */
export async function validateKenariApiKey(
  apiKey: string,
  signal?: AbortSignal
): Promise<{ planName?: string; balanceIdr?: number }> {
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    "User-Agent": KENARI_USER_AGENT,
    Accept: "application/json",
  };

  const [quotaRes, balanceRes] = await Promise.all([
    fetch(ACCOUNT_QUOTA_URL, { headers, signal: combinedSignal }).catch(() => null),
    fetch(ACCOUNT_BALANCE_URL, { headers, signal: combinedSignal }).catch(() => null),
  ]);

  if ((!quotaRes || !quotaRes.ok) && (!balanceRes || !balanceRes.ok)) {
    const errorText = quotaRes ? await quotaRes.text() : "Invalid or revoked API key";
    throw new Error(`Kenari key validation failed: ${errorText}`);
  }

  let planName: string | undefined;
  if (quotaRes && quotaRes.ok) {
    try {
      const quota = (await quotaRes.json()) as KenariQuotaResponse;
      if (quota.plan?.name) {
        planName = quota.plan.name;
      }
    } catch {
      // Ignore
    }
  }

  let balanceIdr: number | undefined;
  let availableMicroIdr = 0;
  if (balanceRes && balanceRes.ok) {
    try {
      const bal = (await balanceRes.json()) as KenariBalanceResponse;
      if (typeof bal.available_micro_idr === "number") {
        availableMicroIdr = bal.available_micro_idr;
        balanceIdr = Math.round(bal.available_micro_idr / 1_000_000);
      }
    } catch {
      // Ignore
    }
  }

  updateCachedKenariBilling(apiKey, {
    planName,
    availableMicroIdr,
    hasBalance: availableMicroIdr > 0,
    fetchedAt: Date.now(),
  });

  return { planName, balanceIdr };
}

/**
 * Resolves the active Kenari API key from env, AccountStore, or auth.json.
 */
export function resolveKenariApiKey(): string | undefined {
  if (process.env.KENARI_API_KEY) {
    return process.env.KENARI_API_KEY.trim();
  }

  const store = AccountStore.getInstance();
  const active = store.getActive(PROVIDER_ID);
  if (active?.apiKey || active?.access) {
    return active.apiKey || active.access;
  }

  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
      const cred = parsed?.[PROVIDER_ID];
      if (typeof cred === "string") return cred;
      if (cred && typeof cred.apiKey === "string") return cred.apiKey;
      if (cred && typeof cred.key === "string") return cred.key;
      if (cred && typeof cred.access === "string") return cred.access;
    } catch {
      // Ignore
    }
  }

  return undefined;
}

/**
 * Returns API key from credentials for Pi runtime.
 */
export function getKenariApiKey(credentials: OAuthCredentials): string {
  return (credentials as any).key || credentials.access || "";
}

/**
 * Refreshes credentials. Since Kenari uses persistent API keys, this is a pass-through.
 */
export async function refreshKenariToken(
  credentials: OAuthCredentials
): Promise<OAuthCredentials> {
  return credentials;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Extracts an API key or authorization code from user input, handling raw keys,
 * authorization codes, or full loopback callback URLs.
 */
function parseAuthorizationInput(input: string): { code?: string; apiKey?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};

  // Direct Kenari API key
  if (trimmed.startsWith("kn-")) {
    return { apiKey: trimmed };
  }

  // Full callback URL (e.g., http://127.0.0.1:PORT/callback?code=...&state=...)
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsedUrl = new URL(trimmed);
      const code = parsedUrl.searchParams.get("code");
      if (code) return { code };
    } catch {
      // Ignore
    }
  }

  // URL query snippet (e.g. code=... or ?code=...)
  if (trimmed.includes("code=")) {
    try {
      const params = new URLSearchParams(trimmed.includes("?") ? trimmed.split("?")[1] : trimmed);
      const code = params.get("code");
      if (code) return { code };
    } catch {
      // Ignore
    }
  }

  // Long string heuristic: likely an API key if long, code if short
  return trimmed.length >= 32 ? { apiKey: trimmed } : { code: trimmed };
}

/**
 * Exchanges PKCE authorization code for an API key.
 */
async function exchangeCode(
  code: string,
  verifier: string,
  signal?: AbortSignal
): Promise<KenariCliTokenResponse> {
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(CLI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": KENARI_USER_AGENT,
    },
    body: JSON.stringify({ code, verifier }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = (await res.text()).trim();
    throw new Error(errorText || `Code exchange failed (HTTP ${res.status})`);
  }

  return (await res.json()) as KenariCliTokenResponse;
}

/** Validates a key, primes the catalog, and preserves the selected login method. */
export async function validateAndStoreKenariApiKey(
  apiKey: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  options: { type?: "api_key" | "oauth"; labelPrefix?: string } = {}
): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("No Kenari API key provided");
  signal?.throwIfAborted();
  onProgress?.("Validating Kenari credentials...");
  const validation = await validateKenariApiKey(key, signal);
  signal?.throwIfAborted();

  // Pi's post-login model sync is offline-only. Prime the catalog first so
  // either login method exposes the live models without a process restart.
  onProgress?.("Loading available Kenari models...");
  await fetchKenariModels(key, signal);
  signal?.throwIfAborted();

  const store = AccountStore.getInstance();
  const existing = store.list(PROVIDER_ID).find(
    (account) => account.apiKey === key || account.access === key
  );
  const displayIdentity = existing?.label || options.labelPrefix ||
    (key.length > 12 ? `${key.slice(0, 7)}...${key.slice(-4)}` : "kn-key");
  const accountId = existing?.id || AccountStore.generateAccountId(PROVIDER_ID, displayIdentity);
  const type = options.type || "api_key";
  store.upsert({
    ...existing,
    id: accountId,
    provider: PROVIDER_ID,
    type,
    apiKey: key,
    access: key,
    ...(type === "oauth" ? { refresh: "", expires: 0 } : {}),
    planType: validation.planName || "PAYG",
    label: displayIdentity,
    email: existing?.email || displayIdentity,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  store.setActive(PROVIDER_ID, accountId);
}

/** Handles browser loopback OAuth sign-in for Kenari. */
export async function loginKenari(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(32).toString("hex");

  let server: Server | undefined;
  let serverPort = 0;
  let timer: NodeJS.Timeout | undefined;

  const { promise: callbackPromise, resolve: callbackResolve, reject: callbackReject } =
    Promise.withResolvers<string>();

  const shutdown = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (server) {
      try {
        server.closeIdleConnections?.();
        server.close();
      } catch {
        // Ignore
      }
      server = undefined;
    }
  };

  try {
    server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
      const hostHeader = req.headers.host || "";
      const isHostAllowed =
        hostHeader === `127.0.0.1:${serverPort}` || hostHeader === `localhost:${serverPort}`;

      if (req.method !== "GET" || reqUrl.pathname !== "/callback" || !isHostAllowed) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const receivedState = reqUrl.searchParams.get("state");
      const code = reqUrl.searchParams.get("code");

      if (receivedState !== state || !code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          oauthErrorHtml(
            "State mismatch or missing authorization code",
            "The authorization request could not be verified. Return to Pi and retry."
          )
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        oauthSuccessHtml(
          "You are now signed in to Kenari. You may close this tab and return to Pi."
        )
      );

      callbackResolve(code);
    });

    // Await server listen so the port is known before triggering Pi UI callbacks
    await new Promise<number>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        const addr = server!.address() as AddressInfo;
        serverPort = addr.port;
        resolve(serverPort);
      });
    }).catch(() => {
      // Fallback gracefully if loopback port cannot be bound
    });

    const authUrl =
      serverPort > 0
        ? `${CLI_AUTH_URL}?challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}&port=${serverPort}&host=${encodeURIComponent(hostname())}`
        : CLI_AUTH_URL;

    // Pi convention: onAuth renders the clickable URL and instructions at the top
    callbacks.onAuth({
      url: authUrl,
      instructions: "A browser window should open. Complete Kenari sign-in in your browser.",
    });

    timer = setTimeout(() => {
      callbackReject(new Error("Login timed out after 5 minutes."));
    }, LOGIN_TIMEOUT_MS);

    // Pi convention: manual input below the URL prompt via onPrompt
    let manualPromise: Promise<string | null> = Promise.resolve(null);
    if (callbacks.onPrompt) {
      manualPromise = (
        callbacks.onPrompt({
          type: "manual_code",
          message: "If sign-in does not complete automatically, paste the final redirect URL:",
          placeholder: "Paste the Kenari redirect URL...",
        } as any)
      )
        .then((input: string) => (input?.trim() ? input.trim() : null))
        .catch(() => null);
    }

    const winner = await Promise.race([
      callbackPromise.then((code) => ({ type: "callback" as const, value: code })),
      manualPromise.then((input) => ({ type: "manual" as const, value: input })),
    ]);

    shutdown();

    let finalApiKey: string;
    let labelPrefix: string | undefined;

    if (winner.type === "callback") {
      callbacks.onProgress?.("Exchanging authorization code with Kenari...");
      const tokenResp = await exchangeCode(winner.value, verifier, callbacks.signal);
      finalApiKey = tokenResp.key;
      labelPrefix = tokenResp.prefix;
    } else if (winner.type === "manual" && winner.value) {
      const parsed = parseAuthorizationInput(winner.value);
      if (parsed.apiKey) {
        finalApiKey = parsed.apiKey;
      } else if (parsed.code) {
        callbacks.onProgress?.("Exchanging authorization code with Kenari...");
        const tokenResp = await exchangeCode(parsed.code, verifier, callbacks.signal);
        finalApiKey = tokenResp.key;
        labelPrefix = tokenResp.prefix;
      } else {
        throw new Error("Login cancelled: invalid input.");
      }
    } else {
      throw new Error("Login cancelled.");
    }

    await validateAndStoreKenariApiKey(
      finalApiKey,
      callbacks.signal,
      (message) => callbacks.onProgress?.(message),
      { type: "oauth", labelPrefix }
    );

    return {
      type: "oauth",
      key: finalApiKey,
      access: finalApiKey,
      refresh: "",
      expires: 0,
    };
  } finally {
    shutdown();
  }
}
