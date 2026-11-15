import { createHash } from "node:crypto";

/** A credential identifier, not proof that two keys belong to different accounts. */
export function inferHubCredentialHash(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function inferHubAccountId(key: string): string {
  return `inferhub:key-${inferHubCredentialHash(key)}`;
}
