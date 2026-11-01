import type { AccountCredential } from "../../accounts/types.js";

/** A credential identifier, not a verified account identity. */
export function maskedKeyIdentity(key: string): string {
  const trimmed = key.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}` : "key";
}

/** Resolve the same safe account identifier for all usage views. */
export function usageAccountIdentity(account: AccountCredential): string {
  const email = account.email && account.email !== "env-key" ? account.email : undefined;
  const key = account.apiKey || (account.type === "api_key" || account.provider === "ollama-cloud" || account.provider === "kenari" ? account.access : undefined);
  return email || account.label || account.accountId || (key ? maskedKeyIdentity(key) : account.id);
}

export function fallbackUsageIdentity(label: string, token: string): string {
  return label && label !== "default" && label !== "Ollama Cloud"
    ? label : maskedKeyIdentity(token);
}
