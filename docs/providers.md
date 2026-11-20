# Provider guide

[← pi-enhanced](../README.md)

## Sign in

```bash
# In an interactive Pi session:
/login google-antigravity

# Or login to Command Code (choose account or API key):
/login commandcode

# Or login to Kenari:
/login kenari

# Or log in to Token Harbor with a Universal Key:
/login tokenharbor

# Or log in to Ollama Cloud:
/login ollama-cloud
```

Credentials and tokens are stored in `~/.pi/agent/auth.json` and refreshed automatically where supported. You can also export `COMMANDCODE_API_KEY="sk-cmd-..."`, `KENARI_API_KEY="kn-..."`, `TOKENHARBOR_API_KEY`, or `OLLAMA_API_KEY` directly.

## Run a model

```bash
# Interactive mode with Command Code
pi --model commandcode/claude-sonnet-5-5
pi --model commandcode/deepseek/deepseek-v4.1-flash
pi --model commandcode/google/gemini-3.7-flash

# Interactive mode with Kenari (no subscription or balance needed)
pi --model kenari/kenari-free

# If your account has access to the paid model
pi --model kenari/claude-haiku-5-5

# Token Harbor: use the exact ID discovered for your key
pi --model tokenharbor/deepseek-v4.1-flash:free

# Interactive mode with default Antigravity model
pi --model google-antigravity/gemini-3.1-pro

# Using Claude Sonnet 4.6
pi --model google-antigravity/claude-sonnet-4-6

# Non-interactive query
pi --model google-antigravity/gemini-2.5-flash -p "Summarize git status"
```

## OpenCode Go (native Pi provider)

