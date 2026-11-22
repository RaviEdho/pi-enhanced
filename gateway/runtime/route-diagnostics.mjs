import { log } from "./logging.mjs";

const EXCERPT_LIMITS = { currentMessagePreviews: 500, directReply: 800, recentMessages: 1_000 };
const REDACTED = "[redacted]";

function redactContext(text, botToken) {
  if (botToken) text = text.replaceAll(botToken, REDACTED);
  return text
    // Quotes and previews can contain escaped newlines. If a key block starts,
    // drop through the end marker or end of the field when it was already cut.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, REDACTED)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi, "[link redacted]")
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|bot[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|authorization|(?:set[-_ ]?)?cookie|password|passwd|secret|token)["'`\\]*\s*[:=][^\r\n]*/gi, REDACTED)
    .replace(/\b(bearer|basic|bot)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_|thk_live_|AIza|AKIA|ASIA|eyJ)[\w.-]+/g, REDACTED)
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, REDACTED)
    // Opaque credentials also appear without labels or recognizable prefixes.
    .replace(/\b(?=[A-Za-z0-9_+/-]{24})(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]{24,}={0,2}/g, REDACTED)
    .replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "");
}

function excerptFor(name, text, originalChars, botToken) {
  const routerTruncated = originalChars > text.length;
  const keepTail = name === "recentMessages";
  let safe = redactContext(text, botToken);
  if (routerTruncated) {
    // Don't log a partial message along the router's cut edge: its credential
    // label or prefix may have been removed by the prompt budget.
    const cut = keepTail ? safe.indexOf("\n") : safe.lastIndexOf("\n");
    safe = cut < 0 ? "" : keepTail ? safe.slice(cut + 1) : safe.slice(0, cut);
  }
  safe = safe.trim();
  const limit = EXCERPT_LIMITS[name];
  return {
    availableChars: originalChars,
    sentChars: text.length,
    routerTruncated,
    excerptTruncated: routerTruncated || safe.length > limit,
    ...(safe ? { excerpt: keepTail ? safe.slice(-limit) : safe.slice(0, limit) } : {}),
  };
}

const snowflake = (id) => typeof id === "string" && /^\d{17,20}$/.test(id) ? id : undefined;

export function logRouteContext({ input, botToken, messageId, channelId, replyToMessageId, contextMessages, isReply, imageCount, model, outcome, latencyMs }) {
  const context = Object.fromEntries(Object.entries(input.quotedContext).map(([name, text]) => [
    name, excerptFor(name, text, input.contextLengths[name], botToken),
  ]));
  log(`Discord reply routing context: ${JSON.stringify({
    messageId: snowflake(messageId), channelId: snowflake(channelId), replyToMessageId: snowflake(replyToMessageId),
    isReply: Boolean(isReply), imageCount, contextMessages, messageChars: input.message.length,
    model, outcome, latencyMs, context,
  })}`);
}
