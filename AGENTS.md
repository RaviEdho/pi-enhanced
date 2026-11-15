# AGENTS.md

Guidance for AI agents working in this repository.

## Repository Overview

`pi-enhanced` is an installable extension suite for the [Pi](https://github.com/earendil-works/pi) coding agent, bundling providers, multi-account management, tools, and workflow enhancements.

### Main subsystems

- **Accounts (`accounts/`)**: `accounts.json` storage, `auth.json` sync, session affinity, token refresh, quota pace balancing, and transparent streaming 429 failover.
- **Providers (`providers/`)**:
  - **Antigravity**: Google Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`), OAuth, and automatic project discovery/onboarding (`cloudaicompanionProject`).
  - **Command Code**: `https://api.commandcode.ai/provider/v1`, loopback OAuth (`/login commandcode`) or `COMMANDCODE_API_KEY`, dynamic models, Anthropic/OpenAI protocol routing, plan gating/credit bypass, and quota monitoring (`/alpha/billing/credits`).
  - **Kenari**: `https://kenari.id/v1`, loopback OAuth PKCE (`/login kenari`) or `KENARI_API_KEY`, dynamic models/pricing, plan gating (`/api/plans`), prepaid IDR bypass/balance (`/v1/account/balance`), reasoning translation, multi-account failover, and quotas (`/v1/account/quota`).
  - **InferHub**: Experimental consumer-only marketplace integration (`https://api.inferhub.dev/v1`), `/login inferhub` or `INFERHUB_API_KEY`, authenticated key-scoped discovery/cache, explicit text routes, strict reasoning tiers, server-reported total costs, and read-only USDC balance reporting. No management access or automatic credential rotation.
  - **Codex**: Account model discovery and usage reporting; the managed OpenAI ChatGPT provider was retired.
  - **Ollama**: Model discovery and integration.
- **Usage and context (`ux/usage/`, `ux/context/`)**: Multi-account `/usage` reports and quota footer; native `/context` modal with category breakdown, headroom/compaction thresholds, and `c` compact / `r` refresh / `Esc` close.
- **Git assistant (`tools/git/`)**: Isolated in-memory `/git` and `/commit` agents for atomic commits, PRs, branches, conflicts, and release drafts without adding their working context to the conversation.
- **Plan mode (`ux/plan/`)**: Read-only exploration via `/plan`, `/implement`, `--plan`, `Ctrl+Alt+P`, and `Alt+M`; tool-call sandbox, approval gate, mode footer, and reasoning-effort border colors. Keep tool schemas byte-stable across modes for prompt caching; block writes and mutating shell commands while allowing inspection tools and safe bash.
- **Settings and telemetry (`ux/settings/`, `ux/timer/`, `ux/continue/`)**: Native `/settings-enhanced` modal and `get|set|list|reset`, persisted in `~/.pi/agent/enhanced-settings.json`; toggles for tools, footer, telemetry, continuation, failover, balancing, and subagents. Warn before disabling tools mid-session at ≥10k context tokens. A literal `.` triggers invisible continuation without a user bubble.
- **Compressor (`tools/compressor/`)**: In-process bash/PowerShell output compression for test, git, lint, log, and progress noise; `/recall` retains full output and `/gain` reports savings.
- **Scout (`tools/scout/`)**: Pure-TypeScript fuzzy `find` and definition-first `grep`, multi-pattern OR matching, shell-search interception, git-aware indexing, and strict match-centered output budgets.
- **Web (`tools/web/`)**: `web_search` / `web_fetch` with priority routing and failover across Brave, Tavily, Antigravity Grounding, TinyFish, Exa, and Parallel; search operators, Markdown extraction, SPA/anti-bot handling, lenient constraints, canonical redirects, and `/login` / `/logout` key management.
- **Subagents (`tools/subagent/`)**: In-memory sessions inheriting the parent's model/thinking, focused prompts, turn/time limits, context budgets, enhanced tools, escalation, and coordinated follow-ups. Background by default; sync via `background: false` or `/subagent --sync`. Manage with `/jobs`, `subagent_list`, `subagent_status`, and `subagent_cancel`.
- **Feedback (`tools/feedback/`)**: Native `ask_user` freeform input, three-choice selectors with custom answers, and sequential questionnaires; supports dismissal, non-interactive environments, signals/timeouts, and plan mode.
- **Discord (`gateway/`)**: Detached bot with `/discord setup|configure|start|stop|teardown|status|logs` and menu; allowlisted DM/server routes, mention threads, per-channel or per-thread conversations, model-decided reply routing with deterministic escalation, bounded automatic recent-message context, full-tool Pi CLI sessions, shared thread history, isolated DM/user sessions, author identity, and participant-scoped approvals.

### Directory map

This map is a starting point, not an exhaustive or guaranteed-current inventory. Inspect the code for current files and responsibilities.

```text
index.ts                     Root extension entry point
accounts/                    Store, balancer, quota sync, logout, retired-provider cleanup, failover wrapper
providers/                   Registration plus antigravity/, codex/, commandcode/, kenari/, ollama/
  oauth-page.ts              Shared OAuth response pages
  <provider>/                Discovery/catalog, auth, plan rules, streaming, constants, types as applicable
gateway/                     Discord commands/dialogs, storage, workspace handoff tool
  daemon.mjs, runtime/       Detached entry point and routing/session/RPC/lifecycle modules
tools/
  git/                       Runners, inspection/proposal tools, prompts, dialogs, git helpers
  compressor/                Pipeline, parsers/, rules, sanitizer, recall, savings tracker
  scout/                     Indexer, matcher, classifier, external search, formatter, interceptor, cursors
  web/                       Search providers/, fetch/, pipelines, auth/login, query, formatter, tools
  subagent/                  Runner, background jobs, sync loader, lifecycle tools
  feedback/                  ask_user schemas, execution, and renderers
ux/
  context/                   Analyzer, command, viewer component, formatter
  continue/                  Dot-input handler and continuation directive
  plan/                      Manager, sandbox (safe-bash.ts), approval gate, editor, prompts
  settings/                  Persistent store, definitions, command, native SettingsList component
  timer/                     Live working status and settled-turn telemetry
  usage/                     Provider scrapers, shared semantics, report formatting, footer
package.json, tsconfig.json Pi manifest/dependencies and NodeNext configuration
README.md                    User documentation
```

## Security and Workspace Safety

- Never expose API keys, OAuth tokens, or other secrets in logs, tool output, examples, or commits. Use redacted values; abbreviated credential identifiers below are permitted only for identification.
- Do not modify real user credentials or configuration without approval. Verify with isolated temporary configuration and remove it afterward.
- Inspect working-tree status before editing. Preserve unrelated changes, including staged work; do not reset, overwrite, or commit them.
- Every Git commit requires explicit user approval for that commit. A change request or earlier approval is not authorization.

## Development Rules

### Package structure and TypeScript

- Keep `index.ts` at the repository root; do not add redundant nesting such as `pi-enhanced/pi-enhanced/`. The manifest must declare `"pi": { "extensions": ["./index.ts"] }`.
- Use NodeNext module resolution. **All relative TypeScript imports must use `.js` extensions**, e.g. `import { foo } from "./bar.js";`.
- Host-provided packages `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@earendil-works/pi-agent-core` belong in `peerDependencies` with `"*"` and in `devDependencies`, **never** `dependencies` (avoids duplicate packages during `pi install`).
- Run `npm run typecheck` after code changes, whether or not a commit is requested. See documentation-only checks below.

### Dynamic model discovery

- Discover models dynamically whenever possible. If usable discovery is unavailable, disclose the limitation and obtain approval **before** implementing a fallback in the provider's `catalog.json`. Temporary failures must follow the approved cache/fallback policy.
- Use verified sources and record their URLs and verification dates. Never invent availability, entitlements, pricing, or capabilities.
- Discovery sources:
  - Antigravity: Google's `fetchAvailableModels` endpoint.
  - Command Code: `https://api.commandcode.ai/provider/v1/models`.
  - Kenari: `https://kenari.id/v1/models` and `https://kenari.id/api/public/pricing`.
  - Codex: its documented catalog and verified entitlement data; never invent plan access.

### New provider / endpoint integrations

**Mandatory pre-flight:** Audit provider documentation and API completeness before writing integration code. Present the audit, disclose gaps/limitations and proposed mitigations, and obtain user confirmation before implementation. Never fabricate capabilities, prices, plan identities, entitlements, quotas, reset intervals, or reset mechanics.

The following standards are **recommended, not prerequisites** for adding a provider:

1. **Dynamic catalog, pricing, and reasoning:** Prefer credential-aware discovery filtered to the account's subscription, with per-token input/output/cache-read/cache-write prices and supported reasoning efforts (e.g. `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing metadata is unknown, not assumed; follow the discovery/fallback rules above.
2. **Programmatic plan identification:** Prefer account/subscription/billing endpoints, decoded OAuth claims (e.g. `chatgpt_plan_type`, `tier`, plan IDs), or usage payloads identifying the plan/product. Without reliable identification, do not infer tier, entitlements, quota windows, or countdowns; use independently documented account/quota data where available and otherwise report unknown.
3. **Parseable usage and resets:** Prefer APIs exposing usage or remaining quota and reset timings for `/usage` and the footer. Verify whether resets are **global/bulk** (fixed-schedule replenishment, such as daily UTC or billing boundaries) or **rolling** (older usage continuously ages out of a sliding window). Display only verified values and timing when data is incomplete.

Audit checklist:

- **Inference:** OpenAI/Anthropic compatibility, SSE, tool calling, reasoning translation, structured outputs, embeddings.
- **Catalog:** Dynamic active models, pricing, and account entitlements.
- **Usage/cost:** Inline token/cost fields, balances, settled exports, `/usage` readiness.
- **Limits/errors:** 429 semantics, rate-limit headers, daily caps, retry-after, failover.
- **Auth/lifecycle:** API keys, OAuth, provisioning versus inference permissions, multi-account support.
- **Gaps:** Missing endpoints (e.g. token counting/webhooks), parameter quirks, platform constraints.

### Native UI and minimal host changes

- Match Pi's native interaction model, styling, and keyboard conventions.
- Do not add synthetic `[ Cancel ]`, `[ Back ]`, or `← Back` selector options; native `Esc` handles dismissal.
- Use `→ ` selection arrows with `theme.cursor`, including custom modals; never substitute `>` or `*`. Keep choice labels clean, without competing leading glyphs/icons (`*`, `▶`, `■`, emojis). Use suffixes such as `(current)` or `(active)`.
- Prefer targeted hooks, lightweight lifecycle events, or native `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.notify` over replacing core editors or recreating host dialogs.
- Multi-account flows such as `/logout` should resemble native sub-selectors with clean identities and `(active)` labels, not custom dashboards.

## Shared Usage and Quota Conventions

### Data and identity

- `/usage` and the footer share the report repository, identity resolution, and bucket semantics; presentation may differ. Never persist session-specific display state in shared reports.
- Retain the last successful report after refresh failure. `/usage` must show the error, mark stale data, and show its age; the footer may retain the successful report.
- Prefer a verified account name or user-provided label, then a verified account ID. Otherwise identify credentials using the first 7 characters, `...`, and last 4; use `key` for keys ≤12 characters. Never show a full credential or treat abbreviated keys as proof of shared account identity.
- Sort known-duration windows longest to shortest using reported durations or canonical labels. Put unknown-duration buckets and value-only balances afterward, preserving their relative provider order. Ordering labels must not create reset timing or marker intervals.
- Show elapsed markers and reset countdowns only with valid, known timing data. Never invent quota values or reset behavior.
- Render balances/credits as named values, not bars: show the amount without suffixes such as `available` or `on-demand (never expires)`, without changing underlying data. Unknown balances are not zero.
- Shared semantics live in `ux/usage/buckets.ts`, `identity.ts`, `timing.ts`, and `windows.ts`; presentation belongs in `format.ts` and `footer.ts`.

### Footer

- Keep the active account's quota compact and right-aligned on line two, after session statistics. Preserve the native two-line layout and truncate gracefully on narrow terminals.
- Longest window: `<window> [<10-character bar>] <used%> (<reset countdown>)`. Use `█` consumed, `░` unused, and `┃` elapsed time when known. Percentages are **used**, not remaining.
- Use compact labels (`5h`, `1d`, `wk`, `mo`). Append shorter nonzero-usage windows in descending order as ` · <window>: <used%> (<reset countdown>)`; highlight secondary windows at 80% and 95% used.
- Use verified compact countdowns (`2d14h`, `3h05m`, `12m`). Hide known-zero balances; show loading, cooldown, or unavailable states when appropriate.

### `/usage`

- Group by provider → account → bucket. Show the active session model/account when available; mark the active account `●` and `[in use]`, others `○`. Lowercase displayed tiers without altering stored identities.
- Use descriptive labels (`5-Hour`, `Daily`, `Weekly`, `Monthly`) while retaining meaningful provider-specific names. Bars show **remaining** percentage to one decimal; `┃` requires known elapsed-window timing.
- Show verified countdowns or `ready` where appropriate, known-zero balances as named values, and errors/unavailable reasons within the affected account section.
- Adapt to terminal dimensions; keep each provider's accounts together in multi-column layouts.

## Verification

- **No persistent test files:** Do not write, commit, or persist `*.test.ts`, `*.spec.ts`, `tests/`, or `__tests__/`. Use transient headless runs, interactive checks, or temporary inline scripts; clean up ephemeral scripts before finishing.
- **Code changes:** Run type checking and relevant transient behavior checks before finishing.
- **Documentation-only changes:** Review the diff and run `git diff --check -- AGENTS.md` (substitute affected paths).
- Summarize checks, failures, and skipped checks with reasons. Inference checks may incur usage. `pi install .` changes the environment and requires approval.

```bash
npm run typecheck

# Select an available, authenticated model before inference checks
pi --list-models
pi -e ./index.ts --model '<available-provider/model>' -p "say hello"

# Headless slash-command checks
pi -e ./index.ts -p "/settings-enhanced list"
pi -e ./index.ts -p "/usage"
```

## Distribution

Distributed directly via GitHub: `pi install git:github.com/RaviEdho/pi-enhanced`.

There is no npm packaging, version-bump, or GitHub release pipeline. Do not run `npm version` or create releases; `package.json`'s version is informational. Shipping means merging to the default branch; users receive changes on their next install/update.