- Use `/login opencode-go` once per key to build a failover pool. Existing Pi logins are imported; `OPENCODE_API_KEY` remains a single-key fallback and is not copied to disk. Use `/logout opencode-go` to remove one saved key or all saved keys. Keys may share the same allowance.
- Pi still owns the model catalog, streaming, tools, reasoning, and `x-opencode-session` header. Sessions prefer the key they last used and can retry another saved key on recognized rate-limit errors before output starts. Billing, access, and policy-budget errors do not trigger rotation. Custom proxy endpoints are not pooled.
- `/usage` and the quota footer show the 5-hour, weekly, and monthly included allowances from `GET /zen/go/v1/usage`. The 5-hour window starts with use, the weekly window resets Monday at 00:00 UTC, and the monthly window resets at renewal. An idle or rounded-zero 5-hour reading has no countdown. The response does not identify the plan, account, or credit balance; quota lookup never blocks inference or changes Extra Usage settings.
- Sources checked November 17, 2026: [Go documentation](https://opencode.ai/docs/console/go/), [API key documentation](https://opencode.ai/docs/console/api/), and [upstream usage route](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts). The live route returned `401` without a key; authenticated usage has not been verified live.

## Ollama Cloud Provider

- Sign in with `/login ollama-cloud` or set `OLLAMA_API_KEY`. Discover cloud models and their tool, vision, thinking and context metadata dynamically.
- On login, the account plan and purchased balance are checked. Free accounts without purchased credits hide models observed to be restricted in a Free-account probe; paid plans or accounts with purchased credits retain the full catalog. Unknown access is not hidden. The snapshot is an observation, not an Ollama entitlement guarantee.
- `/usage` and the quota footer show included and purchased balances or legacy limits when reported. Model prices are estimates parsed from Ollama's pricing page; unknown rates use Pi's required numeric zero placeholders and are labeled unknown or incomplete. Output limits are estimates. Actual billing can differ, including off-peak rates.
- Ollama's catalog is public and is not known to filter by account entitlement. Native model-specific thinking controls are not currently mapped to Pi's effort slider.

## InferHub Marketplace Provider (experimental)

- Sign in with `/login inferhub` using an **inference-only** key, or set `INFERHUB_API_KEY`. Only consumer inference endpoints are called; management access, publisher credentials, and MCP are not required. The selected key is used without automatic key rotation.
- Authenticated `/v1/models` discovery supplies explicit text-output routes, context/output limits, image-input support, and exact reasoning tiers. Aliases, combos, non-text outputs, and routes with incomplete limits/modalities are omitted. There is no hardcoded catalog. Every online discovery refresh fetches a new upstream catalog, even when the cached snapshot is fresh; offline startup and temporary failures use the last successful key-scoped snapshot. Discovery authorization failures clear that key's snapshot. Open `/model` to refresh after first configuring a key.
- Uses Pi's OpenAI Chat Completions streaming implementation for text, tools, reasoning output, and cancellation. `X-Session-Id` preserves conversation routing; reasoning uses strict per-route tiers. Pi's `off` sends `none` only when explicitly supported; otherwise no disable claim is made. Raw API calls without an effort leave the upstream default unchanged.
- Local costs use the server's final streaming `usage.cost` total, **zero when missing**; input/output/cache cost splits remain zero because they are not supplied. These are not ask-price estimates, and zero does not imply free inference. Actual cost availability, tools, and protocol compatibility still need authenticated live verification. Set price caps/budgets in InferHub's dashboard: cheapest asks are not guaranteed execution prices and paid calls have a $0.00001 minimum. The extension never changes billing settings.
- `/usage` and the footer share a read-only `/v1/me/usage` balance lookup, cached for a minute. Balance is a named USDC value, not a quota bar or reset allowance. Known-zero balance is shown in `/usage` and hidden in the footer. Failed refreshes retain successful data; `/usage` shows the error and stale age. Keys are identified by masked credentials, not inferred account identities or subscription tiers.
- InferHub pools publisher-connected subscriptions/API accounts. Upstream resale authorization, model provenance, and upstream data handling are not independently verified. Some routes modify system prompts. Its privacy policy allows retention of flagged request text and security-rejected request scaffolding; use caution with sensitive code. No uptime or supply guarantee is assumed.
- Sources audited November 15, 2026: [integration guide](https://inferhub.dev/docs), [API/OpenAPI](https://inferhub.dev/api/openapi.json), [pricing](https://inferhub.dev/pricing), [privacy](https://inferhub.dev/privacy), and [terms](https://inferhub.dev/terms). Cached catalogs record their source and fetch timestamp; no inference is generated to discover models or balances.

## Token Harbor Provider

- Sign in with `/login tokenharbor` using a Universal Key, or set `TOKENHARBOR_API_KEY`. Pi saves the key once `/v1/models` accepts it, then refreshes the model catalog in the background. On first login, new models appear in `/model` after verification. Repeated logins add credentials to the multi-account pool; `/logout` uses the native-style account selector.
- Credential-scoped `/v1/models` discovery is enriched from each exact model's public specification page. Models without verified chat/tool support, a context window, text input, or input/output prices are omitted. A missing maximum output limit is marked unknown; Pi leaves the cap to the gateway unless the caller supplies one. Cache-read and cache-write prices are optional: unknown rates use 0 for Pi's cost estimates and are flagged as unknown in model metadata, not verified free. Every fresh API listing rebuilds the catalog, reconsidering skipped models and new IDs even within the 30-minute discovery cache window. Calls without a fresh listing may reuse that cache; public metadata remains cached for 24 hours. Offline startup uses the last successful credential-scoped snapshot.
- Native OpenAI streaming preserves tools, reasoning output, images, cancellation, and token usage. The documented `reasoning.efforts` controls Pi's available efforts; `off` is offered only when `can_disable: true`. Unknown (`null`) and checked-none (`[]`/`false`) stay distinct; neither invents controls. `default_effort` is retained as metadata, not guessed or forced. Omitting an effort leaves the gateway's default; model names and accepted-but-ignored parameters are not capability evidence.
- Strict Pass filtering uses the account's verified active `plan_name` and each exact ID's `covered_by_plans`. Only paid models covered by that Pass and explicit `:free` routes appear; unknown coverage, another Pass's models, and wallet-only models are hidden. Without a verified active Pass, only free routes remain. Wallet balances never expand access. Select explicit `:free` IDs for free routes: their coverage is correctly `[]` because they use a separate allowance. Enabling free-route data sharing remains a dashboard action; free-route content may be retained and used under the provider's terms.
- `/usage` and the footer read live allowances through `GET /api/cli/free-tier` using the Universal Key. They show the verified Pass name, separate Pass/free percentages, and their shared seven-day reset window. Activated windows show elapsed markers even at zero usage; inactive windows have no invented timing. Exhaustion flags remain distinct from rounded percentages. Polling is shared per credential at most once a minute; failed refreshes retain the last successful report with an error and age in `/usage`. No browser credentials or inference calls are needed.
- Coverage is kept only in short-lived, credential-scoped memory, not persisted as entitlement. Each paid request re-reads `/v1/models` and checks an active, non-exhausted Pass using allowance data cached for at most one minute; failures block paid calls. Before live Pass verification (including offline startup and cache-only `--list-models`), only verified cached free routes are listed. Open `/model` to refresh the live catalog; paid requests also verify access before sending. Discovery uses the bulk listing rather than individual model detail requests. The allowance response's separate model list is also not used for routing.
- Wallet balance and the wallet-continuation setting remain unavailable. Client checks are not atomic billing guarantees: disable wallet continuation in the dashboard if required. No billing settings, model substitutions, or wallet fallback are enabled. Quota-pace balancing remains neutral; account selection respects verified model coverage, and conservative pre-content 429 failover never bypasses detected spending caps, billing, quota, or access errors.
- Displayed costs are list-price estimates, not settled Pass/wallet charges; discounts and boosts can differ. Known complete long-context price tiers are applied when reported. MiMo V2.6 Flash exceeded small output caps in live probes; do not rely on such caps as a financial safeguard.
- Sources audited November 8, 2026: [catalog/API](https://tokenharbor.ai/docs/api/models), [Pass rules](https://tokenharbor.ai/docs/billing/subscription), [key restrictions](https://tokenharbor.ai/docs/getting-started/universal-key), and [privacy](https://tokenharbor.ai/privacy). The [read-only allowance API](https://tokenharbor.ai/docs/api/allowance) was verified November 9, 2026; the catalog's reasoning and Pass-coverage contracts were verified November 11, 2026. Free-route detail/list parity, zero pricing, and both literal and encoded colon forms were verified November 12, 2026. Each cached model also records its exact public specification URL and verification timestamp.

## Kenari AI Gateway Provider

- Direct connection to Kenari (`https://kenari.id/v1`) with access to 110+ open and closed frontier models in Rupiah.
- Dual authentication: Choose browser loopback PKCE sign-in or API-key login via `/login kenari`, or set `KENARI_API_KEY`.
- Dynamic live model discovery ([`/v1/models`](https://kenari.id/v1/models) and [`/api/public/pricing`](https://kenari.id/api/public/pricing)) with live micro-IDR token pricing converted to USD, context length limits, tool calling, and discrete reasoning effort controls.
- Free-tier keys need no subscription or top-up. Select `kenari/kenari-free` or choose a current `:free` model from `/model`. Free requests have daily and per-minute limits; paid models require plan or coupon coverage, or prepaid balance. See Kenari’s [model catalog](https://kenari.id/docs/models.md), [billing](https://kenari.id/docs/billing.md), and [plan quota](https://kenari.id/docs/langganan.md) docs (checked November 18, 2026).
- Multi-account pooling with transparent 429 rate limit failover (`plan_limit_reached`, `free_quota_daily`, `free_quota_rpm`) and 402 balance backoff (`insufficient_balance`).
- Live rolling window quota (5-hour, weekly, monthly) and prepaid balance monitoring via `/usage` and interactive status footer.

## Command Code Provider

- Direct connection to Command Code's Provider API (`https://api.commandcode.ai/provider/v1`) with access to 80+ open & closed frontier models.
- Dual authentication: Native Pi login supports account OAuth and interactive API-key sign-in; `COMMANDCODE_API_KEY` is also supported.
- Dynamic live model discovery (`/provider/v1/models`) with dual-protocol routing (Anthropic Messages API for Claude Sonnet/Opus/Haiku, and OpenAI Completions API for DeepSeek V4/4.1, Gemini, GPT-6/5, Qwen, Kimi, GLM, MiniMax, etc.).
- Subscription plan gating (Go, GOAT, Pro, Max) and automatic credit bypass rules when on-demand credits exist. Go and free/no-subscription accounts route through Command Code's internal CLI gateway (`/alpha/generate`); free accounts are limited to the zero-cost catalog models and need at least $1 of credits to start a session.
- Multi-account pooling with transparent 429 rate limit failover.
- Live quota, monthly pool, and 5-hour/weekly burst window tracking via `/usage` and interactive footer status bar.

## Google Antigravity

- **OAuth 2.0 Integration**: Authenticate via `/login google-antigravity` using Google OAuth (browser callback on port 51121 with manual prompt fallback for remote/headless setups).
- **Automated Cloud Code Assist Project Discovery**: Automatically detects or provisions the Antigravity free tier (`cloudaicompanionProject`) via Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`).
- **Full Model Support**:
  - `gemini-3.1-pro` (Default)
  - `gemini-3-pro`
  - `gemini-3.5-flash`
  - `gemini-2.5-flash`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6`
  - `claude-sonnet-4-5`
  - `claude-opus-4-5`
  - `gpt-oss-120b`
- **Tool Calling**: Full support for tool calling with schema normalization for Claude models.
- **Thinking & Reasoning Support**: Discrete effort-tier routing and thinking budget configuration.

## OpenAI Codex

Automatically discovers newly available models from OpenAI's live Codex catalog, including their context windows, input modalities, and reasoning levels, without waiting for Pi's bundled catalog to update. Detects your ChatGPT plan tier from your OAuth token and filters unavailable or hidden models from `/model` and `pi --list-models`, with cached discovery for offline startup.

## Accounts and failover

- **Multi-Account Support & Auto-Failover**: Pool multiple accounts per provider (Google Antigravity, OpenAI Codex, Command Code, Kenari, Token Harbor). Where verified plan and quota data exist, prefer the highest healthy tier eligible for the requested model; lower tiers are fallback-only, and selection returns to higher tiers when they recover. Session affinity and weekly reset-pace balancing apply within the preferred tier, with automatic OAuth token refresh and transparent failover on 429 / quota exhaustion. ChatGPT priority: Enterprise > Business/Team > Pro > Plus > Go > Free. Unknown tiers and PAYG accounts remain fallback candidates. Pi's native OpenAI provider is not managed by this extension; existing OpenAI credentials are left intact.
- **Provider Quotas with Reset Pace Markers**: Live multi-account quota monitoring via `/usage` showing usage percentage, plan tier, reset countdowns, and real-time reset progress markers (`┃`) on the usage bar.
- **Pi Auth Sync**: Automatically imports credentials from `~/.pi/agent/auth.json` into the accounts pool and syncs the active healthy account back to `auth.json`.

## Check quotas and balances

Run `/usage` to view live quotas, progress bars, and reset times across all accounts. Accounts stack vertically within each provider. In the TUI, providers fill each column top-to-bottom before flowing into the next column when the dialog body is full. Provider blocks stay together; oversized blocks and overflow beyond the available columns remain vertically scrollable. Narrow terminals and plain-text output use a single column:

```bash
# In interactive Pi session:
/usage

# Or from terminal:
pi -p "/usage"
```

## Retired integrations

- **Cloudflare Workers AI**: Extension-specific model filtering and usage reporting have been retired. Pi's native provider and existing credentials are unaffected.

Charm Hyper has been removed because its usage, quota, and reset data cannot be fetched reliably enough to meet this package's provider requirements. On the next extension load, saved Hyper credentials, pooled accounts, session bindings, and model/quota caches are automatically deleted; other providers and conversation history are preserved. `HYPER_API_KEY` is no longer used—remove it from your shell configuration if set. Select another provider if your default model used Hyper.
