export const THREAD_TITLE_DIAGNOSTIC_KEY = "pi-enhanced:discord-thread-title";

const outcomes = new Set([
  "generated", "auto-title-disabled", "session-inactive", "model-unavailable", "model-lookup-error",
  "empty-source", "completion-error", "completion-aborted", "output-limit", "empty-title", "title-already-set", "save-error",
]);
const causes = new Set(["timeout", "rate-limit", "auth", "access-denied", "bad-request", "provider-unavailable", "network", "unknown"]);

/** Classify the provider failure locally; never send the error text over RPC. */
export function threadTitleFailureCause(value) {
  const text = (value instanceof Error ? `${value.name}: ${value.message}` : typeof value === "string" ? value : "").slice(0, 8000);
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return "timeout";
  if (/\b429\b|rate[-_ ]?limit|usage limit/i.test(text)) return "rate-limit";
  if (/\b401\b|unauthenticated|authentication|(?:no|invalid|missing) api key/i.test(text)) return "auth";
  if (/\b403\b|forbidden|access denied/i.test(text)) return "access-denied";
  if (/\b(?:400|422)\b|bad request|invalid request|unsupported parameter/i.test(text)) return "bad-request";
  if (/\b(?:500|502|503|504|529)\b|overloaded|service unavailable/i.test(text)) return "provider-unavailable";
  if (/network error|fetch failed|ECONNREFUSED|ECONNRESET/i.test(text)) return "network";
  return "unknown";
}

/** Use the same strict field allowlist at the producer and the RPC consumer. */
export function threadTitleDiagnostic(outcome, model, elapsedMs, cause) {
  if (!outcomes.has(outcome) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) return undefined;
  const safeModel = typeof model === "string" && model.length <= 200 &&
    /^(?:session|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/@+~-]+)$/.test(model) ? model : undefined;
  return { outcome, model: safeModel, elapsedMs, cause: causes.has(cause) ? cause : undefined };
}

export function parseThreadTitleDiagnostic(text) {
  if (typeof text !== "string" || text.length > 512) return undefined;
  try {
    const value = JSON.parse(text);
    return threadTitleDiagnostic(value?.outcome, value?.model, value?.elapsedMs, value?.cause);
  } catch {
    return undefined;
  }
}
