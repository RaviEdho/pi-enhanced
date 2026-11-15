import { REQUEST_TIMEOUT_MS } from "./constants.js";

export class InferHubHttpError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "InferHub API key rejected (HTTP 401); run /login inferhub."
      : status === 403 ? "InferHub access denied (HTTP 403); check key scope and account restrictions."
      : `InferHub request failed (HTTP ${status}).`);
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Fixed API URLs only. Never echo response bodies, which can reflect secrets. */
export async function fetchInferHubJson(url: string, key: string, signal?: AbortSignal): Promise<unknown> {
  const combined = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: combined, redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new InferHubHttpError(response.status);
    }
    if (!response.body) throw new Error("Empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("Response too large");
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof InferHubHttpError) throw error;
    throw new Error(combined.aborted ? "InferHub request timed out." : "InferHub request failed or returned invalid data.");
  }
}
