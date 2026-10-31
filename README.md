# pi-enhanced

Enhanced Pi extension package providing the **Google Antigravity** provider, **Command Code** provider, **Kenari** AI gateway provider, dynamic OpenAI Codex plan filtering, autonomous commit workflows, terminal output compression, codebase search, and multi-provider web search.

## Features

- **Background Discord Agent Gateway (`/discord`)**: Run a detached Discord bot independently of the interactive Pi terminal. DMs and server threads are restricted to configured user/channel allowlists; a bot mention in an allowlisted server channel creates a thread with a durable, per-thread/per-user Pi session. The gateway uses your configured Pi model, extensions, and tools, routes Pi UI questions through Discord buttons, select menus, and text-entry modals, renames new threads to their generated session title when available, and offers the `discord_gateway_restart` tool for deferred self-restarts after code changes.
- **Ollama Cloud Provider**:
  - Sign in with `/login ollama-cloud` or set `OLLAMA_API_KEY`. Discover cloud models and their tool, vision, thinking and context metadata dynamically.
  - On login, the account plan and purchased balance are checked. Free accounts without purchased credits hide models observed to be restricted in a Free-account probe; paid plans or accounts with purchased credits retain the full catalog. Unknown access is not hidden. The snapshot is an observation, not an Ollama entitlement guarantee.
  - `/usage` and the quota footer show included and purchased balances or legacy limits when reported. Model prices are estimates parsed from Ollama's pricing page; unknown rates use Pi's required numeric zero placeholders and are labeled unknown or incomplete. Output limits are estimates. Actual billing can differ, including off-peak rates.
  - Ollama's catalog is public and is not known to filter by account entitlement. Native model-specific thinking controls are not currently mapped to Pi's effort slider.
- **Kenari AI Gateway Provider**:
  - Direct connection to Kenari (`https://kenari.id/v1`) with access to 110+ open and closed frontier models in Rupiah.
  - Dual authentication: Choose browser loopback PKCE sign-in or API-key login via `/login kenari`, or set `KENARI_API_KEY`.
  - Dynamic live model discovery (`/v1/models` and `/api/public/pricing`) with live micro-IDR token pricing converted to USD, context length limits, tool calling, and discrete reasoning effort controls.
  - Multi-account pooling with transparent 429 rate limit failover (`plan_limit_reached`, `free_quota_daily`, `free_quota_rpm`) and 402 balance backoff (`insufficient_balance`).
  - Live rolling window quota (5-hour, weekly, monthly) and prepaid balance monitoring via `/usage` and interactive status footer.
