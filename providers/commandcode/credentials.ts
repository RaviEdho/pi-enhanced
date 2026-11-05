import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { AccountStore } from "../../accounts/store.js";
import { PROVIDER_ID } from "./constants.js";

/** Preserve env > pooled account > native auth-file precedence without loading OAuth. */
export function resolveCommandCodeApiKey(): string | undefined {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY.trim();
  const active = AccountStore.getInstance().getActive(PROVIDER_ID);
  if (active?.apiKey || active?.access) return active.apiKey || active.access;
  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (existsSync(authPath)) {
    try {
      const cred = JSON.parse(readFileSync(authPath, "utf-8"))?.[PROVIDER_ID];
      if (typeof cred === "string") return cred;
      if (cred && typeof cred.apiKey === "string") return cred.apiKey;
      if (cred && typeof cred.key === "string") return cred.key;
      if (cred && typeof cred.access === "string") return cred.access;
    } catch {
      // Ignore unreadable or malformed credentials.
    }
  }
  return undefined;
}

export function getCommandCodeApiKey(credentials: OAuthCredentials): string {
  return (credentials as OAuthCredentials & { key?: string }).key || credentials.access || "";
}
