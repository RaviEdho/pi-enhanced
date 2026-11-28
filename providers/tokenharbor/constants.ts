export const PROVIDER_ID = "tokenharbor";
export const PROVIDER_NAME = "Token Harbor";
export const TOKENHARBOR_ORIGIN = "https://tokenharbor.ai";
export const TOKENHARBOR_BASE_URL = `${TOKENHARBOR_ORIGIN}/v1`;
export const MODELS_URL = `${TOKENHARBOR_BASE_URL}/models`;
export const ALLOWANCE_URL = `${TOKENHARBOR_ORIGIN}/api/cli/free-tier`;
export const ALLOWANCE_TTL_MS = 60_000;
export const USAGE_URL = `${TOKENHARBOR_ORIGIN}/dashboard/usage`;
export const REQUEST_TIMEOUT_MS = 15_000;
// Per-request verification budget: the shared allowance lookup may be cached for
// ALLOWANCE_TTL_MS, and the parallel catalog read can take up to REQUEST_TIMEOUT_MS.
// The request gate must tolerate the sum plus scheduling/abort-propagation jitter,
// or the tail of every cache window can expire before the request without the
// coverage ever being re-read.
export const VERIFICATION_TTL_MS = ALLOWANCE_TTL_MS + REQUEST_TIMEOUT_MS + 5_000;
export const CATALOG_TTL_MS = 30 * 60_000;
export const METADATA_TTL_MS = 24 * 60 * 60_000;
