# pi-for-raviedho

Personalized Pi extension package providing the **Google Antigravity** provider, **Charm Hyper** inference provider, and dynamic OpenAI Codex plan filtering.

## Features

- **Charm Hyper Inference Provider**:
  - Fast, cost-effective inference for coding agents via Charm Hyper (`https://hyper.charm.land`).
  - Dual authentication: OAuth 2.0 Device Code Flow (`/login hyper`) and API key via `HYPER_API_KEY`.
  - Dynamic model discovery from `/v1/provider` with reasoning effort levels, image attachment support, and context window awareness (DeepSeek V4.1 Flash, Qwen 3.8 Max, Kimi K3, GLM 5.3, MiniMax M3, Inkling, etc.).
  - Multi-account pooling with transparent 429 rate limit & 402 billing failover.
  - Live Hypercredit (HC) balance tracking in `/usage` and interactive footer status bar.
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
- **Dynamic OpenAI Codex Plan Filtering**: Automatically detects your ChatGPT plan tier (`free`, `plus`, `pro`) from your OAuth token, queries OpenAI's live model endpoint, and filters out unavailable models from `/model` and `pi --list-models`.
- **Multi-Account Support & Auto-Failover**: Pool multiple accounts per provider (Google Antigravity, OpenAI Codex, etc.) with deterministic session affinity for optimal prompt caching, automatic OAuth token refresh, weekly reset-pace balancing, and transparent failover on 429 / quota exhaustion.
- **Provider Quotas with Reset Pace Markers**: Live multi-account quota monitoring via `/usage` showing usage percentage, plan tier, reset countdowns, and real-time reset progress markers (`┃`) on the usage bar.
- **Autonomous Commit (`/commit`)**: Inspects staged changes using an isolated, in-memory sub-agent with specialized diff-sampling tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`). Automatically determines whether changes should be consolidated into a single commit or structured into an ordered sequence of atomic, multi-stage commits, with an interactive preview dialog, plan editor, and optional git push.
- **Terminal Output Compressor (`compressor/`, `/gain`, `/recall`)**: Native in-process port of RTK (Rust Token Killer) features without requiring external binaries or command rewriting. Hooks into Pi's `tool_result` event, compressing 60–90% of raw terminal noise (collapsing passing test suites, condensing git status/push/diff, pruning linter squiggles, stripping progress meters, and deduplicating repetitive logs). Stores full uncompressed outputs in an LRU buffer accessible via `/recall <id>` and provides token reduction statistics via `/gain`.
- **Continue Shortcut (`.` Continue)**: Pressing `.` (literal dot only) immediately resumes agent work on the most recent intent without summarizing, asking for confirmation, or leaving any user message bubble in the chat transcript.
- **Codebase Scout Search Engine (`scout/`, `/scout-health`, `/scout-rescan`)**: 100% pure TypeScript port of FFF concepts. Replaces standard `find` and `grep` with memory-cached, typo-tolerant search tools (`find`/`smart_find`, `grep`/`smart_grep`, `multi_grep`). Features Smith-Waterman fuzzy matching, definition-first ranking, multi-pattern OR search in a single turn, git recency awareness, and strict output budgeting with match-centered line truncation (`…match…`) to prevent context blowup.
- **Unified Multi-Provider Web Search & Fetch (`web/`)**: Native `web_search` and `web_fetch` tools. Supports Google Antigravity Grounding, Brave Search, Tavily, Exa, Parallel, TinyFish, and Jina Reader. Features transparent multi-engine failover, Google-style syntax parsing (`site:`, `before:`, `after:`, `-exclusions`, `"quotes"`), clean Markdown extraction with anti-bot/SPA handling, strict token budgeting, and API key management directly via `/login` (`/login brave`, `/login tavily`, `/login exa`, `/login parallel`, `/login tinyfish`).
- **Pi Auth Sync**: Automatically imports credentials from `~/.pi/agent/auth.json` into the accounts pool and syncs the active healthy account back to `auth.json`.

## Usage

### 1. Install Extension Globally

```bash
pi install git:github.com/RaviEdho/pi-for-raviedho
```

Verify installed packages:

```bash
pi list
```

### 2. Login via OAuth

```bash
# In an interactive Pi session:
/login google-antigravity

# Or login to Charm Hyper:
/login hyper
```

Credentials and tokens are stored in `~/.pi/agent/auth.json` and refreshed automatically. You can also export `HYPER_API_KEY="sk-hyper-..."` directly.

### 3. Running with Models

```bash
# Interactive mode with Charm Hyper
pi --model hyper/deepseek-v4.1-flash
pi --model hyper/qwen3.8-max

# Interactive mode with default Antigravity model
pi --model google-antigravity/gemini-3.1-pro

# Using Claude Sonnet 4.6
pi --model google-antigravity/claude-sonnet-4-6

# Non-interactive query
pi --model google-antigravity/gemini-2.5-flash -p "Summarize git status"
```
### 4. Check Provider Quotas and Usage

Run `/usage` to view live quotas, progress bars, and reset times across all accounts:

```bash
# In interactive Pi session:
/usage

# Or from terminal:
pi -p "/usage"
```

### 5. Autonomous Commits

Run `/commit` to inspect staged changes and generate commit messages autonomously:

```text
/commit
/commit focus on auth error handling improvements
```

- Spins up an isolated sub-agent with zero conversation context bloat.
- Transparent live progress and recent action logging in the status box.
- Only pulls overview statistics and diffs for key changed files, omitting lockfiles and huge generated assets.
- Full token usage and cost accounting displayed in the confirmation dialog, CLI output, and completion notification.
- Interactive proposal review with full message preview (header & body), detailed file diff metrics, direct commit (`c`), commit & push (`p`), edit (`e`), or cancel (`Esc`).

### 6. Web Search & Web Fetch

The `web_search` and `web_fetch` tools are automatically available to LLMs during conversations.

#### Managing Search & Fetch API Keys:
You can manage provider API keys directly in interactive mode via `/login` and `/logout`:
```text
/login brave
/login tavily
/login exa
/login parallel
/login tinyfish
```
Keys are securely prompted in the TUI, saved to `~/.pi/agent/auth.json`, or read from environment variables (`BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `TINYFISH_API_KEY`).

- **`web_search`**: Supports Google operators (`site:`, `before:`, `after:`, `"exact phrase"`, `-negation`) and automatically falls over if a provider hits rate limits or errors. Google Antigravity Grounding is automatically available if you have authenticated via `/login google-antigravity`.
- **`web_fetch`**: Fetches any URL and extracts clean Markdown (handling JS-rendered SPAs, anti-bot challenges, and token budgeting) with automatic failover across Parallel, TinyFish, Exa, Tavily, and Jina Reader.

## Development

```bash
# Typecheck TypeScript files
npm run typecheck

# Test directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "hello"
```
