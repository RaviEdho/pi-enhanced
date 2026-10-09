# pi-enhanced

Enhanced Pi extension package providing the **Google Antigravity** provider, **Charm Hyper** inference provider, dynamic OpenAI Codex plan filtering, autonomous commit workflows, terminal output compression, codebase search, and multi-provider web search.

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
- **Multi-Account Support & Auto-Failover**: Pool multiple accounts per provider (Google Antigravity, OpenAI / ChatGPT subscriptions, OpenAI Codex, Charm Hyper) with deterministic session affinity for optimal prompt caching, automatic OAuth token refresh, weekly reset-pace balancing, and transparent failover on 429 / quota exhaustion.
- **Provider Quotas with Reset Pace Markers**: Live multi-account quota monitoring via `/usage` showing usage percentage, plan tier, reset countdowns, and real-time reset progress markers (`┃`) on the usage bar.
- **Autonomous Git Assistant (`/git`, `/commit`)**: Inspects staged changes using an isolated, in-memory sub-agent with specialized diff-sampling tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`), supports atomic multi-stage commits, PR generation (`/git pr`), smart branching (`/git branch`), merge conflict resolution (`/git resolve`), release drafting (`/git release`), and instant zero-token helpers (`/git sync`, `/git undo`).
- **Terminal Output Compressor (`tools/compressor/`, `/gain`, `/recall`)**: Native in-process port of RTK (Rust Token Killer) features without requiring external binaries or command rewriting. Hooks into Pi's `tool_result` event, compressing 60–90% of raw terminal noise (collapsing passing test suites, condensing git status/push/diff, pruning linter squiggles, stripping progress meters, and deduplicating repetitive logs). Stores full uncompressed outputs in an LRU buffer accessible via `/recall <id>` and provides token reduction statistics via `/gain`.
- **Continue Shortcut (`.` Continue)**: Pressing `.` (literal dot only) immediately resumes agent work on the most recent intent without summarizing, asking for confirmation, or leaving any user message bubble in the chat transcript.
- **Live Turn Telemetry in the Working Status**: The `Working` indicator shows elapsed time plus real-time per-run metrics appended inline — cumulative tokens in/out (`↑15.2k ↓3.1k`), time-to-first-token (`TTFT 0.9s`), and decode throughput (`38 tok/s`). Counters sum every turn and model call while the agent is still working and reset once the run settles.
- **Settled Turn Summary in the Transcript**: Once the agent finishes its final turn, a compact telemetry line is printed into the transcript right after the response — total elapsed time, total tokens in/out (`↑15k ↓3.0k`), average TTFT across every model call (`TTFT avg 1.0s`), and average decode throughput (`50 tok/s avg`). Stored as a session entry (never sent to the model) and expandable to reveal the model-call count.
- **Codebase Scout Search Engine (`tools/scout/`, `/scout-health`, `/scout-rescan`)**: 100% pure TypeScript port of FFF concepts. Replaces standard `find` and `grep` with memory-cached, typo-tolerant search tools (`find`, `grep`, `multi_grep`). Features Smith-Waterman fuzzy matching, definition-first ranking, multi-pattern OR search in a single turn, git recency awareness, and strict output budgeting with match-centered line truncation (`…match…`) to prevent context blowup.
- **Unified Multi-Provider Web Search & Fetch (`tools/web/`)**: Native `web_search` and `web_fetch` tools. Supports Brave Search, Tavily, Google Antigravity Grounding, TinyFish, Exa, and Parallel. Features transparent multi-engine failover, Google-style syntax parsing (`site:`, `before:`, `after:`, `-exclusions`, `"quotes"`), clean Markdown extraction with anti-bot/SPA handling, strict token budgeting, and API key management directly via `/login` (`/login brave`, `/login tavily`, `/login exa`, `/login parallel`, `/login tinyfish`).
- **Autonomous Isolated Subagent Routine (`tools/subagent/`, `/subagent`, `/jobs`)**: In-process subagent execution powered by in-memory sessions (`SessionManager.inMemory`). Supports both synchronous blocking delegation and non-blocking background execution (`background: true` / `/subagent --bg`). Automatically inherits the active model and thinking effort of the parent session, executes with focused system instructions, safe read-only mode (`readOnly: true` / `/subagent --readonly`), guardrails (max turns & timeouts), enhanced tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `multi_grep`, `web_search`, `web_fetch`), context budgeting, cleanly coordinated follow-up delivery into the parent session, and full lifecycle control (`subagent_status`, `subagent_cancel`, `/jobs`).
- **Pi Auth Sync**: Automatically imports credentials from `~/.pi/agent/auth.json` into the accounts pool and syncs the active healthy account back to `auth.json`.

## Usage

### 1. Install Extension Globally

```bash
pi install git:github.com/RaviEdho/pi-enhanced
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