- **Command Code Provider**:
  - Direct connection to Command Code's Provider API (`https://api.commandcode.ai/provider/v1`) with access to 80+ open & closed frontier models.
  - Dual authentication: Native Pi login supports account OAuth and interactive API-key sign-in; `COMMANDCODE_API_KEY` is also supported.
  - Dynamic live model discovery (`/provider/v1/models`) with dual-protocol routing (Anthropic Messages API for Claude Sonnet/Opus/Haiku, and OpenAI Completions API for DeepSeek V4/4.1, Gemini, GPT-6/5, Qwen, Kimi, GLM, MiniMax, etc.).
  - Subscription plan gating (GOAT, Pro, Max) and automatic credit bypass rules when on-demand credits exist.
  - Multi-account pooling with transparent 429 rate limit failover.
  - Live quota, monthly pool, and 5-hour/weekly burst window tracking via `/usage` and interactive footer status bar.
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
- **Dynamic OpenAI Codex Discovery & Plan Filtering**: Automatically discovers newly available models from OpenAI's live Codex catalog, including their context windows, input modalities, and reasoning levels, without waiting for Pi's bundled catalog to update. Detects your ChatGPT plan tier from your OAuth token and filters unavailable or hidden models from `/model` and `pi --list-models`, with cached discovery for offline startup.
- **Cloudflare Workers AI Model Filtering**: Preserves Pi's native Workers AI authentication and streaming while checking Cloudflare's live model catalog and Workers subscription. Models explicitly requiring Workers Paid are hidden unless an active paid subscription is identified; if the plan is unknown, they remain hidden. If catalog discovery fails, unverified models are hidden. Models without the paid flag are not assumed guaranteed accessible. Configure the token with Workers AI Read and Billing Read. This filter applies to direct Workers AI, not the separate AI Gateway provider; gateway credits do not unlock models on the direct route.
- **Workers AI Usage**: `/usage` and the footer show account-wide neurons since 00:00 UTC against the 10,000 daily free allocation. Analytics can lag; Paid usage beyond the allocation is billable, not a hard cap. Configure Pi's `cloudflare-workers-ai` API key and `CLOUDFLARE_ACCOUNT_ID` (or their environment equivalents). The token needs Account Analytics Read; Billing Read enables plan detection. Missing permissions or failed analytics remain unavailable rather than zero.
- **Multi-Account Support & Auto-Failover**: Pool multiple accounts per provider (Google Antigravity, OpenAI / ChatGPT subscriptions, OpenAI Codex, Command Code, Kenari). Always prefer the highest healthy tier eligible for the requested model; lower tiers are fallback-only, and selection returns to higher tiers when they recover. Session affinity and weekly reset-pace balancing apply within the preferred tier, with automatic OAuth token refresh and transparent failover on 429 / quota exhaustion. ChatGPT priority: Enterprise > Business/Team > Pro > Plus > Go > Free. Unknown tiers and PAYG accounts remain fallback candidates.
- **Provider Quotas with Reset Pace Markers**: Live multi-account quota monitoring via `/usage` showing usage percentage, plan tier, reset countdowns, and real-time reset progress markers (`┃`) on the usage bar.
- **Autonomous Git Assistant (`/git`, `/commit`)**: Inspects staged changes using an isolated, in-memory sub-agent with specialized diff-sampling tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`), supports atomic multi-stage commits, PR generation (`/git pr`), smart branching (`/git branch`), merge conflict resolution (`/git resolve`), release drafting (`/git release`), and instant zero-token helpers (`/git sync`, `/git undo`).
- **Terminal Output Compressor (`tools/compressor/`, `/gain`, `/recall`)**: Native in-process port of RTK (Rust Token Killer) features without requiring external binaries or command rewriting. Hooks into Pi's `tool_result` event, compressing 60–90% of raw terminal noise (collapsing passing test suites, condensing git status/push/diff, pruning linter squiggles, stripping progress meters, and deduplicating repetitive logs). Stores full uncompressed outputs in an LRU buffer accessible via `/recall <id>` and provides token reduction statistics via `/gain`.
- **Automatic Session Titles**: Uses a configurable model to create a concise, action-oriented title (up to 36 characters) from the first user message, with toggles and model selection in `/settings-enhanced`. In the Discord gateway, the generated name is also applied to its server thread.
- **Continue Shortcut (`.` Continue)**: Pressing `.` (literal dot only) immediately resumes agent work on the most recent intent without summarizing, asking for confirmation, or leaving any user message bubble in the chat transcript.
- **Safe Plan Mode & Implement Mode (`/plan`, `/implement`)**: Read-only exploration and planning mode inspired by Claude Code and Codex CLI. Keeps tool schemas byte-stable over the wire to guarantee **100% prefix prompt cache hit rates**. Blocks mutating tools (`edit`, `write`) and destructive shell commands (`rm`, `git commit`, `npm install`, `>`, etc.) while keeping inspection tools active (`read`, `find`, `grep`, `web_search`, `web_fetch`, `ask_user`, safe `bash`). Supports hotkey toggling via `Ctrl+Alt+P` or `Alt+M`, `/plan [prompt]`, `/implement [prompt]`, `--plan` CLI flag, and live footer mode indicator (`■ plan` / `▶ implement`).
- **Live Turn Telemetry in the Working Status**: The `Working` indicator shows elapsed time plus real-time per-run metrics appended inline — cumulative tokens in/out (`↑15.2k ↓3.1k`), time-to-first-token (`TTFT 0.9s`), and decode throughput (`38 tok/s`). Counters sum every turn and model call while the agent is still working and reset once the run settles.
- **Settled Turn Summary in the Transcript**: Once the agent finishes its final turn, a compact telemetry line is printed into the transcript right after the response — total elapsed time, total tokens in/out (`↑15k ↓3.0k`), average TTFT across every model call (`TTFT avg 1.0s`), and average decode throughput (`50 tok/s avg`). Stored as a session entry (never sent to the model) and expandable to reveal the model-call count.
- **Codebase Scout Search Engine (`tools/scout/`, `/scout-health`, `/scout-rescan`)**: 100% pure TypeScript port of FFF concepts. Replaces standard `find` and `grep` with memory-cached, typo-tolerant search tools (`find`, `grep`). Features Smith-Waterman fuzzy matching, definition-first ranking, unified single and multi-pattern (`patterns: [...]`) OR search in a single pass, git recency awareness, and strict output budgeting with match-centered line truncation (`…match…`) to prevent context blowup.
- **Unified Multi-Provider Web Search & Fetch (`tools/web/`)**: Native `web_search` and `web_fetch` tools. Supports Brave Search, Tavily, Google Antigravity Grounding, TinyFish, Exa, and Parallel. Features transparent multi-engine failover, Google-style syntax parsing (`site:`, `before:`, `after:`, `-exclusions`, `"quotes"`), clean Markdown extraction with anti-bot/SPA handling, strict token budgeting, and API key management directly via `/login` (`/login brave`, `/login tavily`, `/login exa`, `/login parallel`, `/login tinyfish`).
- **Autonomous Isolated Subagent Routine (`tools/subagent/`, `/subagent`, `/jobs`)**: In-process subagent execution powered by in-memory sessions (`SessionManager.inMemory`). Defaults to non-blocking background execution (or synchronous blocking with `background: false` / `/subagent --sync`). Automatically inherits the active model and thinking effort of the parent session, executes with focused system instructions, guardrails (max turns & timeouts), enhanced tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `web_search`, `web_fetch`, `escalate`), structured escalation back to the parent agent, context budgeting, cleanly coordinated follow-up delivery into the parent session, and full lifecycle control (`subagent_list`, `subagent_status`, `subagent_cancel`, `/jobs`).
- **Interactive User Feedback Tool (`tools/feedback/`)**: Direct, native user feedback tool exposing `ask_user`. Supports open-ended and choice questions, custom typed responses, multi-question flows with review/edit, and cancellation/timeouts. Uses Pi's interactive questionnaire in TUI and Discord select menus, buttons, and text-entry modals through the gateway.
- **Pi Auth Sync**: Automatically imports credentials from `~/.pi/agent/auth.json` into the accounts pool and syncs the active healthy account back to `auth.json`.

## Retired providers

Charm Hyper has been removed because its usage, quota, and reset data cannot be fetched reliably enough to meet this package's provider requirements. On the next extension load, saved Hyper credentials, pooled accounts, session bindings, and model/quota caches are automatically deleted; other providers and conversation history are preserved. `HYPER_API_KEY` is no longer used—remove it from your shell configuration if set. Select another provider if your default model used Hyper.

## Usage

### 1. Install Extension Globally

```bash
pi install git:github.com/RaviEdho/pi-enhanced
```

Verify installed packages:

```bash
pi list
```

### Background Discord Gateway

1. Create a Discord application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable the **Message Content Intent** and invite the bot with View Channels, Read Message History, Send Messages, Create Public Threads, Send Messages in Threads, and Manage Threads permissions (needed to apply generated titles to threads).
2. Enable Developer Mode in Discord and copy your Discord user ID, server channel IDs where the bot may respond, and (optionally) the home notification channel ID.
3. In an interactive Pi session, run `/discord` or `/discord setup`. If no gateway is configured, `/discord` opens setup; otherwise it opens a status-and-actions menu. On first setup, enter the bot token, allowlisted user IDs, allowlisted channel IDs, an optional home notification channel ID, and workspace directory. The home channel receives gateway start, restart, stop, and failure notices; the bot needs permission to view and send messages there. The workspace defaults to `~/pi-workspaces/discord-gateway` and setup offers to create it; existing configurations keep their saved workspace. This is a starting directory, not a filesystem sandbox. Enter comma-separated IDs, or `*` by itself to allow everyone in that list; the setup UI explains both wildcard fields and asks for confirmation when either is used. A user wildcard permits DMs from any Discord user, while a channel wildcard permits server mentions in any channel (the user allowlist and bot-mention requirement still apply). Reconfiguration can reuse the saved token or accept a replacement. To avoid typing the token into the TUI, set `PI_ENHANCED_DISCORD_BOT_TOKEN` before starting Pi. Setup verifies the token and stores it in `~/.pi/agent/discord-gateway/config.json` with private file permissions.
4. Run `/discord start`. The gateway runs as a detached background process and continues after the interactive Pi session closes.

In DMs, allowlisted users can message the bot directly. In servers, both the user and channel must be allowlisted, and a top-level message must mention the bot; the gateway creates a thread for that conversation. Replies in a gateway-created thread continue one **shared session for all allowlisted participants**, without another mention. Every message is labeled with its author's username and stable Discord user ID; the agent treats different IDs as distinct people by default and keeps their preferences and approvals attributed separately. DMs remain isolated per user. Existing threads continue from the thread starter's saved session, preserving its history, workspace, model, and thinking level; other participants' old separate sessions remain on disk but are not merged or automatically read. Only accepted messages enter the shared history—earlier Discord messages are not backfilled. Sessions are stored under `~/.pi/agent/discord-gateway/sessions/`. Setup captures the currently selected Pi model and thinking level when available; otherwise, new sessions use Pi's configured defaults. The gateway forwards up to four uploaded PNG, JPEG, GIF, or WebP images per message (10 MiB each, 20 MiB total) to Pi; the selected model must support image input.

Reply to someone's message and mention the bot in your reply to include that message's text, author, and attachment links as quoted context. This also works in DMs and existing gateway threads. Only the directly replied-to message is included, not its reply chain or channel history; linked attachments are not automatically downloaded. If the original message was deleted or cannot be read, the agent is told it is unavailable rather than guessing. The bot needs **View Channel** and **Read Message History** permissions.

Every gateway Pi session receives the running extension's root and gateway source paths in its system prompt, plus `PI_ENHANCED_EXTENSION_ROOT` in its environment. The daemon discovers the location from its own module URL and resolves symlinks; it is not hardcoded or inferred from the workspace. This also applies when resuming saved conversations. Restart an already-running gateway once to enable it.

Open **Settings** from `/discord`, or run `/discord configure`, to edit the bot token, allowed users, allowed server channels, notification channel, workspace, default model, and DM/server message access. **Default model** opens a searchable list of Pi's available models; choose **Pi default** to clear the override. The saved choice is the default for new conversations. Once a conversation has saved workspace metadata, restarts preserve its selected model and thinking level. If the gateway is running, run `/discord restart` to apply it. This does not change the model in your foreground Pi session. In an active gateway DM or gateway-created thread, use the `/model` and `/thinking` Discord slash commands; their arguments autocomplete from that Pi session's available models and thinking levels as you type. Submit `/model` without a value to open a paginated model picker, or select a model from autocomplete. Selecting a model applies it only to that conversation session. In server threads, all allowlisted participants share the workspace, model/thinking settings, and `/commit` target; any allowlisted participant can change them or initiate a command. Interactive prompts and approval controls remain restricted to the participant who initiated that action. You can also run the `/sethome` slash command directly in any Discord server channel (or thread) to set that channel as the home notification channel. Turning an access path off makes the gateway ignore messages from that path; existing configurations default both paths to on. You can also use `/discord status`, `/discord restart`, `/discord stop`, and `/discord logs`. A Discord agent can call `discord_gateway_restart` after updating code: the gateway stops accepting new work, finishes accepted messages (including delivering the requesting reply), then starts a replacement process from the same extension path. Conversation history is persisted, so the thread resumes on its next message after reconnect. New messages received during the drain are asked to be retried after reconnect. The first time you install this self-restart feature, restart once from the foreground Pi session with `/discord restart`; an already-running older gateway cannot use functionality it has not loaded yet. Ensure code edits target the extension path actually loaded by Pi—the gateway does not automatically copy changes from a separate workspace checkout. Choose **Remove configuration** in the menu, or run `/discord teardown`, to stop it and remove the saved local bot token/config while keeping session history and logs. This does not revoke the token in Discord. The process does not automatically restart after a machine reboot.

Discord agents can call **`set_working_directory`** with `{ "path": "/path/to/project", "reason": "Work on the requested project" }` to change that conversation's actual workspace. The agent is steered to identify the intended project and switch autonomously before edits, builds, or Git operations; it asks if the project is ambiguous. Absolute paths, `~/`, and paths relative to the current cwd are supported. The directory must already exist and be accessible. A shell `cd` does not change session cwd. The tool schedules the switch, then the gateway waits for settlement, stops only that conversation's Pi child, forks its full saved history into the target workspace, reloads project instructions/resources, and automatically continues the unfinished task. Other conversations and the global workspace default are unchanged. The selected cwd and exact session file survive idle eviction and gateway restarts. Wait for background subagents to finish or cancel them first. This tool is Discord-only, not a local Pi cwd override; restart the gateway once after updating to enable it.

Use the Discord **`/commit`** slash command in a gateway DM or conversation thread to run the extension's isolated Git assistant without adding a normal agent turn to the conversation. Its optional `args` field accepts instructions (for example, `fix login timeout`) and flags (`-u` for unstaged changes, `-s` for one commit, `-m` for atomic commits). Requests queue behind other work in that conversation and operate on the agent's current working directory, including changes made with `set_working_directory`, not the gateway's configured directory or extension source repository. The command shows the target workspace when it starts; queued requests use the workspace selected by preceding work, and restored conversations retain their saved workspace. Each commit run uses one live Discord card showing the workspace: staging questions, proposals, editing prompts, and results replace that card in place instead of posting new screens. Completed runs remain in chat history. While the commit agent works, the card shows its live status, elapsed time, token/cost usage, and recent actions, refreshing at most once every two seconds. Review prompts and final results appear immediately. Proposal cards offer **Commit**, **Commit & Push**, **Edit**, and **Cancel** buttons; long proposals and results have page controls so no file or commit details are truncated. Editing opens a Discord modal (plans over Discord's 4000-character editor limit must be narrowed before editing). Nothing is committed until you approve. Dismiss a prompt to cancel. The gateway's Pi process must have pi-enhanced loaded. Restart the gateway after updating to register the new command; Discord may take time to refresh global commands.

Normal Discord messages received while the agent is responding wait in the conversation queue. Use Discord **`/steer message:<instruction>`** in a gateway thread or DM to send an instruction directly to the active Pi run instead. Pi applies steering after the current assistant turn finishes its tool calls, before the next model call; this does not cancel running tools. Any allowlisted thread participant can steer the shared run, and the instruction is labeled with that participant's identity without transferring ownership of existing prompts or approvals. `/steer` requires an active agent run; idle conversations, `/commit` workflows, workspace handoffs, and gateway restart drains do not accept steering. Restart the gateway after updating to register `/steer`.

Use Discord **`/stop`** in an active gateway thread or DM to force stop its currently running agent, including a `/commit` workflow. Any allowlisted thread participant can stop the shared run. Cancellation bypasses the conversation queue and also works while the gateway drains for a restart. It stops only that conversation's Pi process; saved history/workspace remain available for the next message. Already queued requests are not cancelled, and completed file changes or commits are not undone. Restart the gateway after updating to register `/stop`.

**Security:** Authorized Discord users can use Pi's configured tools, including file edits and shell commands, without a local approval prompt. Avoid `*` unless you intentionally want to open that allowlist to everyone; using `*` for users can expose the agent to any Discord user who can reach the bot. Project-local Pi resources are trusted for the configured workspace and any directory selected through `set_working_directory`; changing cwd may load that project's executable extensions and MCP configuration. Directory switching is not a sandbox. The gateway stores conversation history locally; treat it as sensitive.

### 2. Log in to Providers

```bash
# In an interactive Pi session:
/login google-antigravity

