import { createHash } from "node:crypto";
import type { AccountCredential } from "../../accounts/types.js";

export const OPENCODE_GO_ID = "opencode-go";
export const OPENCODE_GO_NAME = "OpenCode Go";

// The usage API doesn't identify the member/workspace. Match only exact keys.
export function openCodeGoAccountId(key: string): string {
  return `${OPENCODE_GO_ID}:${createHash("sha256").update(key).digest("hex")}`;
}

/** The native environment fallback is read-only, never imported or mirrored to disk. */
export function getOpenCodeGoEnvAccount(): AccountCredential | undefined {
  const apiKey = process.env.OPENCODE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { id: openCodeGoAccountId(apiKey), provider: OPENCODE_GO_ID, type: "api_key", apiKey, createdAt: 0, updatedAt: 0 };
}

export function isOpenCodeGoEndpoint(baseUrl: string): boolean {
  return /^https:\/\/opencode\.ai\/(?:inference|zen)\/go(?:\/v1)?\/?$/.test(baseUrl);
}
