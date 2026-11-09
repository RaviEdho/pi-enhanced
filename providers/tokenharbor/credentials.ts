import { createHash } from "node:crypto";
import { PROVIDER_ID } from "./constants.js";

/** Credential identifiers are not evidence that two keys belong to separate accounts. */
export function tokenHarborCredentialHash(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function tokenHarborAccountId(key: string): string {
  return `${PROVIDER_ID}:key-${tokenHarborCredentialHash(key)}`;
}