# Or login to Command Code (choose account or API key):
/login commandcode

# Or login to Kenari:
/login kenari

# Or log in to Ollama Cloud:
/login ollama-cloud
```

Credentials and tokens are stored in `~/.pi/agent/auth.json` and refreshed automatically where supported. You can also export `COMMANDCODE_API_KEY="sk-cmd-..."`, `KENARI_API_KEY="kn-..."`, or `OLLAMA_API_KEY` directly.

### 3. Running with Models

```bash
# Interactive mode with Command Code
pi --model commandcode/claude-sonnet-5-5
pi --model commandcode/deepseek/deepseek-v4.1-flash
pi --model commandcode/google/gemini-3.7-flash

# Interactive mode with Kenari
pi --model kenari/deepseek-v4-1-flash:free
pi --model kenari/kenari-free
pi --model kenari/claude-haiku-5-5

# Interactive mode with default Antigravity model
pi --model google-antigravity/gemini-3.1-pro

# Using Claude Sonnet 4.6
pi --model google-antigravity/claude-sonnet-4-6

# Non-interactive query
pi --model google-antigravity/gemini-2.5-flash -p "Summarize git status"
```
### 4. Check Provider Quotas and Usage

Run `/usage` to view live quotas, progress bars, and reset times across all accounts. Accounts stack vertically within each provider. In the TUI, providers fill each column top-to-bottom before flowing into the next column when the dialog body is full. Provider blocks stay together; oversized blocks and overflow beyond the available columns remain vertically scrollable. Narrow terminals and plain-text output use a single column:

```bash
# In interactive Pi session:
/usage

