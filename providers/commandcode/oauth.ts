import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AccountStore } from "../../accounts/store.js";
import { oauthErrorHtml, oauthSuccessHtml } from "../oauth-page.js";
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
 * Resolves allowed CORS origin for browser loopback callback requests.
 */
function getAllowedCorsOrigin(origin?: string): string {
  if (!origin) return "https://commandcode.ai";
  if (
    origin === "https://commandcode.ai" ||
    origin === "https://staging.commandcode.ai" ||
    origin === "http://localhost:3000" ||
    origin.endsWith(".commandcode.ai") ||
    origin.startsWith("http://localhost:")
  ) {
    return origin;
  }
  return "https://commandcode.ai";
}

/**
 * Extracts an API key from user prompt input, handling raw keys or full redirect URLs.
 */
function extractApiKeyFromInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("apiKey=")) {
    try {
      const parsed = new URL(trimmed.startsWith("http") ? trimmed : `http://localhost?${trimmed}`);
      const key = parsed.searchParams.get("apiKey");
      if (key) return key;
    } catch {
      const match = trimmed.match(/[?&]apiKey=([^&]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  }
  return trimmed;
}

/**
 * Authenticates with Command Code via browser redirect loopback or manual API key prompt.
 */
export async function loginCommandCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const store = AccountStore.getInstance();
  const stateToken = randomBytes(32).toString("base64url");

  let server: Server | undefined;
  let serverPort = DEFAULT_CALLBACK_PORT;
  let pendingAuth: { apiKey: string; userId?: string; userName?: string; keyName?: string } | null = null;
  let graceTimer: NodeJS.Timeout | null = null;

  const { promise: callbackPromise, resolve: callbackResolve, reject: callbackReject } =
    Promise.withResolvers<string>();

  const shutdownServer = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (server) {
      try {
        server.closeIdleConnections?.();
        server.close();
      } catch {}
      server = undefined;
    }
  };

  // Attempt to start loopback server for automatic browser OAuth redirection
  try {
    server = createServer((req, res) => {
      try {
        const allowedOrigin = getAllowedCorsOrigin(req.headers.origin);
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        // Handle Private Network Access (PNA) preflights from modern browsers
        if (req.method === "OPTIONS") {
          if (req.headers["access-control-request-private-network"] === "true") {
            res.setHeader("Access-Control-Allow-Private-Network", "true");
          }
          res.writeHead(204);
          res.end();
          return;
        }

        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
        const pathname = reqUrl.pathname;

        // 1. Completion landing page (followed via 303 See Other redirect from browser form submission)
        if (pathname === "/callback/complete") {
          const state = reqUrl.searchParams.get("state");
          if (state !== stateToken) {
            res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(
              oauthErrorHtml(
                "Invalid state token",
                "The state token did not match this login attempt. Return to Pi and retry."
              )
            );
            return;
          }

          if (!pendingAuth) {
            res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(
              oauthErrorHtml(
                "Session expired",
                "This authorization has already been processed or expired. Return to Pi."
              )
            );
            return;
          }

          const auth = pendingAuth;
          pendingAuth = null;
          if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }

          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          const welcomeMsg = auth.userName
            ? `Signed in as ${auth.userName}. You may now close this page and return to Pi.`
            : "Signed in to Command Code. You may now close this page and return to Pi.";

          res.end(oauthSuccessHtml(welcomeMsg), () => {
            callbackResolve(auth.apiKey);
            setTimeout(shutdownServer, 500);
          });
          return;
        }

        // 2. Not the callback endpoint
        if (pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Not Found", "Callback route not recognized."));
          return;
        }

        // 3. GET /callback (Direct query parameter callback or manual navigation)
        if (req.method === "GET") {
          const state = reqUrl.searchParams.get("state");
          const err = reqUrl.searchParams.get("error");
          if (err) {
            if (state !== stateToken) {
              res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
              res.end(oauthErrorHtml("Invalid state token", "State parameter mismatch. Return to Pi and retry."));
              return;
            }
            const errDesc = reqUrl.searchParams.get("error_description") || err;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(oauthErrorHtml("Authorization denied", errDesc));
            callbackReject(new Error(`Command Code authorization error: ${errDesc}`));
            setTimeout(shutdownServer, 500);
            return;
          }

          const apiKey = reqUrl.searchParams.get("apiKey");
          if (apiKey) {
            if (state !== stateToken) {
              res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
              res.end(oauthErrorHtml("Invalid state token", "State parameter mismatch. Return to Pi and retry."));
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(
              oauthSuccessHtml("Signed in to Command Code. You may now close this page and return to Pi."),
              () => {
                callbackResolve(apiKey);
                setTimeout(shutdownServer, 500);
              }
            );
            return;
          }

          // GET /callback without params -> informative 405 error
          res.writeHead(405, {
            Allow: "POST, OPTIONS",
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(
            oauthErrorHtml(
              "Return to your terminal",
              "This page completes login automatically during sign-in. Restart login from your terminal if you reached it directly."
            )
          );
          return;
        }

        // 4. POST /callback (Standard Command Code browser OAuth completion)
        if (req.method === "POST") {
          const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          let rawBody = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            rawBody += chunk;
            if (rawBody.length > 65536) {
              req.destroy();
            }
          });

          req.on("end", () => {
            try {
              if (contentType === "application/x-www-form-urlencoded") {
                const params = new URLSearchParams(rawBody);
                const err = params.get("error");
                if (err) {
                  if (params.get("state") !== stateToken) {
                    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(
                      oauthErrorHtml(
                        "Invalid state token",
                        "The state token did not match this login attempt. Return to your terminal and restart login."
                      )
                    );
                    return;
                  }
                  const errDesc = params.get("error_description") || err;
                  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                  res.end(oauthErrorHtml("Authorization denied", errDesc));
                  callbackReject(new Error(errDesc));
                  setTimeout(shutdownServer, 500);
                  return;
                }

                const apiKey = params.get("apiKey");
                const state = params.get("state");
                const userId = params.get("userId") || undefined;
                const userName = params.get("userName") || undefined;
                const keyName = params.get("keyName") || undefined;

                if (!apiKey || state !== stateToken) {
                  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
                  res.end(oauthErrorHtml("Invalid request", "State token mismatch or missing API key."));
                  return;
                }

                pendingAuth = { apiKey, userId, userName, keyName };

                // Grace timer in case the browser does not follow the 303 redirect
                graceTimer = setTimeout(() => {
                  if (pendingAuth) {
                    const k = pendingAuth.apiKey;
                    pendingAuth = null;
                    callbackResolve(k);
                    shutdownServer();
                  }
                }, 10000);
                graceTimer.unref();

                // 303 See Other redirect to /callback/complete
                res.writeHead(303, {
                  Location: `/callback/complete?state=${encodeURIComponent(state)}`,
                  "Cache-Control": "no-store",
                  "Content-Length": "0",
                });
                res.end();
                return;
              }

              if (contentType === "application/json") {
                let json: any;
                try {
                  json = JSON.parse(rawBody);
                } catch {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
                  return;
                }

                if (json.error) {
                  if (json.state !== stateToken) {
                    res.writeHead(403, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: false, error: "Invalid state token" }));
                    return;
                  }
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true }));
                  callbackReject(new Error(json.error_description || json.error));
                  setTimeout(shutdownServer, 500);
                  return;
                }

                if (json.apiKey && json.state === stateToken) {
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true }));
                  callbackResolve(json.apiKey);
                  setTimeout(shutdownServer, 500);
                  return;
                }

                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Missing or invalid parameters" }));
                return;
              }

              res.writeHead(415, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "Unsupported content type" }));
            } catch (postErr) {
              callbackReject(postErr instanceof Error ? postErr : new Error(String(postErr)));
            }
          });
          return;
        }

        res.writeHead(405, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthErrorHtml("Method Not Allowed", "Method not allowed."));
      } catch (err) {
        callbackReject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    serverPort = await new Promise<number>((resolve, reject) => {
      const tryListen = (port: number) => {
        const onError = (err: any) => {
          server!.off("listening", onListening);
          if (err.code === "EADDRINUSE" && port !== 0) {
            tryListen(0);
          } else {
            reject(err);
          }
        };
        const onListening = () => {
          server!.off("error", onError);
          const addr = server!.address();
          resolve(addr && typeof addr === "object" ? addr.port : port);
        };
        server!.once("error", onError);
        server!.once("listening", onListening);
        server!.listen(port, "127.0.0.1");
      };
      tryListen(DEFAULT_CALLBACK_PORT);
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

  const promptPromise = callbacks
    .onPrompt({
      message:
        "Authorize via browser, or enter your Command Code API key from https://commandcode.ai/studio/billing:",
      placeholder: "Paste Command Code API key...",
    } as any)
    .then((val: string) => {
      if (!val || !val.trim()) {
        throw new Error("Login cancelled: no API key provided");
      }
      return extractApiKeyFromInput(val);
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
    shutdownServer();
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
    access: apiKey,
    refresh: "",
    expires: 0,
  } as unknown as OAuthCredentials;
}
