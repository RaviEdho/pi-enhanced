/** Verified 2026-11-15: https://inferhub.dev/docs and https://inferhub.dev/api/openapi.json */
export const PROVIDER_ID = "inferhub";
export const PROVIDER_NAME = "InferHub";
export const BASE_URL = "https://api.inferhub.dev/v1";
export const MODELS_URL = `${BASE_URL}/models`;
export const USAGE_URL = `${BASE_URL}/me/usage?window=day&session=0`;
export const REQUEST_TIMEOUT_MS = 15_000;
export const USAGE_TTL_MS = 60_000;