# Or from terminal:
pi -p "/usage"
```

Custom TUI dialogs share a titled header, optional right-aligned metadata, and a keyboard-hint footer. Their total height is capped at **24 rows** or **terminal height minus 4 rows**, whichever is smaller (centralized in `ux/dialog.ts`). Action buttons and input controls stay pinned below the scrollable content, above the keyboard hints; the selected `→` row remains visible. Use `PgUp`/`PgDn` to scroll content in forms and selectors, or `↑`/`↓` in viewers. In fullscreen mode, mouse-wheel/trackpad events over custom dialogs scroll their content without leaking into the transcript; settings lists retain native wheel navigation. Pi-native dialogs and Discord's RPC-rendered dialogs are unchanged.

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
- **Interactive TUI Controls**: Re-analyze in real time with `r`, trigger manual compaction with `c`, scroll with `↑`/`↓` or `PgUp`/`PgDn`, and close cleanly with `Esc` or `Enter`. Content stays inside the shared height-bounded dialog.

### 6. Enhanced Settings (`/settings-enhanced`)

Configure `pi-enhanced` subsystems interactively or via CLI commands:

```text
/settings-enhanced            # Open interactive SettingsList modal in TUI mode
/settings-enhanced list       # Print all current settings and disk config path
/settings-enhanced get <key>  # Inspect single setting value
/settings-enhanced set <key> <value>  # Set setting (e.g. set compressor.enabled false)
/settings-enhanced reset      # Reset all settings to defaults
```

Configurable options include:
- `scout.enabled`: Scout Search Tools (`find`, `grep`) with session cache memory (`enabled` / `disabled`)
- `scout.interceptShell`: Scout Shell Interceptor - shell grep/find/rg interception & scout steering (`enabled` / `disabled`)
- `web.enabled`: Web Access Tools - multi-provider search & extraction (`web_search`, `web_fetch`) with session cache memory (`enabled` / `disabled`)
- `subagent.enabled`: Subagent Tools - isolated in-process subagent execution (`subagent`, `/subagent`, `/jobs`) with session cache memory (`enabled` / `disabled`)
- `subagent.defaultMode`: Subagent Default Mode - default execution mode (`background` / `sync`)
- `feedback.askUser`: Ask User Tools - interactive clarification & 3-choice decision tool (`ask_user`) with session cache memory (`enabled` / `disabled`)
- `compressor.enabled`: Output Compressor - terminal noise reduction for bash/powershell (`enabled` / `disabled`)
- `git.commitModel`: Model used by `/commit` and `/git commit` (choose an available model or `session`; defaults to the active session model)
- `usage.showFooter`: Live quota bars and elapsed time progress in footer (`enabled` / `disabled`)
- `usage.contextFormat`: Context usage format in footer (`pi-enhanced` tokens e.g. 45k/200k, `pi` percentage e.g. 23.5%/200k, or `off`)
- `timer.showSummary`: Settled turn telemetry in transcript (`enabled` / `disabled`)
- `timer.showWorkingTelemetry`: Live working spinner duration, token count & speed telemetry (`enabled` / `disabled`)
- `continue.dotShortcut`: Single dot `.` prompt continue shortcut (`enabled` / `disabled`)
- `session.autoTitle`: Generate one concise, action-oriented title from the first user message (`enabled` / `disabled`; extra model call)
- `session.titleModel`: Model for title generation; choose `session` or an available `provider/model`
- `balancer.failoverOn429`: Automatic failover on HTTP 429 rate limits (`enabled` / `disabled`)
- `balancer.paceBalancing`: Quota pace balancing across multiple accounts (`enabled` / `disabled`)

Settings persist to `~/.pi/agent/enhanced-settings.json`. Use `/settings-enhanced set git.commitModel session` to restore the default session model.

### 7. Safe Plan Mode & Implement Mode (`/plan`, `/implement`)

Explore and design code solutions safely before committing to file modifications, with zero prompt cache breakage:

```text
/plan                         # Toggle between Plan Mode and Implement Mode
/plan <prompt>                # Enable Plan Mode and immediately start planning <prompt>
/implement                    # Switch back to Implement Mode (restores edit/write tools)
/implement <prompt>           # Switch back to Implement Mode and execute <prompt>
```

- **Keyboard Shortcut**: Press `Ctrl+Alt+P` or `Alt+M` to toggle modes at any time.
- **CLI Startup Flag**: Start Pi in Plan Mode with `pi --plan`.
- **Status & Textbox Sync**: The terminal footer displays `■ plan • ~/dir` or `▶ implement • ~/dir`, and the input textbox border dynamically reflects reasoning effort across both modes.
- **Human-in-the-Loop Approval Gate**: When a plan is drafted, an interactive menu presents:
  - `Execute plan`: Automatically switches to Implement Mode and launches execution of step 1.
  - `Refine plan`: Prompts for adjustments while remaining safely in Plan Mode.
  - `Stay in plan mode`: Keeps exploring or asking questions.
- **Cache-Safe Sandboxing**: Tool schemas are never altered dynamically, ensuring prefix caching remains completely intact.

### 8. Autonomous Git Assistant (`/git`, `/commit`)

Run `/git` or `/commit` to autonomously inspect changes and manage git workflows:

```text
/git                          # Interactive status hub & workflow launcher
/git commit                   # Autonomous commit (same as /commit)
/commit                       # Shorthand alias to /git commit
/commit "fix login timeout"  # Agent selects relevant files/hunks, then shows a commit proposal
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

