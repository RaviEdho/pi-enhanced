import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AccountStore } from "../../accounts/store.js";
import {
  API_TIMEOUT_MS,
  CALLBACK_TIMEOUT_MS,
  DEFAULT_CALLBACK_PORT,
  PROVIDER_ID,
  STUDIO_AUTH_CLI_URL,
  WHOAMI_URL,
} from "./constants.js";
import { fetchBillingInfo } from "./plan.js";
import type { CommandCodeWhoamiResponse } from "./types.js";

function successHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Command Code Authorization</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0c0d0e; color: #f4f4f5; }
    .card { background: #18181b; padding: 2.5rem; border-radius: 12px; border: 1px solid #27272a; text-align: center; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; color: #22c55e; }
    p { font-size: 0.95rem; color: #a1a1aa; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ Authenticated</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

function errorHtml(heading: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Command Code Authorization</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0c0d0e; color: #f4f4f5; }
    .card { background: #18181b; padding: 2.5rem; border-radius: 12px; border: 1px solid #27272a; text-align: center; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; color: #ef4444; }
    p { font-size: 0.95rem; color: #a1a1aa; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

/**
 * Validates a Command Code API key by calling /alpha/whoami.
 */
export async function validateCommandCodeApiKey(apiKey: string): Promise<CommandCodeWhoamiResponse> {
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const res = await fetch(WHOAMI_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: timeoutSignal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API key validation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as CommandCodeWhoamiResponse;
}

/**
 * Resolves the currently active Command Code API key from env, AccountStore, or auth.json.
 */
export function resolveCommandCodeApiKey(): string | undefined {
  if (process.env.COMMANDCODE_API_KEY) {
    return process.env.COMMANDCODE_API_KEY.trim();
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
    } catch {}
  }

  return undefined;
}

/**
 * Returns the API key string from OAuthCredentials for Pi runtime calls.
 */
export function getCommandCodeApiKey(credentials: OAuthCredentials): string {
  return (credentials as any).key || credentials.access || "";
}

/**
 * Refreshes or validates Command Code credentials. Since Command Code issues persistent
 * API tokens, this ensures the credential remains active without modification.
 */
export async function refreshCommandCodeToken(
  credentials: OAuthCredentials,
  _signal?: AbortSignal
): Promise<OAuthCredentials> {
  return credentials;
}

/**
 * Authenticates with Command Code via browser redirect loopback or manual API key prompt.
 */
export async function loginCommandCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const store = AccountStore.getInstance();
  const stateToken = randomBytes(24).toString("hex");

  let server: Server | undefined;
  let serverPort = DEFAULT_CALLBACK_PORT;

  const { promise: callbackPromise, resolve: callbackResolve, reject: callbackReject } =
    Promise.withResolvers<string>();

  // Attempt to start loopback server for automatic browser OAuth redirection
  try {
    server = createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
        const path = reqUrl.pathname;

        if (!path.startsWith("/callback")) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml("Not Found", "Callback path not recognized."));
          return;
        }

        const stateParam = reqUrl.searchParams.get("state");
        if (stateParam && stateParam !== stateToken) {
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml("Invalid State", "State parameter mismatch. Return to Pi and retry."));
          return;
        }

        const error = reqUrl.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml("Authorization Denied", reqUrl.searchParams.get("error_description") || error));
          callbackReject(new Error(`Command Code authorization error: ${error}`));
          return;
        }

        const apiKey = reqUrl.searchParams.get("apiKey");
        if (!apiKey) {
          // Could be the intermediate 303 redirect landing page
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(successHtml("Authorization received. You may now return to Pi."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(successHtml("Signed in to Command Code. You may now return to Pi."));
        callbackResolve(apiKey);
      } catch (err) {
        callbackReject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server!.listen(serverPort, "127.0.0.1", () => resolve());
      server!.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          // If default port is taken, try dynamic port 0
          serverPort = 0;
          server!.listen(0, "127.0.0.1", () => {
            const addr = server!.address();
            if (addr && typeof addr === "object") {
              serverPort = addr.port;
            }
            resolve();
          });
        } else {
          reject(err);
        }
      });
    });
  } catch {
    // If local server fails to start, rely on prompt fallback
  }

  const authUrl = `${STUDIO_AUTH_CLI_URL}?callback=${encodeURIComponent(
    `http://127.0.0.1:${serverPort}/callback`
  )}&state=${encodeURIComponent(stateToken)}&mode=redirect`;

  callbacks.onAuth({
    url: authUrl,
    instructions: "Opening browser for Command Code authorization...",
  });

  const promptPromise = (
    callbacks.onPrompt({
      message:
        "Authorize via browser, or enter your Command Code API key from https://commandcode.ai/studio/billing:",
      placeholder: "Paste Command Code API key...",
    } as any)
  ).then((val: string) => {
    if (!val || !val.trim()) {
      throw new Error("Login cancelled: no API key provided");
    }
    return val.trim();
  });

  // Timeout guard
  const timeoutPromise = new Promise<string>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Login timed out after 2 minutes"));
    }, CALLBACK_TIMEOUT_MS);
    timer.unref();
  });

  let apiKey: string;
  try {
    apiKey = await Promise.race([callbackPromise, promptPromise, timeoutPromise]);
  } finally {
    if (server) {
      server.close();
    }
  }

  callbacks.onProgress?.("Validating Command Code credentials...");
  const whoami = await validateCommandCodeApiKey(apiKey);
  const billing = await fetchBillingInfo(apiKey).catch(() => null);

  const userId = whoami.user?.id || whoami.user?.userName || "user";
  const userLabel = whoami.user?.name || whoami.user?.userName || whoami.org?.name || userId;
  const accountId = AccountStore.generateAccountId(PROVIDER_ID, userId);

  store.upsert({
    id: accountId,
    provider: PROVIDER_ID,
    type: "api_key",
    label: userLabel,
    email: whoami.user?.email || whoami.user?.userName,
    accountId: whoami.user?.id,
    orgId: whoami.org?.id,
    orgName: whoami.org?.name,
    planType: billing?.planId || "individual-provider",
    apiKey,
    access: apiKey,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return {
    type: "api_key",
    key: apiKey,
  } as unknown as OAuthCredentials;
}
