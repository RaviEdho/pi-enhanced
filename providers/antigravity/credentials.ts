import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { AntigravityApiKeyPayload, AntigravityOAuthCredentials } from "./types.js";

/** Serialize credentials without loading the browser OAuth implementation. */
export function getAntigravityApiKey(credentials: OAuthCredentials): string {
  const creds = credentials as AntigravityOAuthCredentials;
  const payload: AntigravityApiKeyPayload = {
    accessToken: creds.access,
    projectId: creds.projectId,
    email: creds.email,
  };
  return JSON.stringify(payload);
}

export async function parseAntigravityApiKey(rawKey: string): Promise<AntigravityApiKeyPayload> {
  const trimmed = rawKey.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" &&
        "accessToken" in parsed && "projectId" in parsed &&
        typeof parsed.accessToken === "string" && typeof parsed.projectId === "string") {
        return parsed as AntigravityApiKeyPayload;
      }
    } catch {
      // Fall through to raw-token discovery.
    }
  }
  const { discoverProject } = await import("./oauth.js");
  const projectId = await discoverProject(trimmed);
  return { accessToken: trimmed, projectId };
}