- **Instruction-Based Selective Commits**: With `/commit <instruction>`, the instruction goes directly to the isolated agent without the staged/unstaged choice prompt. The agent selects relevant whole files or numbered diff hunks; other changes and their staged/unstaged state are preserved. You still review the proposal before committing.
- **Unstaged Commit Isolation**: With `/commit` and no instruction, when both staged and unstaged changes are detected, choose "Commit only unstaged changes (stash staged)" or pass `-u` / `--unstaged`. Your manual staged changes are safely preserved in git stash while the unstaged changes are committed, and restored to the index automatically upon completion or safely rolled back on cancel.
- Spins up an isolated sub-agent with zero conversation context bloat.
- Transparent live progress and recent action logging in the status box.
- Only pulls overview statistics and diffs for key changed files, omitting lockfiles and huge generated assets.
- Full token usage and cost accounting displayed in the confirmation dialog, CLI output, and completion notification.
- Interactive proposal review with full message preview (header & body), detailed file diff metrics, direct commit (`c`), commit & push (`p`), edit (`e`), or cancel (`Esc`).

### 8. Web Search & Web Fetch

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

### Interactive User Feedback (`ask_user`)

The extension gives the LLM direct access to user input dialogs during execution via the unified `ask_user` tool:

- **Freeform Text Input**: When called with a `question` (and optional `placeholder`), prompts the user inside a native TUI input box (`ctx.ui.input`). Ideal for gathering missing tokens, URLs, file paths, or custom requirements.
- **3-Choice Decisions**: When called with `choices: ["Option 1...", "Option 2...", "Option 3..."]`, displays an interactive selector (`ctx.ui.select`). Automatically includes a `✎ Type custom answer...` option for typing an alternative choice. Dismissing with `Esc` cancels cleanly.
- **Multi-Question Questionnaires**: When called with `questions: [{ question, choices?, placeholder? }, ...]`, prompts the user sequentially through each question in a single tool turn (e.g. `[1/3] Question...`). Preserves already answered questions even if the user cancels midway. Fully safe and functional in Plan Mode.

#### Enabling / Disabling `ask_user`:
The tool is enabled by default, but can be completely disabled via `/settings-enhanced`:
```text
/settings-enhanced set feedback.askUser disabled
```
- When disabled, the tool definition is completely removed from the model's active tool list and prompt instructions.
- **Session Memory & Cache Protection**: Just like Pi remembers model selections on past sessions, toggling `feedback.askUser` applies to **future/new sessions**. Resuming an existing long session automatically remembers its initial tool configuration, preserving 100% prefix prompt cache hits on past conversations!
- **Prompt Cache Warning Gate**: If you explicitly disable `ask_user` mid-session when the active context has at least 10,000 tokens (`≥ 10k`), an explicit warning modal prompts for confirmation to prevent accidental prefix prompt cache invalidation and token cost spikes.

## Development

```bash
# Typecheck TypeScript files
npm run typecheck

# Test directly without installing
pi -e ./index.ts --model google-antigravity/gemini-2.5-flash -p "hello"
```
