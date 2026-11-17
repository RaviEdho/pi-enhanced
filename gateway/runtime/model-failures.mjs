/** Only publish recognized error categories, never raw provider bodies/account lists. */
export function summarizeModelFailure(errorMessage) {
  const text = typeof errorMessage === "string" ? errorMessage.slice(0, 16_000) : "";
  const result = (reason, unavailable = false) => ({ reason, unavailable });
  // Transient/usage/context failures are not evidence that another model should
  // be selected. Pi owns their retries and account failover.
  if (/context[_ -]?(?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long/i.test(text)) {
    return result("The request exceeds the model's context limit.");
  }
  if (/rate[_ -]?limit|\b429\b|quota exhausted|currently rate-limited or exhausted|usage limit/i.test(text)) {
    return result("The provider's rate or usage limit was reached.");
  }
  if (/insufficient[_ -]?(?:credits?|balance|funds)|credit balance|payment required|\b402\b/i.test(text)) {
    return result("The provider reports insufficient balance or credits.");
  }
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network error/i.test(text)) {
    return result("The provider request timed out or failed to connect.");
  }
  if (/\b(?:500|502|503|504|529)\b|overloaded|internal server error|service unavailable/i.test(text)) {
    return result("The provider reports a temporary server error.");
  }
  if (/not available on free plan/i.test(text)) return result("Not available on free plan.", true);
  if (/not available on .{1,80} plan|not (?:included|available) (?:in|on|for) (?:your|this|the current) (?:subscription|plan)|subscription (?:does not|doesn't) (?:include|allow)/i.test(text)) {
    return result("The model is not available on this account's plan.", true);
  }
  if (/model[_ -]not[_ -]found|model.{0,100}(?:does not exist|not found|no longer available|is unavailable|is not available)|(?:unknown|invalid|unsupported|retired|decommissioned) model|model not supported|no model selected/i.test(text)) {
    return result("The model was not found or is no longer supported.", true);
  }
  if (/no api key|api key (?:is )?(?:missing|invalid|incorrect)|(?:invalid|incorrect) api key|authentication (?:failed|required)|unauthenticated|\b401\b/i.test(text)) {
    return result("The provider has no usable authentication for this model.", true);
  }
  if (/(?:do not|don't|does not) have access to (?:this |the )?model|model.{0,80}(?:access denied|permission denied|not authorized)|(?:access|permission) denied.{0,80}model/i.test(text)) {
    return result("The account does not have access to this model.", true);
  }
  if (/account\(s\).{0,200}are unavailable for/i.test(text)) return result("No account is available for this model.", true);
  if (/\b403\b|forbidden|access denied|permission denied/i.test(text)) return result("The provider denied access to the request.");
  return result(text.trim() ? "The provider returned an error without a recognized safe reason." : "The provider returned an error without details.");
}

export function modelIdentity(model) {
  return typeof model?.provider === "string" && model.provider && typeof model?.id === "string" && model.id
    ? { provider: model.provider, id: model.id } : undefined;
}

export function sameModel(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

/** Render model identifiers as inert text, with no Markdown/mention injection. */
export function modelLabel(model) {
  if (!model) return "unknown model";
  return `${model.provider}/${model.id}`.replace(/[\p{Cc}\p{Cf}`<>@\\]/gu, "").slice(0, 200) || "unknown model";
}

export function modelFailure(message, selectedModel) {
  return {
    ...summarizeModelFailure(message?.errorMessage),
    model: modelIdentity({ provider: message?.provider, id: message?.model }) ?? modelIdentity(selectedModel),
  };
}

export function formatModelFailure(failure) {
  return `${failure.unavailable ? "Model unavailable" : "Model error"} (\`${modelLabel(failure.model)}\`): ${failure.reason}`;
}
