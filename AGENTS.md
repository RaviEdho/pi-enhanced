# AGENTS.md

Guidance and instructions for AI agents working in this repository.

## Repository Overview

`pi-for-raviedho` is a personal extension suite for the [Pi](https://github.com/earendil-works/pi) coding agent. It bundles custom providers, tools, quota monitors, and model filtering logic into an installable Pi package.

### Key Capabilities
- **Multi-Account Manager & Balancer (`accounts/`)**: Multi-account store (`accounts.json`), session affinity hashing, weekly reset pace optimization, automatic sync from Pi (`auth.json`), automatic token refresh, and transparent 429 rate limit failover across accounts during streaming turns.
- **Google Antigravity Provider (`providers/antigravity/`)**: Custom provider integrating with Google Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`) using OAuth 2.0 with automatic project discovery / onboarding (`cloudaicompanionProject`).
- **Charm Hyper Provider (`providers/hyper/`)**: Custom provider connecting to Charm Hyper (`https://hyper.charm.land/v1`) with device code OAuth flow (`/login hyper`), API key authentication (`HYPER_API_KEY`), live dynamic model discovery (`/v1/provider`), reasoning effort level translation, and multi-account load balancing.
- **OpenAI Codex Plan Filter (`providers/codex/`)**: Dynamic tier detection from OAuth token JWT claims (`chatgpt_plan_type`). Fetches the live model catalog from OpenAI and drops unsupported models from `/model` and `pi --list-models` via `@earendil-works/pi-ai`'s native `filterModels` hook.
- **Provider Quota & Usage Monitor (`usage/`)**: Live multi-account quota tracking, percentage consumption bars, and reset countdowns across configured providers via the `/usage` command.
- **Autonomous Commit (`commit/`)**: Lightweight, autonomous `/commit` slash command that spins up an isolated in-memory sub-agent with specialized git inspection tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`), intelligent single vs. multi-stage atomic commit planning, transparent live action progress, zero conversation context bloat, and full token/cost accounting.
- **Continue Shortcut (`continue/`)**: Seamless, invisible continuation turn triggered by sending `.` (literal dot only). Injects a directive instructing the model to resume unfinished work without pausing or summarizing, while completely suppressing any user message bubble from appearing in the chat transcript.
- **Terminal Output Compressor (`compressor/`)**: In-process port of RTK (Rust Token Killer) features without requiring external binaries. Intercepts bash and PowerShell `tool_result` events, collapsing verbose terminal noise (passing tests, git push/status boilerplate, linter carets, repeated log loops, progress bars) by 60–90% before reaching LLM context. Includes an in-memory `/recall` ring buffer and a `/gain` token savings dashboard.
- **Codebase Scout Search Engine (`scout/`)**: 100% pure TypeScript port of FFF concepts without native binaries or C FFI dependencies. Features typo-tolerant fuzzy path finding (`find` / `smart_find`), definition-first content grep (`grep` / `smart_grep`), multi-pattern OR search (`multi_grep`), transparent shell search interception and agent steering, in-memory file index with git status awareness, and strict output budgeting with match-centered truncation (`…match…`) to prevent LLM context blowup.

---

## Directory Layout

```text
pi-for-raviedho/
├── accounts/
│   ├── balancer.ts             # AccountBalancer: session affinity, 429 cooldown, token refresh
│   ├── index.ts                # Account subsystem public exports
│   ├── store.ts                # AccountStore: persistence, auth.json sync
│   ├── types.ts                # AccountCredential and store schemas
│   └── wrapper.ts              # executeWithMultiAccountFailover: stream wrapper with 429 rotation
├── commit/
│   ├── dialog.ts               # Interactive proposal confirmation dialog with actions & cost metrics
│   ├── editor.ts               # BlockingCommitEditor with live status & recent action logging
│   ├── format.ts               # Token, cost, and duration formatting utilities
│   ├── git.ts                  # Git helpers: diff extraction, staging, commit execution
│   ├── index.ts                # /commit command registration & interactive approval loop
│   ├── prompt.ts               # Commit guidelines & sub-agent system instructions
│   ├── tools.ts                # Minimal git inspection tools (git_overview, git_file_diff, propose_commit)
│   └── types.ts                # CommitProposal, usage metrics, and git overview data types
├── continue/
│   ├── index.ts                # Input handler registering "." continue shortcut
│   └── prompt.ts               # System directive instructing model to resume unfinished work
├── compressor/
│   ├── parsers/
│   │   ├── git.ts              # Git status, push, commit, log, diff noise reduction
│   │   ├── lint.ts             # tsc, eslint, biome, ruff, generic linter parsing
│   │   ├── system.ts           # ls, tree, find, ps, curl/wget download filter
│   │   └── test.ts             # vitest, jest, pytest, cargo test, go test compression
│   ├── index.ts                # Output compressor registration, /recall, /gain commands
│   ├── pipeline.ts             # Central pipeline routing parsers, rules & dedup
│   ├── recall.ts               # In-memory RecallStore for full uncompressed outputs
│   ├── rules.ts                # Declarative rules table (docker, pkg managers, terraform)
│   ├── sanitizer.ts            # ANSI stripping, carriage return resolution, line dedup
│   ├── tracker.ts              # GainTracker analytics store for token/byte reduction
│   └── types.ts                # Filter, recall, rule, and analytics data types
├── providers/
│   ├── antigravity/
│   │   ├── constants.ts        # Wire profiles, OAuth endpoints, Google client configuration
│   │   ├── models.ts           # Dynamic model catalog discovery & collapsing from Google
│   │   ├── oauth.ts            # OAuth 2.0 PKCE flow, loopback server, and token refresh
│   │   ├── stream.ts           # Cloud Code Assist SSE streaming client & schema transformation
│   │   └── types.ts            # Cloud Code Assist protocol schemas
│   ├── codex/
│   │   ├── catalog.ts          # Live catalog fetching from OpenAI & disk caching
│   │   ├── index.ts            # Provider wrapper with filterModels hook
│   │   ├── plan.ts             # JWT claim parsing for chatgpt_plan_type & chatgpt_account_id
│   │   └── types.ts            # Catalog & cache types
│   └── hyper/
│       ├── constants.ts        # Base URLs, API endpoints, User-Agent, timeouts
│       ├── models.ts           # Dynamic model catalog discovery & fallback mapping from Hyper
│       ├── oauth.ts            # OAuth 2.0 Device Flow login, loopback poll, and token exchange
│       ├── stream.ts           # Streaming client via OpenAI Chat Completions compatibility
│       └── types.ts            # Hyper device auth, token, and model schemas
├── scout/
│   ├── classifier.ts           # Code definition & import scanner (TS, JS, Python, Rust, Go, C/C++)
│   ├── cursor.ts               # In-memory pagination cursor store
│   ├── external.ts             # External path & unindexed directory search runner
│   ├── formatter.ts            # Match-centered line truncation & token budgeting
│   ├── frecency.ts             # In-memory & persistent frecency tracker with git recency bonus
│   ├── index.ts                # Scout search engine registration & commands (/scout-health, etc.)
│   ├── indexer.ts              # In-memory file indexer, git status tracker, and grep engine
│   ├── interceptor.ts          # Transparent shell search command interceptor & agent steering
│   ├── matcher.ts              # Typo-tolerant fuzzy matcher & query constraint parser
│   ├── tools.ts                # Tool definitions (find/smart_find, grep/smart_grep, multi_grep)
│   └── types.ts                # Search data structures and configuration types
├── timer/
│   └── index.ts                # Working status indicator elapsed duration timer
├── usage/
│   ├── antigravity.ts          # Cloud Code Assist quota bucket scraper
│   ├── codex.ts                # OpenAI Codex /wham/usage quota scraper
│   ├── format.ts               # Terminal & ASCII progress bar formatting
│   ├── hyper.ts                # Charm Hyper /v1/credits quota scraper
│   ├── index.ts                # /usage command registration (TUI overlay + CLI fallback)
│   └── types.ts                # Quota report structures
├── index.ts                    # Root extension entry point
├── package.json                # Pi manifest, package metadata, peerDependencies
├── tsconfig.json               # NodeNext TypeScript configuration
└── README.md                   # User documentation
```

---

## Development Principles & Rules

1. **Root-Level Package Structure**:
   - `index.ts` lives at the repository root. Do not wrap files in redundant nested directories (e.g. avoid `pi-for-raviedho/pi-for-raviedho/`).
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
   - For OpenAI Codex: query `https://chatgpt.com/backend-api/codex/models?client_version=1.0.0` and cross-reference `available_in_plans`.

5. **Type Safety**:
   - Always run `npm run typecheck` before committing.

6. **New Provider / Endpoint Integration Procedure (Mandatory Pre-flight)**:
   - **Always audit provider documentation and API completeness before writing any integration code.**
   - Inspect and evaluate the following facets:
     - **Inference & Wire Protocols**: OpenAI / Anthropic compatibility, streaming (SSE), tool calling, reasoning effort translations, structured outputs, embeddings, etc.
     - **Dynamic Model Catalog**: Endpoints for discovering active models/pricing dynamically to avoid hardcoding model lists.
     - **Usage, Quotas & Cost Tracking**: Inline token/cost fields, balance endpoints (`/credits`), settled exports, and `/usage` monitor integration potential.
     - **Limits, Quotas & Error Envelopes**: HTTP 429 semantics, rate limit headers, daily caps, retry-after policies, and failover behavior.
     - **Authentication & Key Lifecycle**: API key formats, OAuth flows, provisioning vs. inference permissions, and multi-account balancing support.
     - **Edge Cases & Gaps**: Missing endpoints (e.g. token counting, webhooks), parameter validation quirks, or platform-specific constraints.
   - Present the audit report and obtain user confirmation before starting implementation.

---

## Testing Workflow

### 1. Verification Commands
```bash
# Typecheck TypeScript files
npm run typecheck

# Test extension directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "say hello"

# Install globally to test local build
pi install .

# Verify active models
pi --list-models

# Test commands
pi -p "/usage"
```

---

## Release & Distribution Workflow

This package is distributed directly via **GitHub** (`pi install git:github.com/RaviEdho/pi-for-raviedho`).

### Step-by-Step Release Process

1. **Ensure Working Directory is Clean**:
   ```bash
   git status
   npm run typecheck
   ```

2. **Bump the Version**:
   Use `npm version` to update `package.json`, create a commit, and create a git tag:
   ```bash
   # Bug fixes / small updates:
   npm version patch

   # New features / new models:
   npm version minor

   # Breaking changes:
   npm version major
   ```

3. **Push Commits and Tags**:
   ```bash
   git push --follow-tags
   ```

4. **Create GitHub Release**:
   ```bash
   gh release create vX.Y.Z --generate-notes
   ```