### 5. Inspect Context Window Breakdown (`/context`)

Run `/context` to inspect the active context window consumption of the current chat:

```bash
# In interactive Pi session:
/context

# Or from terminal:
pi -p "/context"
```

- **Compact Usage Bar**: Single-line horizontal progress bar matching Pi's native bar aesthetic with clear percentage and token allocation (`[████░░░░░░░░░░░░░░░░░░░░] 24.2k / 200k (12.1%)`).
- **Headroom & Auto-compaction**: Clear token headroom with inline compaction trigger countdown (`compacts in 159.5k · at 92%`).
- **Clean Category Breakdown**: Native Pi typography and aligned sections without screen clutter:
  - **System**: Base instructions, project guidelines (`AGENTS.md`), and documentation overhead.
  - **Messages**: User messages and assistant turns, with inline thinking / reasoning tokens.
  - **Tools**: Tool execution results with call counts and compact breakdown of top tools.
  - **Compacted**: Compaction run history and summary tokens (if any).
- **Interactive TUI Controls**: Re-analyze in real time with `r`, trigger manual compaction with `c`, and close cleanly with `esc` or `Enter`. Fits on any terminal without scrolling.

### 6. Autonomous Git Assistant (`/git`, `/commit`)

Run `/git` or `/commit` to autonomously inspect changes and manage git workflows:

```text
/git                          # Interactive status hub & workflow launcher
/git commit                   # Autonomous commit (same as /commit)
/commit                       # Shorthand alias to /git commit
/commit -u                    # Stash staged changes, commit only unstaged, then restore staged
/commit -s                    # Force a single consolidated commit
/commit -m                    # Split changes into atomic commit stages

# Smart Workflow Operations (AI-Assisted)
/git pr [base-branch]         # Generate structured PR title, body & optionally create via `gh pr create`
/git branch [description]     # Smart conventional branch name recommender & switcher
/git worktree [list|add|rm]   # Git worktree manager for parallel task isolation
/git resolve [file]           # Autonomous merge conflict analyzer & hunk resolver
/git release [tag]            # Release notes & changelog drafter grouped by conventional types

# Instant Routine Helpers (0 LLM Tokens)
/git sync                     # Safe pull --rebase & push to upstream
/git undo                     # Soft-undo last commit, keeping changes in working tree
/git status                   # Interactive status overview
```

- **Unstaged Commit Isolation**: When both staged and unstaged changes are detected, choose "Commit only unstaged changes (stash staged)" or pass `-u` / `--unstaged`. Your manual staged changes are safely preserved in git stash while the unstaged changes are committed, and restored to the index automatically upon completion or safely rolled back on cancel.
- Spins up an isolated sub-agent with zero conversation context bloat.
- Transparent live progress and recent action logging in the status box.
- Only pulls overview statistics and diffs for key changed files, omitting lockfiles and huge generated assets.
- Full token usage and cost accounting displayed in the confirmation dialog, CLI output, and completion notification.
- Interactive proposal review with full message preview (header & body), detailed file diff metrics, direct commit (`c`), commit & push (`p`), edit (`e`), or cancel (`Esc`).

### 7. Web Search & Web Fetch

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

- **`web_search`**: Supports Google operators (`site:`, `before:`, `after:`, `"exact phrase"`, `-negation`) and automatically falls over if a provider hits rate limits or errors across Brave, Tavily, Google Antigravity, TinyFish, Exa, and Parallel.
- **`web_fetch`**: Fetches any URL and extracts clean Markdown (handling JS-rendered SPAs, anti-bot challenges, and token budgeting) with automatic failover across TinyFish, Parallel, Exa, Tavily, and Jina Reader.

## Development

```bash
# Typecheck TypeScript files
npm run typecheck

# Test directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "hello"
```
