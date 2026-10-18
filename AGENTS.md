# AGENTS.md

Guidance and instructions for AI agents working in this repository.

## Repository Overview

`pi-enhanced` is an enhanced extension suite for the [Pi](https://github.com/earendil-works/pi) coding agent. It bundles custom providers, tools, quota monitors, and model filtering logic into an installable Pi package.

### Key Capabilities
- **Multi-Account Manager & Balancer (`accounts/`)**: Multi-account store (`accounts.json`), session affinity hashing, weekly reset pace optimization, automatic sync from Pi (`auth.json`), automatic token refresh, and transparent 429 rate limit failover across accounts during streaming turns.
- **Google Antigravity Provider (`providers/antigravity/`)**: Custom provider integrating with Google Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`) using OAuth 2.0 with automatic project discovery / onboarding (`cloudaicompanionProject`).
- **Charm Hyper Provider (`providers/hyper/`)**: Custom provider connecting to Charm Hyper (`https://hyper.charm.land/v1`) with device code OAuth flow (`/login hyper`), API key authentication (`HYPER_API_KEY`), live dynamic model discovery (`/v1/provider`), reasoning effort level translation, and multi-account load balancing.
- **Command Code Provider (`providers/commandcode/`)**: Custom provider connecting to Command Code (`https://api.commandcode.ai/provider/v1`) with browser loopback OAuth flow (`/login commandcode`), API key authentication (`COMMANDCODE_API_KEY`), live dynamic model discovery (`/provider/v1/models` across 89 models), dual Anthropic Messages & OpenAI Completions protocol routing, subscription plan gating & credit bypass model projection, and rolling window quota monitoring (`/alpha/billing/credits`).
- **OpenAI & ChatGPT Subscription Balancer (`providers/codex/`)**: Dynamic tier detection from OAuth token JWT claims (`chatgpt_plan_type`). Unifies both ChatGPT login flows—the official Responses API (`/login openai` -> Sign in with ChatGPT) and the legacy Codex backend (`/login openai-codex`)—with multi-account failover, auto-switching, plan-based model filtering, quota scraping, and rate limit resilience.
- **Provider Quota & Usage Monitor (`ux/usage/`)**: Live multi-account quota tracking, percentage consumption bars, and reset countdowns across configured providers via the `/usage` command and status footer.
- **Context Window Usage & Breakdown (`ux/context/`)**: Interactive `/context` slash command and clean single-screen TUI modal featuring native Pi styling conventions, a compact horizontal usage progress bar, available headroom with auto-compaction thresholds, concise category breakdown (`System`, `Messages` with user/assistant/thinking details, `Tools` with call counts and top tools, `Compacted`), and one-key compaction (`c`), refresh (`r`), and close (`esc`).
- **Autonomous Git Assistant (`/git`, `/commit`)**: Lightweight, autonomous `/commit` and `/git` slash commands that spin up an isolated in-memory sub-agent with specialized git inspection tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`, `git_branch_overview`, `propose_pr`), intelligent single vs. multi-stage atomic commit planning, PR drafting, branch recommendations, merge conflict resolution, release drafting, and zero conversation context bloat.
- **Continue Shortcut (`ux/continue/`)**: Seamless, invisible continuation turn triggered by sending `.` (literal dot only). Injects a directive instructing the model to resume unfinished work without pausing or summarizing, while completely suppressing any user message bubble from appearing in the chat transcript.
- **Safe Plan Mode & Implement Mode (`ux/plan/`, `/plan`, `/implement`)**: Read-only exploration and architecture design mode inspired by Claude Code and Codex CLI. Preserves byte-stable tool schemas across modes for 100% prefix prompt cache hit rates. Enforces a strict read-only sandbox via `tool_call` interception that blocks `edit`, `write`, and mutating shell commands while keeping inspection tools (`read`, `find`, `grep`, `web_search`, `web_fetch`, `ask_user`, safe `bash`) active. Features instant keyboard toggle (`Ctrl+Alt+P` and `Alt+M`), `/plan [prompt]`, `/implement [prompt]`, `--plan` CLI startup flag, footer mode indicator (`■ plan` / `▶ implement`), dynamic reasoning-effort border coloring, and an interactive human-in-the-loop approval gate upon plan formulation.
- **Enhanced Settings Manager (`ux/settings/`, `/settings-enhanced`)**: Interactive configuration modal powered by Pi's native `SettingsList` component, with persistent storage (`~/.pi/agent/enhanced-settings.json`), headless CLI commands (`get`, `set`, `list`, `reset`), and live toggles for compressor, scout search tools, scout interceptor, interactive ask user, quota status footer, footer context usage, turn telemetry, live working telemetry, dot continue shortcut, 429 failover, pace balancing, and subagent execution with subagent default mode. Features an intelligent prompt cache protection gate that warns before mid-session disabling of tools on contexts ≥ 10k tokens.
- **Terminal Output Compressor (`tools/compressor/`)**: In-process port of RTK (Rust Token Killer) features without requiring external binaries. Intercepts bash and PowerShell `tool_result` events, collapsing verbose terminal noise (passing tests, git push/status boilerplate, linter carets, repeated log loops, progress bars) by 60–90% before reaching LLM context. Includes an in-memory `/recall` ring buffer and a `/gain` token savings dashboard.
- **Codebase Scout Search Engine (`tools/scout/`)**: 100% pure TypeScript port of FFF concepts without native binaries or C FFI dependencies. Features typo-tolerant fuzzy path finding (`find`), definition-first content grep (`grep`) with unified single & multi-pattern OR search, transparent shell search interception and agent steering, in-memory file index with git status awareness, and strict output budgeting with match-centered truncation (`…match…`) to prevent LLM context blowup.
- **Unified Web Search & Fetch Tools (`tools/web/`)**: Multi-provider search and extraction subsystem exposing `web_search` and `web_fetch` tools. Features automatic priority routing and transparent failover across Brave Search, Tavily, Google Antigravity Grounding, TinyFish, Exa, and Parallel. Supports Google-style search operators (`site:`, `before:`, `after:`, `-exclusions`, `"quotes"`), clean Markdown extraction with anti-bot/SPA handling, lenient constraint enforcement, canonical redirect resolution, and API key management directly via `/login` and `/logout` (`/login brave`, `/login tavily`, `/login exa`, `/login parallel`, `/login tinyfish`).
- **Autonomous Isolated Subagent Routine (`tools/subagent/`, `/subagent`, `/jobs`)**: Zero-overhead in-process subagent execution powered by in-memory sessions (`SessionManager.inMemory`). Defaults to non-blocking background execution (or synchronous blocking with `background: false` / `/subagent --sync`). Automatically inherits the active model and thinking effort of the parent session, executes with focused system instructions, guardrails (max turns & timeouts), enhanced tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `web_search`, `web_fetch`, `escalate`), structured escalation back to the parent agent, context budgeting, cleanly coordinated follow-up delivery into the parent session, and full lifecycle control (`subagent_list`, `subagent_status`, `subagent_cancel`, `/jobs`).
- **Interactive User Feedback Tool (`tools/feedback/`)**: Direct, native user feedback tool exposing `ask_user`. Polymorphically supports single open-ended prompts via freeform text input (`ctx.ui.input`), structured 3-choice decision selectors (`ctx.ui.select`) with customizable response fallback (`✎ Type custom answer...`), and multi-question sequential questionnaires (`questions: [...]`) in a single tool turn. Features clean TUI renderers, mid-flow dismissal preservation, non-interactive environment resilience (`hasUI`), signal and timeout integration, and safe-execution compatibility with Plan Mode.

---

## Directory Layout

```text
pi-enhanced/
├── accounts/                   # Multi-account store, balancer, failover, quota sync
│   ├── balancer.ts             # AccountBalancer: session affinity, 429 cooldown, token refresh
│   ├── index.ts                # Account subsystem public exports
│   ├── logout.ts               # Native TUI account selector during /logout
│   ├── quota.ts                # Multi-account quota polling, health caching & pace balancing
│   ├── store.ts                # AccountStore: persistence, auth.json sync
│   ├── types.ts                # AccountCredential and store schemas
│   └── wrapper.ts              # executeWithMultiAccountFailover: stream wrapper with 429 rotation
├── providers/                  # Inference providers & dynamic model discovery
│   ├── oauth-page.ts           # Shared OAuth success/error HTML response templates (Pi-identical)
│   ├── antigravity/
│   │   ├── constants.ts        # Wire profiles, OAuth endpoints, Google client configuration
│   │   ├── index.ts            # Antigravity provider registration & streaming adapter
│   │   ├── models.ts           # Dynamic model catalog discovery & collapsing from Google
│   │   ├── oauth.ts            # OAuth 2.0 PKCE flow, loopback server, and token refresh
│   │   ├── stream.ts           # Cloud Code Assist SSE streaming client & schema transformation
│   │   └── types.ts            # Cloud Code Assist protocol schemas
│   ├── codex/
│   │   ├── catalog.ts          # Live catalog fetching from OpenAI & disk caching
│   │   ├── index.ts            # Provider wrapper with filterModels hook
│   │   ├── plan.ts             # JWT claim parsing for chatgpt_plan_type & chatgpt_account_id
│   │   └── types.ts            # Catalog & cache types
│   ├── commandcode/
│   │   ├── constants.ts        # API endpoints, wire URLs, user agent
│   │   ├── index.ts            # Command Code provider registration & multi-account failover
│   │   ├── models.ts           # Dynamic 89-model catalog discovery & protocol transformation
│   │   ├── oauth.ts            # Loopback HTTP server login flow & API key validation
│   │   ├── plan.ts             # Subscription tier gating (GOAT, Pro, Max) & credit bypass rules
│   │   ├── stream.ts           # Dynamic router between Anthropic Messages & OpenAI Completions
│   │   └── types.ts            # API protocol & billing schemas
│   ├── hyper/
│   │   ├── constants.ts        # Base URLs, API endpoints, User-Agent, timeouts
│   │   ├── index.ts            # Charm Hyper provider registration & streaming adapter
│   │   ├── models.ts           # Dynamic model catalog discovery & fallback mapping from Hyper
│   │   ├── oauth.ts            # OAuth 2.0 Device Flow login, loopback poll, and token exchange
│   │   ├── stream.ts           # Streaming client via OpenAI Chat Completions compatibility
│   │   └── types.ts            # Hyper device auth, token, and model schemas
│   └── index.ts                # registerProviders aggregator
├── tools/                      # Agent capability tools
│   ├── git/                    # Autonomous Git assistant & commit sub-agent
│   │   ├── branch-runner.ts    # Smart branch name recommendations & worktrees
│   │   ├── dialog.ts           # Interactive proposal confirmation dialog with actions & cost metrics
│   │   ├── editor.ts           # BlockingCommitEditor with live status & recent action logging
│   │   ├── format.ts           # Token, cost, and duration formatting utilities
│   │   ├── git.ts              # Git helpers: diff extraction, staging, commit execution
│   │   ├── index.ts            # /git and /commit command registration
│   │   ├── pr-runner.ts        # AI-powered Pull Request generator & GitHub CLI integration
│   │   ├── prompt.ts           # Commit guidelines & sub-agent system instructions
│   │   ├── release-runner.ts   # Release notes and changelog generator
│   │   ├── resolve-runner.ts   # AI merge conflict resolver
│   │   ├── routine-runner.ts   # Zero-token local git helpers (sync, undo, status hub)
│   │   ├── runner.ts           # Central commit execution runner
│   │   ├── smart-prompts.ts    # System instructions for smart workflow ops (PR, branch, conflict)
│   │   ├── smart-tools.ts      # Tools for PR inspection and conflict resolution
│   │   ├── tools.ts            # Minimal git inspection tools (git_overview, git_file_diff, propose_commit)
│   │   └── types.ts            # CommitProposal, usage metrics, and git overview data types
│   ├── compressor/
│   │   ├── parsers/
│   │   │   ├── git.ts          # Git status, push, commit, log, diff noise reduction
│   │   │   ├── lint.ts         # tsc, eslint, biome, ruff, generic linter parsing
│   │   │   ├── system.ts       # ls, tree, find, ps, curl/wget download filter
│   │   │   └── test.ts         # vitest, jest, pytest, cargo test, go test compression
│   │   ├── index.ts            # Output compressor registration, /recall, /gain commands
│   │   ├── pipeline.ts         # Central pipeline routing parsers, rules & dedup
│   │   ├── recall.ts           # In-memory RecallStore for full uncompressed outputs
│   │   ├── rules.ts            # Declarative rules table (docker, pkg managers, terraform)
│   │   ├── sanitizer.ts        # ANSI stripping, carriage return resolution, line dedup
│   │   ├── tracker.ts          # GainTracker analytics store for token/byte reduction
│   │   └── types.ts            # Filter, recall, rule, and analytics data types
│   ├── scout/
│   │   ├── classifier.ts       # Code definition & import scanner (TS, JS, Python, Rust, Go, C/C++)
│   │   ├── cursor.ts           # In-memory pagination cursor store
│   │   ├── external.ts         # External path & unindexed directory search runner
│   │   ├── formatter.ts        # Match-centered line truncation & token budgeting
│   │   ├── frecency.ts         # In-memory & persistent frecency tracker with git recency bonus
│   │   ├── index.ts            # Scout search engine registration & commands (/scout-health, etc.)
│   │   ├── indexer.ts          # In-memory file indexer, git status tracker, and grep engine
│   │   ├── interceptor.ts      # Transparent shell search command interceptor & agent steering
│   │   ├── matcher.ts          # Typo-tolerant fuzzy matcher & query constraint parser
│   │   ├── tools.ts            # Tool definitions (find, grep)
│   │   └── types.ts            # Search data structures and configuration types
│   ├── web/
│   │   ├── fetch/
│   │   │   ├── base.ts         # Abstract FetchProvider base class
│   │   │   ├── exa.ts          # Exa Contents fetch provider
│   │   │   ├── jina.ts         # Jina Reader free public fallback provider
│   │   │   ├── parallel.ts     # Parallel Extract fetch provider
│   │   │   ├── pipeline.ts     # Central web fetch failover & character budgeting pipeline
│   │   │   ├── tavily.ts       # Tavily Extract fetch provider
│   │   │   ├── tinyfish.ts     # TinyFish Fetch headless browser provider
│   │   │   └── types.ts        # Web fetch data types and schemas
│   │   ├── providers/
│   │   │   ├── antigravity.ts  # Google Gemini Grounding via Cloud Code Assist
│   │   │   ├── base.ts         # Abstract SearchProvider base class
│   │   │   ├── brave.ts        # Brave Search API integration
│   │   │   ├── exa.ts          # Exa Search API + public MCP fallback
│   │   │   ├── parallel.ts     # Parallel Search API + public MCP fallback
│   │   │   ├── tavily.ts       # Tavily Search API with direct answers
│   │   │   └── tinyfish.ts     # TinyFish Search API integration
│   │   ├── auth.ts             # Multi-source API key resolver (env, auth.json, accounts.json)
│   │   ├── formatter.ts        # Token-budgeted response & source citation formatter
│   │   ├── index.ts            # Web search subsystem entry point
│   │   ├── login.ts            # /login provider registrations for search engines
│   │   ├── pipeline.ts         # Central failover search router
│   │   ├── query.ts            # Google-style query parser & lenient constraint filter
│   │   ├── tools.ts            # web_search & web_fetch tool definitions & TypeBox schemas
│   │   └── types.ts            # Web search data types & schemas
│   ├── subagent/               # Autonomous isolated subagent routine
│   │   ├── index.ts            # /subagent and /jobs commands, tool registration
│   │   ├── jobs.ts             # BackgroundJobManager: non-blocking job registry, TUI widget, follow-up injection
│   │   ├── loader.ts           # SubagentBorderedLoader: native cancellable loader for sync runs
│   │   ├── runner.ts           # runSubagent in-process runner with model/thinking inheritance
│   │   ├── tools.ts            # subagent, subagent_status, subagent_list, subagent_cancel tool definitions
│   │   └── types.ts            # Subagent types & schemas
│   ├── feedback/               # Interactive user feedback subsystem
│   │   ├── index.ts            # Feedback tool registration & system prompt guidelines
│   │   ├── tools.ts            # Unified ask_user tool definition & polymorphic TUI renderers
│   │   └── types.ts            # Schemas for open-ended questions & structured choice selectors
│   └── index.ts                # registerTools aggregator
├── ux/                         # Workflow & user experience enhancements
│   ├── context/                # /context command: active context window analysis & breakdown
│   │   ├── analyzer.ts         # Active projection & session branch token analyzer
│   │   ├── command.ts          # /context command dispatcher (TUI vs non-TUI)
│   │   ├── component.ts        # Interactive ContextViewerComponent dialog with scrolling & compaction
│   │   ├── format.ts           # Terminal & ANSI context breakdown formatter
│   │   ├── index.ts            # /context command registration
│   │   └── types.ts            # Context breakdown, category, and consumer schemas
│   ├── continue/
│   │   ├── index.ts            # Input handler registering "." continue shortcut
│   │   └── prompt.ts           # System directive instructing model to resume unfinished work
│   ├── plan/                   # Plan & Implement mode subsystem (/plan, /implement)
│   │   ├── editor.ts           # Plan custom editor component with Amber border palette
│   │   ├── gate.ts             # Human-in-the-loop plan approval gate
│   │   ├── index.ts            # /plan, /implement commands, shortcuts (Ctrl+Alt+P, Alt+M), flag
│   │   ├── manager.ts          # PlanModeManager: state store, tool_call sandboxing & persistence
│   │   ├── prompt.ts           # System directives for Plan Mode and Implement Mode
│   │   ├── safe-bash.ts        # Shell command allowlist/blocklist safety classifier
│   │   └── types.ts            # PlanModeState schema
│   ├── settings/               # Enhanced settings configuration subsystem & /settings-enhanced
│   │   ├── command.ts          # /settings-enhanced command dispatcher (TUI vs non-TUI)
│   │   ├── component.ts        # EnhancedSettingsComponent: SettingsList with live toggles
│   │   ├── format.ts           # ANSI terminal settings formatter
│   │   ├── index.ts            # /settings-enhanced registration
│   │   ├── store.ts            # EnhancedSettingsStore (persisted in ~/.pi/agent/enhanced-settings.json)
│   │   └── types.ts            # Settings definitions & schemas
│   ├── timer/
│   │   └── index.ts            # Working status telemetry timer & settled turn summary entry
│   ├── usage/
│   │   ├── antigravity.ts      # Cloud Code Assist quota bucket scraper
│   │   ├── codex.ts            # OpenAI Codex /wham/usage quota scraper
│   │   ├── commandcode.ts      # Command Code credits, monthly pool & 5h/weekly burst scraper
│   │   ├── footer.ts           # Status footer showing quota consumption & time progress
│   │   ├── format.ts           # Terminal & ASCII progress bar formatting
│   │   ├── hyper.ts            # Charm Hyper /v1/credits quota scraper
│   │   ├── index.ts            # /usage command registration + usage report collection
│   │   └── types.ts            # Quota report structures
│   └── index.ts                # registerUX aggregator
├── index.ts                    # Root extension entry point
├── package.json                # Pi manifest, package metadata, peerDependencies
├── tsconfig.json               # NodeNext TypeScript configuration
└── README.md                   # User documentation
```

---

## Development Principles & Rules

1. **Root-Level Package Structure**:
   - `index.ts` lives at the repository root. Do not wrap files in redundant nested directories (e.g. avoid `pi-enhanced/pi-enhanced/`).
   - `package.json` declares `"pi": { "extensions": ["./index.ts"] }`.

2. **Module Imports & NodeNext**:
   - `tsconfig.json` uses `"moduleResolution": "NodeNext"`.
   - **All relative imports within TypeScript source files MUST use the `.js` extension** (e.g. `import { foo } from "./bar.js";`).

3. **Pi Core Dependencies**:
   - `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@earendil-works/pi-agent-core` are host-provided dependencies.
   - Always declare them under `peerDependencies` with `"*"` and under `devDependencies`. Do NOT list them under `dependencies` to prevent duplicating packages during `pi install`.

4. **Zero Hardcoded Model Names**:
   - Model discovery must be dynamic whenever possible.
   - For Antigravity: query Google's `fetchAvailableModels` endpoint.
   - For Charm Hyper: query `https://hyper.charm.land/v1/provider`.
   - For Command Code: query `https://api.commandcode.ai/provider/v1/models`.
   - For OpenAI Codex: query `https://chatgpt.com/backend-api/codex/models?client_version=1.0.0` and cross-reference `available_in_plans`.

5. **Type Safety**:
   - Always run `npm run typecheck` before committing.

6. **New Provider / Endpoint Integration Procedure (Mandatory Pre-flight & "Perfect Provider" Standard)**:
   - **Always audit provider documentation and API completeness before writing any integration code.**
   - **The "Perfect Provider" Qualification Rules**:
     For a provider to be deemed qualified or ideal for addition into `pi-enhanced`, they must adhere to three core API standards:
     1. **Dynamic Model Discovery with Pricing & Reasoning Capabilities**:
        - Must provide an API that queries available models dynamically.
        - Per-token pricing (input, output, cache read/write) and available reasoning effort sliders/levels (e.g. `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) must be clearly visible and extractable.
        - *Bonus points*: The catalog endpoint accepts an authentication key or bearer token and filters the response strictly to the models accessible under that specific credential's subscription plan tier (eliminating phantom model choices and runtime 403/404 errors).
     2. **Programmatic Plan & Subscription Differentiation**:
        - Must provide an unambiguous, programmatic mechanism for the extension to determine the account's active plan tier (e.g. `pay-as-you-go` / `prepaid`, `pro`, `max`, `team`, `enterprise`, etc.).
        - Acceptable discovery mechanisms include:
          - Dedicated subscription, account, or billing endpoints (e.g. `/v1/me`, `/v1/subscription`, `/v1/account`, `/billing/credits`).
          - Decodable OAuth token claims (e.g. JWT claims like `chatgpt_plan_type`, `tier`, or plan IDs).
          - Live usage/quota payload fields that return the active plan or product name.
        - *Why this is mandatory*: Without programmatic plan identification, the extension cannot know which quota windows apply (e.g. weekly subscription allowance vs. non-expiring prepaid credits), which model tiers or priority rate limits are active, or how to truthfully format reset countdowns in the status footer and `/usage` view without guessing or fabricating data.
     3. **Parseable Usage, Quota & Reset Mechanics (`/usage` Readiness)**:
        - Must provide an API exposing usage, remaining quota, and reset timings. It does not need to be standardized, but it must be reliably parseable so we can integrate it directly into the `/usage` module and status footer.
        - Must show available or consumed quota alongside when the quota resets.
        - Must identify the provider's exact reset architecture:
          - **Global / Bulk Reset**: Fixed-schedule all-at-once replenishment (e.g. daily at 00:00 UTC, weekly on Sundays at 00:00 UTC, monthly billing boundaries).
          - **Rolling Window Reset**: Continuous replenishment where older requests/tokens roll off after a sliding duration (e.g. 5-hour rolling window, 24-hour sliding window, per-minute request replenishment).
   - **Audit Evaluation Checklist**:
     Inspect and evaluate the following facets during pre-flight:
     - **Inference & Wire Protocols**: OpenAI / Anthropic compatibility, streaming (SSE), tool calling, reasoning effort translations, structured outputs, embeddings, etc.
     - **Dynamic Model Catalog**: Endpoints for discovering active models/pricing dynamically to avoid hardcoding model lists.
     - **Usage, Quotas & Cost Tracking**: Inline token/cost fields, balance endpoints (`/credits`), settled exports, and `/usage` monitor integration potential.
     - **Limits, Quotas & Error Envelopes**: HTTP 429 semantics, rate limit headers, daily caps, retry-after policies, and failover behavior.
     - **Authentication & Key Lifecycle**: API key formats, OAuth flows, provisioning vs. inference permissions, and multi-account balancing support.
     - **Edge Cases & Gaps**: Missing endpoints (e.g. token counting, webhooks), parameter validation quirks, or platform-specific constraints.
   - Present the audit report and obtain user confirmation before starting implementation.

7. **Native UI Harmony & Minimal Surface Area**:
   - Always match Pi's native interaction model, visual language, and keyboard conventions.
   - Do **not** inject synthetic pseudo-options such as `[ Cancel ]`, `[ Back ]`, or `← Back` into selector lists (`ctx.ui.select`); Pi's native TUI components inherently use `Esc` for cancellation and dismissal.
   - **Standardized Selection & Radio Indicator**: All choice lists and selectors must align with Pi's native selection conventions (`→ ` selection arrow / `theme.cursor`). Avoid redundant or competing leading glyphs (such as `*`, `▶`, `■`, or status icons/emojis) at the beginning of choice strings that clash with the selection arrow; use clean text labels and suffix tags (e.g. `(current)`, `(active)`) instead. In custom modal components, always render selection indicators using `→ ` (matching `theme.cursor`), not `>` or `*`.
   - Touch as minimal a surface area of the host application as possible. Avoid replacing core components (e.g. replacing the primary editor or recreating entire host dialogs) when a targeted hook, lightweight lifecycle event, or native dialog invocation (`ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.notify`) achieves the same behavior.
   - Multi-account flows (e.g. account selection during `/logout`) must look and feel like native Pi sub-selectors with standard formatting (e.g. `(active)`, clean identity labels) rather than bespoke custom dashboards.

8. **No Persistent Test Files**:
   - Do **NOT** write, commit, or persist unit test files (`*.test.ts`, `*.spec.ts`, `tests/`, `__tests__/`).
   - Verify behavior transiently: test dynamically using headless `pi -e ./index.ts -p "..."` runs, live interactive CLI checks, or temporary inline one-liners. Always clean up any ephemeral test scripts before completing the task.

---

## Testing Workflow

### 1. Transient Verification Commands (No Test Files)
Do not create persistent test files. Validate changes using type checking and live transient CLI executions:

```bash
# Typecheck TypeScript files
npm run typecheck

# Test extension directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "say hello"

# Test slash commands headlessly
pi -e ./index.ts -p "/settings-enhanced list"
pi -e ./index.ts -p "/usage"

# Install globally to test local build
pi install .

# Verify active models
pi --list-models
```

---

## Distribution

This package is distributed directly via **GitHub** (`pi install git:github.com/RaviEdho/pi-enhanced`).

There is no npm packaging, version-bump, or GitHub release pipeline. Do not run `npm version` or create releases — the `version` field in `package.json` is informational only. Shipping a change simply means merging to the default branch; users pick it up on their next `pi install` / update.
