# pi-enhanced

Enhanced Pi extension package providing the **Google Antigravity** provider, **Command Code** provider, **Kenari**, **Token Harbor**, and **InferHub** AI gateway providers, dynamic OpenAI Codex plan filtering, autonomous commit workflows, terminal output compression, codebase search, and multi-provider web search.

## Features

- **Background Discord Agent Gateway (`/discord`)**: Run a detached Discord bot independently of the interactive Pi terminal. DMs and server threads are restricted to configured user/channel allowlists; a bot mention in an allowlisted server channel creates a thread with a durable, per-thread/per-user Pi session. The gateway uses your configured Pi model, extensions, and tools, routes Pi UI questions through Discord buttons, select menus, and text-entry modals, renames new threads to their generated session title when available, and offers the `discord_gateway_restart` tool for deferred self-restarts after code changes.
- **Ollama Cloud Provider**:
  - Sign in with `/login ollama-cloud` or set `OLLAMA_API_KEY`. Discover cloud models and their tool, vision, thinking and context metadata dynamically.
  - On login, the account plan and purchased balance are checked. Free accounts without purchased credits hide models observed to be restricted in a Free-account probe; paid plans or accounts with purchased credits retain the full catalog. Unknown access is not hidden. The snapshot is an observation, not an Ollama entitlement guarantee.
  - `/usage` and the quota footer show included and purchased balances or legacy limits when reported. Model prices are estimates parsed from Ollama's pricing page; unknown rates use Pi's required numeric zero placeholders and are labeled unknown or incomplete. Output limits are estimates. Actual billing can differ, including off-peak rates.
  - Ollama's catalog is public and is not known to filter by account entitlement. Native model-specific thinking controls are not currently mapped to Pi's effort slider.
- **InferHub Marketplace Provider (experimental)**:
  - Sign in with `/login inferhub` using an **inference-only** key, or set `INFERHUB_API_KEY`. Only consumer inference endpoints are called; management access, publisher credentials, and MCP are not required. The selected key is used without automatic key rotation.
  - Authenticated `/v1/models` discovery supplies explicit text-output routes, context/output limits, image-input support, and exact reasoning tiers. Aliases, combos, non-text outputs, and routes with incomplete limits/modalities are omitted. There is no hardcoded catalog. Every online discovery refresh fetches a new upstream catalog, even when the cached snapshot is fresh; offline startup and temporary failures use the last successful key-scoped snapshot. Discovery authorization failures clear that key's snapshot. Open `/model` to refresh after first configuring a key.
  - Uses Pi's OpenAI Chat Completions streaming implementation for text, tools, reasoning output, and cancellation. `X-Session-Id` preserves conversation routing; reasoning uses strict per-route tiers. Pi's `off` sends `none` only when explicitly supported; otherwise no disable claim is made. Raw API calls without an effort leave the upstream default unchanged.
  - Local costs use the server's final streaming `usage.cost` total, **zero when missing**; input/output/cache cost splits remain zero because they are not supplied. These are not ask-price estimates, and zero does not imply free inference. Actual cost availability, tools, and protocol compatibility still need authenticated live verification. Set price caps/budgets in InferHub's dashboard: cheapest asks are not guaranteed execution prices and paid calls have a $0.00001 minimum. The extension never changes billing settings.
  - `/usage` and the footer share a read-only `/v1/me/usage` balance lookup, cached for a minute. Balance is a named USDC value, not a quota bar or reset allowance. Known-zero balance is shown in `/usage` and hidden in the footer. Failed refreshes retain successful data; `/usage` shows the error and stale age. Keys are identified by masked credentials, not inferred account identities or subscription tiers.
  - InferHub pools publisher-connected subscriptions/API accounts. Upstream resale authorization, model provenance, and upstream data handling are not independently verified. Some routes modify system prompts. Its privacy policy allows retention of flagged request text and security-rejected request scaffolding; use caution with sensitive code. No uptime or supply guarantee is assumed.
  - Sources audited November 15, 2026: [integration guide](https://inferhub.dev/docs), [API/OpenAPI](https://inferhub.dev/api/openapi.json), [pricing](https://inferhub.dev/pricing), [privacy](https://inferhub.dev/privacy), and [terms](https://inferhub.dev/terms). Cached catalogs record their source and fetch timestamp; no inference is generated to discover models or balances.
- **Token Harbor Provider**:
  - Sign in with `/login tokenharbor` using a Universal Key, or set `TOKENHARBOR_API_KEY`. Repeated logins add credentials to the multi-account pool; `/logout` uses the native-style account selector.
  - Credential-scoped `/v1/models` discovery is enriched from each exact model's public specification page. Models without verified chat/tool support, limits, modalities, or input/output/cache-read prices are omitted—no invented limits or static fallback catalog. Cache-write pricing is optional: an unknown rate uses 0 for Pi's cost estimates and is explicitly flagged as unknown in model metadata, not verified free. Every fresh API listing rebuilds the catalog, reconsidering skipped models and new IDs even within the 30-minute discovery cache window. Calls without a fresh listing may reuse that cache; public metadata remains cached for 24 hours. Offline startup uses the last successful credential-scoped snapshot.
  - Native OpenAI streaming preserves tools, reasoning output, images, cancellation, and token usage. The documented `reasoning.efforts` controls Pi's available efforts; `off` is offered only when `can_disable: true`. Unknown (`null`) and checked-none (`[]`/`false`) stay distinct; neither invents controls. `default_effort` is retained as metadata, not guessed or forced. Omitting an effort leaves the gateway's default; model names and accepted-but-ignored parameters are not capability evidence.
  - Strict Pass filtering uses the account's verified active `plan_name` and each exact ID's `covered_by_plans`. Only paid models covered by that Pass and explicit `:free` routes appear; unknown coverage, another Pass's models, and wallet-only models are hidden. Without a verified active Pass, only free routes remain. Wallet balances never expand access. Select explicit `:free` IDs for free routes: their coverage is correctly `[]` because they use a separate allowance. Enabling free-route data sharing remains a dashboard action; free-route content may be retained and used under the provider's terms.
  - `/usage` and the footer read live allowances through `GET /api/cli/free-tier` using the Universal Key. They show the verified Pass name, separate Pass/free percentages, and their shared seven-day reset window. Activated windows show elapsed markers even at zero usage; inactive windows have no invented timing. Exhaustion flags remain distinct from rounded percentages. Polling is shared per credential at most once a minute; failed refreshes retain the last successful report with an error and age in `/usage`. No browser credentials or inference calls are needed.
  - Coverage is kept only in short-lived, credential-scoped memory, not persisted as entitlement. Each paid request re-reads `/v1/models` and checks an active, non-exhausted Pass using allowance data cached for at most one minute; failures block paid calls. Before live Pass verification (including offline startup and cache-only `--list-models`), only verified cached free routes are listed. Open `/model` to refresh the live catalog; paid requests also verify access before sending. Discovery uses the bulk listing rather than individual model detail requests. The allowance response's separate model list is also not used for routing.
  - Wallet balance and the wallet-continuation setting remain unavailable. Client checks are not atomic billing guarantees: disable wallet continuation in the dashboard if required. No billing settings, model substitutions, or wallet fallback are enabled. Quota-pace balancing remains neutral; account selection respects verified model coverage, and conservative pre-content 429 failover never bypasses detected spending caps, billing, quota, or access errors.
  - Displayed costs are list-price estimates, not settled Pass/wallet charges; discounts and boosts can differ. Known complete long-context price tiers are applied when reported. MiMo V2.6 Flash exceeded small output caps in live probes; do not rely on such caps as a financial safeguard.
  - Sources audited November 8, 2026: [catalog/API](https://tokenharbor.ai/docs/api/models), [Pass rules](https://tokenharbor.ai/docs/billing/subscription), [key restrictions](https://tokenharbor.ai/docs/getting-started/universal-key), and [privacy](https://tokenharbor.ai/privacy). The [read-only allowance API](https://tokenharbor.ai/docs/api/allowance) was verified November 9, 2026; the catalog's reasoning and Pass-coverage contracts were verified November 11, 2026. Free-route detail/list parity, zero pricing, and both literal and encoded colon forms were verified November 12, 2026. Each cached model also records its exact public specification URL and verification timestamp.
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
  - Subscription plan gating (Go, GOAT, Pro, Max) and automatic credit bypass rules when on-demand credits exist. Go and free/no-subscription accounts route through Command Code's internal CLI gateway (`/alpha/generate`); free accounts are limited to the zero-cost catalog models and need at least $1 of credits to start a session.
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
- **Fast, Cache-First Startup**: Provider registration never waits for network requests. Startup uses cached catalogs (including an expired Codex snapshot) or existing offline fallbacks; Pi refreshes discovery in the background after its TUI/RPC interface initializes. Command viewers, web pipelines, and inference implementations load on demand. Settings and Discord model pickers can also request background refreshes; reopen them to see updates. `--offline` / `PI_OFFLINE` disable automatic catalog, billing, and quota requests.
- **Dynamic OpenAI Codex Discovery & Plan Filtering**: Automatically discovers newly available models from OpenAI's live Codex catalog, including their context windows, input modalities, and reasoning levels, without waiting for Pi's bundled catalog to update. Detects your ChatGPT plan tier from your OAuth token and filters unavailable or hidden models from `/model` and `pi --list-models`, with cached discovery for offline startup.
- **Cloudflare Workers AI**: Extension-specific model filtering and usage reporting have been retired. Pi's native provider and existing credentials are unaffected.
- **Multi-Account Support & Auto-Failover**: Pool multiple accounts per provider (Google Antigravity, OpenAI Codex, Command Code, Kenari, Token Harbor). Where verified plan and quota data exist, prefer the highest healthy tier eligible for the requested model; lower tiers are fallback-only, and selection returns to higher tiers when they recover. Session affinity and weekly reset-pace balancing apply within the preferred tier, with automatic OAuth token refresh and transparent failover on 429 / quota exhaustion. ChatGPT priority: Enterprise > Business/Team > Pro > Plus > Go > Free. Unknown tiers and PAYG accounts remain fallback candidates. Pi's native OpenAI provider is not managed by this extension; existing OpenAI credentials are left intact.
- **Provider Quotas with Reset Pace Markers**: Live multi-account quota monitoring via `/usage` showing usage percentage, plan tier, reset countdowns, and real-time reset progress markers (`┃`) on the usage bar.
- **Autonomous Git Assistant (`/git`, `/commit`)**: Inspects staged changes using an isolated, in-memory sub-agent with context-compressed, paginated diff tools (`git_overview`, `git_file_diff`, `propose_commit`, `propose_commits`), supports atomic multi-stage commits, PR generation (`/git pr`), smart branching (`/git branch`), merge conflict resolution (`/git resolve`), release drafting (`/git release`), and instant zero-token helpers (`/git sync`, `/git undo`, `/git discard`).
- **Terminal Output Compressor (`tools/compressor/`, `/recall`)**: Native in-process port of RTK (Rust Token Killer) features without requiring external binaries or command rewriting. Hooks into Pi's `tool_result` event, reducing raw terminal noise (collapsing passing test suites, condensing git status/push/diff, pruning linter squiggles, stripping progress meters, and deduplicating repetitive logs). Caches uncompressed tool-result text for `/recall <id>`. Conservative command routing protects chained/script output; diagnostic blocks and warning reports are retained, and a never-worse guard includes recall-hint overhead. Includes dedicated Bun/Deno and Go NDJSON handling.
- **Automatic Session Titles**: Uses a configurable model to create a concise, action-oriented title (up to 36 characters) from the first user message, with toggles and model selection in `/settings-enhanced`. In the Discord gateway, the generated name is also applied to its server thread.
- **Continue Shortcut (`.` Continue)**: Pressing `.` (literal dot only) immediately resumes agent work on the most recent intent without summarizing, asking for confirmation, or leaving any user message bubble in the chat transcript.
- **Safe Plan Mode & Implement Mode (`/plan`, `/implement`)**: Read-only exploration and planning mode inspired by Claude Code and Codex CLI. Keeps tool schemas byte-stable over the wire to guarantee **100% prefix prompt cache hit rates**. Blocks mutating tools (`edit`, `write`) and destructive shell commands (`rm`, `git commit`, `npm install`, `>`, etc.) while keeping inspection tools active (`read`, `find`, `grep`, `web_search`, `web_fetch`, `ask_user`, safe `bash`). Supports hotkey toggling via `Ctrl+Alt+P` or `Alt+M`, `/plan [prompt]`, `/implement [prompt]`, `--plan` CLI flag, and live footer mode indicator (`■ plan` / `▶ implement`).
- **Live Turn Telemetry in the Working Status**: The `Working` indicator shows elapsed time plus real-time per-run metrics appended inline — cumulative tokens in/out (`↑15.2k ↓3.1k`), time-to-first-token (`TTFT 0.9s`), and decode throughput (`38 tok/s`). Counters sum every turn and model call while the agent is still working and reset once the run settles.
- **Settled Turn Summary in the Transcript**: Once the agent finishes its final turn, a compact telemetry line is printed into the transcript right after the response — total elapsed time, total tokens in/out (`↑15k ↓3.0k`), average TTFT across every model call (`TTFT avg 1.0s`), and average decode throughput (`50 tok/s avg`). Stored as a session entry (never sent to the model) and expandable to reveal the model-call count.
- **Codebase Scout Search Engine (`tools/scout/`, `/scout-health`, `/scout-rescan`)**: 100% pure TypeScript port of FFF concepts. Replaces standard `find` and `grep` with memory-cached, typo-tolerant search tools (`find`, `grep`). Indexes the workspace on the first search (or `/scout-rescan`), not while Pi opens a session. Features typo-tolerant fuzzy matching, declared-symbol-aware definition ranking, stable bounded top-K filename ranking, unified single and multi-pattern (`patterns: [...]`) OR search in a single pass, git recency awareness, and strict output budgeting with match-centered line truncation (`…match…`) to prevent context blowup.
- **Unified Multi-Provider Web Search & Fetch (`tools/web/`)**: Native `web_search` and `web_fetch` tools. Supports Brave Search, Tavily, Google Antigravity Grounding, TinyFish, Exa, and Parallel. Features transparent multi-engine failover, Google-style syntax parsing (`site:`, `before:`, `after:`, `-exclusions`, `"quotes"`), clean Markdown extraction with anti-bot/SPA handling, strict token budgeting, and API key management directly via `/login` (`/login brave`, `/login tavily`, `/login exa`, `/login parallel`, `/login tinyfish`).
- **Autonomous Isolated Subagent Routine (`tools/subagent/`, `/subagent`, `/jobs`)**: In-process subagent execution powered by in-memory sessions (`SessionManager.inMemory`). Defaults to non-blocking background execution (or synchronous blocking with `background: false` / `/subagent --sync`). Automatically inherits the active model and thinking effort of the parent session, executes with focused system instructions, guardrails (max turns & timeouts), enhanced tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `web_search`, `web_fetch`, `escalate`), structured escalation back to the parent agent, context budgeting, cleanly coordinated follow-up delivery into the parent session, and full lifecycle control (`subagent_list`, `subagent_status`, `subagent_cancel`, `/jobs`).
- **Interactive User Feedback Tool (`tools/feedback/`)**: Direct, native user feedback tool exposing `ask_user`. Supports open-ended and choice questions, custom typed responses, multi-question flows with review/edit, and cancellation/timeouts. Uses Pi's interactive questionnaire in TUI and Discord select menus, buttons, and text-entry modals through the gateway.
- **Pi Auth Sync**: Automatically imports credentials from `~/.pi/agent/auth.json` into the accounts pool and syncs the active healthy account back to `auth.json`.

## Startup and UI performance

Credential helpers do not load browser OAuth implementations. Login, token refresh, and raw Antigravity token discovery load those implementations only when needed. The footer caches raw active-branch usage and context statistics until the session, branch, model, or relevant session events change; theme formatting, quota updates, and reset countdowns remain live.

Repeated display reads of settings and credentials share a 250ms file-check window. Local updates are immediate; explicit settings/usage commands, inference credential checks, and native logout synchronization bypass the polling window. External file edits are picked up on the next read after that window expires. Expired, missing, and corrupt Codex catalogs also coalesce metadata checks instead of repeatedly reading/parsing JSON; a successful discovery save updates the in-memory catalog immediately.

Scout honors Git ignore rules by default while retaining fixed exclusions (`node_modules`, build/cache directories, and most hidden directories). Configure `scout.respectGitIgnore` and `scout.includeHidden` in `/settings-enhanced`; changes apply on the next search. In Git workspaces, a read-only `git ls-files` call per scan evaluates nested `.gitignore`, negations, repository/global excludes and tracked exceptions. Non-Git workspaces or Git failures retain fixed exclusions. Explicit external/unindexed-directory searches retain their broad inspection behavior.

Reviewed upstream SHAs, adopted behavior, licensing boundaries, and the next-update procedure are recorded in [UPSTREAM.md](UPSTREAM.md).

Scout checks directory metadata on demand without filesystem watchers, reusing unchanged directory listings and refreshing file metadata only where needed. File contents use a memory-only LRU with a conservative 32MiB accounting budget and at most 4,096 entries; each reuse validates size, timestamps, and file identity. Directory listings and cached text are also revalidated on the next search after ten seconds, covering coarse filesystem timestamps. Files over 2MiB and known binary extensions remain excluded from content search. Explicit Git filters refresh Git status, `/scout-rescan` forces a full scan and clears cached text, and session shutdown/workspace replacement releases the active index. No cached file contents are written to disk.

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
2. Enable Developer Mode in Discord and copy your Discord user ID, server channel IDs where the bot may respond, and (optionally) the home notification channel ID. To enable DM history, also copy the bot DM's channel ID using Discord's Copy Channel ID action.
3. In an interactive Pi session, run `/discord` or `/discord setup`. If no gateway is configured, `/discord` opens setup; otherwise it opens a status-and-actions menu. On first setup, enter the bot token, optional allowlisted user IDs and channel IDs, an optional home notification channel ID, and workspace directory. Leave either allowlist blank to configure access later: omitted or empty user lists block all incoming messages; omitted or empty channel lists block server messages and explicit history/discovery, while DM messaging still uses only the user whitelist. In Settings, enter `off` to clear a list (blank keeps the current list). The home channel receives gateway start, restart, stop, and failure notices; the bot needs permission to view and send messages there. The workspace defaults to `~/pi-workspaces/discord-gateway` and setup offers to create it; existing configurations keep their saved workspace. This is a starting directory, not a filesystem sandbox. Enter comma-separated IDs, or `*` by itself to allow everyone in that list; the setup UI explains both wildcard fields and asks for confirmation when either is used. A user wildcard permits DMs from any Discord user, while a channel wildcard permits server mentions in any channel (the user allowlist and bot-mention requirement still apply). Reconfiguration can reuse the saved token or accept a replacement. To avoid typing the token into the TUI, set `PI_ENHANCED_DISCORD_BOT_TOKEN` before starting Pi. Setup verifies the token and stores it in `~/.pi/agent/discord-gateway/config.json` with private file permissions.
4. Run `/discord start`. The gateway runs as a detached background process and continues after the interactive Pi session closes.

In DMs, allowlisted users can message the bot directly. In servers, both the user and channel must be allowlisted, and a top-level message must mention the bot; the gateway then either creates a thread or answers directly in the channel, depending on the **Channel replies** setting in `/discord configure`. **Always start a thread** keeps the original behavior. **Always answer in the channel** never opens a thread for a new conversation. **Model decides** asks one cheap chat model whether the message needs multi-turn work (thread) or is a single factual question (channel), and falls back to a thread on any failure; each such decision costs one extra model call and roughly 1–4 seconds before the reply starts. Channel conversations use a shared default session per channel, separate from every thread, and reply to the message that mentioned the bot. Overnight rollover and explicit replies can select independent channel sessions (see below). Every new thread forks that parent channel's current default Pi conversation when available, including all participants' shared history, regardless of whether it was chosen by the model, a routing fallback, always-thread mode, or follow-up escalation. This also works after idle eviction or a gateway restart; without usable saved channel history, the thread starts fresh with the normal recent/reply context. Later channel and thread turns stay independent, and new mentions in the parent channel do not resume older threads. With **Tool escalation** on, a channel reply moves into a thread after the fact when that turn used editing, shell, delegation, or workspace tools; the new thread inherits the channel conversation instead of starting blank. **Follow-up escalation** is a separate switch: when on, the same user mentioning the bot again in that channel within ten minutes goes straight to a thread without asking the model; when off, every mention still gets a quick model decision. Read-only channel replies stay in the channel. Replies in a gateway-created thread continue one **shared session for all allowlisted participants**, without another mention. Every message is labeled with its author's username and stable Discord user ID; the agent treats different IDs as distinct people by default and keeps their preferences and approvals attributed separately. DMs remain isolated per user. Existing threads continue from the thread starter's saved session, preserving its history, workspace, model, and thinking level; other participants' old separate sessions remain on disk but are not merged. To keep replies grounded, each turn automatically includes up to the configured number of surrounding messages from the same channel (default 5, configurable 0–25, `0` disables it). When replying to a message, the history window is anchored immediately **before the replied-to message**, which is quoted separately; otherwise it is anchored before your new message. The bot's own messages and the anchor/current message are skipped. Non-replies include only context the gateway has not already delivered; explicit replies intentionally revisit older context even if newer messages are already in the session. Automatic context is treated as quoted context, not instructions, and disappears silently if the bot cannot read the channel. Only accepted messages enter the shared history—earlier Discord messages are not backfilled. Sessions are stored under `~/.pi/agent/discord-gateway/sessions/`. Setup captures the currently selected Pi model and thinking level when available; otherwise, new sessions use Pi's configured defaults. The gateway forwards up to four uploaded PNG, JPEG, GIF, or WebP images per message (10 MiB each, 20 MiB total) to Pi; the selected model must support image input.

**Channel session continuity:** Plain mentions use the channel's newest default session when routed to a channel reply. Replying directly to a tracked bot message resumes the session that produced it, including its latest subsequent history—not a rewind or a new branch. Explicit bot replies bypass routing-model/follow-up decisions, even in always-thread mode; reviving an older session never changes the default for plain mentions. All allowlisted participants can continue the same reply-linked session. Links survive idle eviction, workspace handoffs, and gateway restarts, including links for split replies, tables, narration, and image-tool responses; they are not automatically expired. Tracking starts after this update: earlier/untracked bot messages or unavailable source sessions produce an explicit notice and a separate fresh session with the direct quote, never an unrelated default session. DMs and existing threads keep their current behavior.

**Overnight rollover:** `/discord` → **Settings → Channel sessions** configures **Overnight rollover**, **Timezone**, **Reset hour**, and **Inactivity window**. Defaults for omitted settings are **on**, **the machine's detected timezone** (UTC if unavailable), **04:00**, and **6 hours**. Explicitly saved timezones, including older `Asia/Jakarta` settings, are preserved. At the daily boundary, a mention in the default session during the preceding six hours (including exactly 22:00), or running/queued work across the boundary, skips rollover for that entire day; the next opportunity is the following day's boundary. Eligibility is evaluated lazily on the next accepted channel mention, with decisions/activity persisted across restarts. A quiet night creates a fresh default without copying old conversation or summaries; workspace, selected model and thinking level are retained. Reply activity in the current default counts, but reviving older sessions does not keep the default alive. First use after upgrading conservatively keeps the legacy channel session until the next daily boundary. The schedule uses its explicit IANA timezone, independent of the daemon's timezone. Reset hour accepts 0–23; inactivity accepts 1–168 whole hours. Turning rollover off preserves reply-linked continuity. Saved fields are `channelSessions: { enabled, timezone, resetHour, idleHours }`; restart the gateway after changing settings. Saved sessions and reply links remain on disk; rollover does not delete history.

Reply to someone's message and mention the bot in your reply to include that message's text, author, and attachment links as quoted context. This also works in DMs and existing gateway threads. Only the directly replied-to message is included, not its reply chain; linked attachments are not automatically downloaded. The configured history window is taken from before the replied-to message and added alongside its direct quote, not from the latest discussion before your mention. If the original message was deleted or cannot be read, the agent is told it is unavailable rather than guessing. The bot needs **View Channel** and **Read Message History** permissions.

**Model failures and automatic fallback:** A terminal provider error is shown as a **Model unavailable** or **Model error** message with the failing model and a recognized, safe reason (for example, **Not available on free plan**), even when tool activity is hidden. Raw provider bodies, account lists, and credentials are never copied into these notices. After Pi finishes its own retries/account failover, an unavailable-model/plan/authentication failure before any tool work or public output can switch that conversation to the explicitly configured gateway **Default model**. The gateway shows the original error, verifies the selected replacement through RPC, and announces **Automatically switched model: old → new** before continuing the pending request once. Already accepted requests/images stay in history rather than being submitted again; a prompt rejected before acceptance retains its original payload for the retry. The replacement remains selected in that conversation; global defaults and other sessions are unchanged. Missing or identical defaults, failed/unconfirmed switches, cancellation, command workflows, prior tool work/public output, rate/usage/balance limits, context limits, and transient network/server errors do not trigger automatic retry. A failure of the replacement is shown without cycling through more models. Restart the gateway after updating to enable this behavior.

**Sending image attachments:** Ask the agent to send a photo, chart, or screenshot; its Discord-only `discord_send_image` tool uploads an actual attachment to the active DM, channel, or thread, with optional caption and accessible alt text. Sources can be files inside the conversation's current workspace (relative or absolute paths; symlink targets must also remain inside it), or public HTTPS image URLs. Supports PNG, JPEG, GIF, and WebP, validated by file signature; up to 10 MiB each, four upload attempts / 20 MiB per accepted request (failed attempts count). The bot needs **Attach Files** and the applicable send permission. Mentions are disabled. The tool cannot target another channel, access private-network URLs, or generate images itself. URL downloads are bounded, with checked/pinned DNS and up to three validated redirects. Images become visible to everyone with access to the destination; do not request private files unless you intend to share them. Restart the gateway after updating to enable the tool.

Discord REST uses a dedicated HTTP dispatcher so loading Pi's model-routing SDK cannot interfere with attachment uploads. Automatic transport/5xx retries are disabled to avoid duplicate messages after uncertain delivery; normal Discord rate-limit handling remains enabled.

**Tables:** Table rendering is **off by default**; replies send the original Markdown as text. When enabled, completed agent replies display top-level Markdown tables as locally rendered PNG attachments, with wrapped cells and repeated headers. Wide tables split into panels that repeat the first column; tall tables split into pages. By default images show only the table, with no added title/footer and no `.md` attachment. In `/discord` → **Settings → Tables**, **Render tables** (default **off**) turns conversion on or off. Off sends the original Markdown as text with no table images or `.md` files; it preserves your other table preferences. **Title and footer** toggles the table title, page numbering and range footer together; **Markdown attachment** independently adds the original `table-N.md` for copying text and links. Title/footer and Markdown attachment both default to **off**, including existing configurations; restart the gateway after changing any table setting. Surrounding explanation stays normal Discord text, in order. The bot needs **Attach Files** permission. Code blocks and tables nested in lists/quotes stay unchanged. Oversized tables or rendering failures fall back to the original text; failed or uncertain uploads show a warning and text instead of retrying images. No browser or external content is loaded, and terminal output/session history is unchanged. Restart the gateway after updating to enable this behavior.

**Silent turns:** In existing gateway server threads, the agent can use `discord_no_reply` when a message is clearly human-directed, an FYI, or an acknowledgment needing no response. Mentioning another person alone is not a rule to ignore you; clear agent requests still get replies. The tool ends only the current message silently, with no acknowledgment, narration, successful tool card, or empty-response fallback. The message and a short internal reason remain in session history; future messages remain active. It must be called alone before other tools or public output, and is unavailable for DMs, top-level channel mentions, slash-command workflows, or steered runs. Errors and cancellation remain visible. The model still reads the message and consumes tokens, and Discord typing may briefly appear. Working-status posts wait until the agent commits to responding or doing tool work. Restart the gateway after updating to enable this behavior.

**Channel history:** The Discord-only `discord_channel_history` tool uses the existing **Allowed channels** whitelist for history sources, including its `*` wildcard; there is no separate history list. In a DM, only the active requester's own DM with the bot can be read, and its channel ID must be listed or the whitelist must be `*`. DM messaging itself does not require the DM channel to be listed. In a shared gateway thread, the destination parent channel and source must both be allowed; sources must be server text, announcement, or ordinary voice channels in the same server, and both requester and bot must currently have View Channel and Read Message History. Voice channels additionally require Connect for both; the bot does not join voice. Cross-server channels, stage channels, and threads (including private threads) are never history sources. The gateway derives the requester from the active Discord turn, not tool arguments, and rechecks authorization around each fetch; missing permissions, membership, or configuration fail closed. Saved legacy `historyChannelIds` values are ignored. The tool reads at most 25 messages per page (20 by default), with an exclusive `before` cursor and truncated message text. It returns message metadata and attachment counts, never downloads attachments, and treats message content as untrusted data, not instructions. Whitelist changes are read from saved configuration for history checks on each request, while routing changes require the usual gateway restart.

**Channel discovery:** The Discord-only `discord_list_channels` tool is available in an active gateway server thread, not in DMs. It lists up to 50 same-server text, announcement, or ordinary voice channels (returned with type `voice`), with an explicit truncation notice if more qualify. Stage channels are excluded. The requester and bot must both have View Channel and Read Message History, and Connect for voice; discovery does not join voice; the destination parent and each listed channel must be in the existing Allowed channels list (or `*`). It derives the requester and server from the active turn and rechecks configuration and permissions using fresh Discord data. Channel names are untrusted. Results, including channel names and IDs, can be visible to every shared-thread participant and retained in the same places as history results, even when they cannot access the source. A steer from a different participant also disables discovery for the remainder of that run. Existing gateways must be restarted normally to load this feature; code changes do not restart them automatically.\n\nHistory tool results can be sent to the model provider and retained in Pi session files, subsequent conversation context, summaries, and Discord replies; shared-thread participants may see them, including participants who cannot read the source channel. A steer from a different participant disables history access for the remainder of the active run. Session files persist under the gateway sessions directory after eviction, restart, and `/discord teardown`; deleting them and any downstream copies is a separate operator responsibility. The daemon owns Discord API requests and uses a per-session authenticated local IPC endpoint, but this is a tool-level boundary, **not an OS sandbox**: Pi and its shell/extensions run as the same OS user and may read local config, IPC credentials, session files, or other credentials and bypass these checks. Only trust authorized users, agent tools, and code with that OS account's privileges.

Every gateway Pi session receives the running extension's root and gateway source paths in its system prompt, plus `PI_ENHANCED_EXTENSION_ROOT` in its environment. The daemon discovers the location from its own module URL and resolves symlinks; it is not hardcoded or inferred from the workspace. This also applies when resuming saved conversations. Restart an already-running gateway once to enable it.

Open **Settings** from `/discord`, or run `/discord configure` (or `/discord config`), to edit the bot token, allowed users, allowed channels, notification channel, workspace, default model, DM/server message access, **Tool call verbosity**, **Tool call visibility**, **Tables**, **Channel replies**, **Channel sessions**, and **Recent context**. **Recent context** sets how many recent messages from the same conversation are added automatically per turn (default **5 messages**; choose **Off** to disable it); messages already delivered to the session are not repeated for non-replies; explicit replies recover the older target's surrounding context. Channel replies defaults to **always start a thread**; choose **Model decides** to let a chat model route each new server conversation, then optionally pick its **Routing model**, set **Routing context**, and toggle **Tool escalation** and **Follow-up escalation** independently. **Routing model** offers **Cheapest available** (the default when `channelReplies.routerModel` is omitted), **Pi default** (`"pi-default"`, follows Pi's global saved `defaultProvider`/`defaultModel` at each decision), **Gateway default** (`"gateway-default"`, follows the gateway's configured `model`, or the cheapest authenticated chat model when unset), and an explicit `{ "provider": "...", "id": "..." }`. Default-following choices are not snapshots and do not follow a particular conversation's model. A missing Pi default or an unavailable explicitly selected/default model falls back to a thread, never silently substitutes another model. **Routing context** independently sets how many recent channel messages the router receives (default **5**, range **0–25**; **Off** disables only this history). It always receives the directly replied-to message when available, even with routing history off. Both router and main agent anchor history before the replied-to message for replies, or before your incoming message otherwise, while keeping their message counts separate. The saved field is `channelReplies.contextMessages`, separate from the main agent's `contextMessages`. The router uses quoted context to resolve references while prioritizing your current request; it does not receive the agent's full saved conversation. Router quotes are capped at 2,000 characters and recent history at 16,000 characters, with the usual per-message truncation and bot-message filtering. Reads are shared with the main agent, whose own context count stays independent. Already-delivered-message filtering still applies to non-reply agent turns; explicit replies bypass that filter to recover older context. Context loading shares the existing six-second routing deadline; unreadable context degrades gracefully, while routing timeouts still fall back to a thread. Adding context consumes more input tokens but does not add another model call. **Tool call visibility** independently enables tool info in server channels, threads, and DMs: by default **channels are off**, while **threads and DMs are on** (including existing configurations without this setting). It hides both tool activity/failure reports and intermediate assistant text accompanying tool calls, without changing tool execution, escalation, or final replies. The saved `toolCallVisibility` object uses boolean `channels`, `threads`, and `dms` fields. Where visibility is enabled, **Tool call verbosity** defaults to **full**, which posts intermediate assistant text accompanying tool calls and groups tool activity and failure reports into an activity message updated roughly every five seconds. **Tool only** shows the activity reports without intermediate assistant text; **none** suppresses both. Thinking blocks are never posted. Long runs use additional activity messages as needed; pending reports are also sent before prompts and final replies. Workspace-change notices and interactive prompts remain visible. Changes take effect after `/discord restart`. **Default model** opens a searchable list of Pi's available models; choose **Pi default** to clear the override. The saved choice is the default for new conversations. Once a conversation has saved workspace metadata, restarts preserve its selected model and thinking level. If the gateway is running, run `/discord restart` to apply it. This does not change the model in your foreground Pi session. In an active gateway DM or gateway-created thread, use the `/model` and `/thinking` Discord slash commands; their arguments autocomplete from that Pi session's available models and thinking levels as you type. Submit `/model` without a value to open a paginated model picker, or select a model from autocomplete. Selecting a model there applies it only to that conversation session. In an allowed server channel outside a thread, `/model` instead sets the gateway-wide default for future conversations immediately, without changing existing ones; its picker and confirmation are private. Any allowed user who can run the command there can change this default. In server threads, all allowlisted participants share the workspace, model/thinking settings, and `/commit` target; any allowlisted participant can change them or initiate a command. Interactive prompts and approval controls remain restricted to the participant who initiated that action. You can also run the `/sethome` slash command directly in any Discord server channel (or thread) to set that channel as the home notification channel. Turning an access path off makes the gateway ignore messages from that path; existing configurations default both paths to on. You can also use `/discord status`, `/discord restart`, `/discord stop`, and `/discord logs`. A Discord agent can call `discord_gateway_restart` after updating code: the gateway stops accepting new work, finishes accepted messages (including delivering the requesting reply), then starts a replacement process from the same extension path. Conversation history is persisted, so the thread resumes on its next message after reconnect. New messages received during the drain are asked to be retried after reconnect. The first time you install this self-restart feature, restart once from the foreground Pi session with `/discord restart`; an already-running older gateway cannot use functionality it has not loaded yet. Ensure code edits target the extension path actually loaded by Pi—the gateway does not automatically copy changes from a separate workspace checkout. Choose **Remove configuration** in the menu, or run `/discord teardown`, to stop it and remove the saved local bot token/config while keeping session history and logs. This does not revoke the token in Discord. The process does not automatically restart after a machine reboot.

Discord agents can call **`set_working_directory`** with `{ "path": "/path/to/project", "reason": "Work on the requested project" }` to change that conversation's actual workspace. The agent is steered to identify the intended project and switch autonomously before edits, builds, or Git operations; it asks if the project is ambiguous. Absolute paths, `~/`, and paths relative to the current cwd are supported. The directory must already exist and be accessible. A shell `cd` does not change session cwd. The tool schedules the switch, then the gateway waits for settlement, stops only that conversation's Pi child, forks its full saved history into the target workspace, reloads project instructions/resources, and automatically continues the unfinished task. Other conversations and the global workspace default are unchanged. The selected cwd and exact session file survive idle eviction and gateway restarts. Wait for background subagents to finish or cancel them first. This tool is Discord-only, not a local Pi cwd override; restart the gateway once after updating to enable it.

Use the Discord **`/commit`** slash command in a gateway DM or conversation thread to run the extension's isolated Git assistant without adding a normal agent turn to the conversation. Its optional `args` field accepts instructions (for example, `fix login timeout`) and flags (`-u` for unstaged changes, `-s` for one commit, `-m` for atomic commits). Requests queue behind other work in that conversation and operate on the agent's current working directory, including changes made with `set_working_directory`, not the gateway's configured directory or extension source repository. The command shows the target workspace when it starts; queued requests use the workspace selected by preceding work, and restored conversations retain their saved workspace. Each commit run uses one live Discord card showing the workspace: staging questions, proposals, editing prompts, and results replace that card in place instead of posting new screens. Completed runs remain in chat history. While the commit agent works, the card shows its live status, elapsed time, token/cost usage, and recent actions, refreshing at most once every two seconds. Review prompts and final results appear immediately. Proposal cards offer **Commit**, **Commit & Push**, **Edit**, and **Cancel** buttons; long proposals and results have page controls so no file or commit details are truncated. Editing opens a Discord modal (plans over Discord's 4000-character editor limit must be narrowed before editing). Nothing is committed until you approve. Dismiss a prompt to cancel. The gateway's Pi process must have pi-enhanced loaded. Restart the gateway after updating to register the new command; Discord may take time to refresh global commands.

Use Discord **`/git summary`** in a gateway DM or conversation thread to inspect changes and propose coherent commit topics. Its optional `scope` selects staged or unstaged/untracked changes; when both exist, leaving it blank opens a picker. The full summary is paginated with **Commit <topic>** buttons (for example, **Commit model failure fallback**). Selecting one forwards its detailed instruction to the same `/git commit <instruction>` workflow and opens final commit review; it does not approve or create a commit. Controls belong to the requester and expire or dismiss normally. Discord also supports **`/git commit`** with the same optional `args` as `/commit`, and **`/git unstage`** to unstage all changes without changing working-tree files or using the model. These commands use the conversation's current workspace. Restart the gateway after updating to register `/git`; Discord may take time to refresh global commands.

Use Discord **`/usage`** in a gateway DM, any allowed server channel, or a thread under an allowed channel to privately view all configured provider quotas and balances. In a gateway conversation it includes the current session's model and account where known and queues behind other work; elsewhere it reports without an active session. The report is ephemeral and visible only to the requester. User allowlists and DM/server access settings still apply. Restart the gateway after updating to register the command; Discord may take time to refresh global commands.

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

# Or log in to Token Harbor with a Universal Key:
/login tokenharbor

# Or log in to Ollama Cloud:
/login ollama-cloud
```

Credentials and tokens are stored in `~/.pi/agent/auth.json` and refreshed automatically where supported. You can also export `COMMANDCODE_API_KEY="sk-cmd-..."`, `KENARI_API_KEY="kn-..."`, `TOKENHARBOR_API_KEY`, or `OLLAMA_API_KEY` directly.

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

# Token Harbor: use the exact ID discovered for your key
pi --model tokenharbor/deepseek-v4.1-flash:free

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
- `scout.respectGitIgnore`: Honor Git ignore rules in workspace search (`enabled` / `disabled`, default `enabled`)
- `scout.includeHidden`: Index hidden workspace directories, retaining fixed exclusions (`enabled` / `disabled`, default `disabled`)
- `compressor.enabled`: Output Compressor - terminal noise reduction for bash/powershell (`enabled` / `disabled`)
- `git.commitModel` (Git Agent Model): Model used by `/commit`, `/git commit`, and `/git summary` (choose an available model or `session`; defaults to the active session model)
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

The TUI footer shows a live repository summary beside the branch, e.g. `(main +2 ~3 ?1 ↑1)`:
- `+` staged files, `~` unstaged tracked files, `?` untracked files, `!` merge conflicts; all indicators use the footer's dim color. Zero counts are hidden; with no changes or ahead/behind commits, only the branch is shown.
- `↑` / `↓` commits ahead of / behind the locally known upstream (no network fetch). Partially staged files count in both `+` and `~`; renamed files count once per category.
- Refreshes after tools finish and every 5 seconds, including external edits. Works with the quota footer enabled or disabled; outside a Git repository no summary is shown.

Run `/git` or `/git status` for a repository overview above the existing action menu: staged, unstaged, untracked, and conflicted file counts; upstream tracking with locally known ahead/behind counts; and the three latest commits. Detached HEAD, repositories without commits, and missing upstream comparisons are identified explicitly. This overview is read-only and does not fetch or use LLM tokens. In the TUI it uses the extension's shared bordered dialog: a scrollable overview, pinned action list, and keyboard hints, capped at 24 rows or terminal height minus 4. Use Up/Down to choose an action, Enter to select, PgUp/PgDn to scroll the overview, and Esc to close. RPC clients retain the native selector.

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
/git unstage                  # Unstage all changes; keep working-tree files unchanged
/git discard                  # Discard uncommitted tracked changes (staged + unstaged); untracked files are kept
/git discard --untracked      # Also delete untracked files and directories (ignored files are kept)
/git status                   # Interactive status overview
/git summary [staged|unstaged] # AI summary with selectable topic-based commit proposals
```

- **Change Summaries**: `/git summary` groups inspected changes into coherent commit proposals with **Commit <topic>** actions. Select a topic with `↑`/`↓` and `Enter` (or click it in fullscreen mode) to forward its detailed instruction to `/git commit <instruction>`, which re-inspects current changes and asks for final approval. `PgUp`/`PgDn` or the mouse wheel scroll the summary independently; `Esc` closes without starting a commit. Press `p` to close the dialog and print the entire summary and proposed commits in the transcript. The printed summary persists with the session but is not added to the model's context.
- **Unstage All**: `/git unstage` removes all staged changes from the index while preserving file contents, including new files (which become untracked). It covers the whole repository even when run from a subdirectory, works before the first commit, and does not move HEAD or discard merge/rebase state. The `/git` status menu offers this action when changes are staged. It requires no model call and reports when nothing is staged; arguments and paths are not supported.
- **Instruction-Based Selective Commits**: With `/commit <instruction>`, the instruction goes directly to the isolated agent without the staged/unstaged choice prompt. The agent selects relevant whole files or numbered diff hunks; other changes and their staged/unstaged state are preserved. You still review the proposal before committing.
- **Unstaged Commit Isolation**: With `/commit` and no instruction, when both staged and unstaged changes are detected, choose "Commit only unstaged changes (stash staged)" or pass `-u` / `--unstaged`. Your manual staged changes are safely preserved in git stash while the unstaged changes are committed, and restored to the index automatically upon completion or safely rolled back on cancel.
- Spins up an isolated sub-agent with zero conversation context bloat.
- Transparent live progress and recent action logging in the status box.
- **Large diffs**: Commit, summary, and PR agents use cached, paginated inspection views instead of cutting off the rest of a diff. Commit pages allow 16,000 characters; summary/PR pages allow 32,000 (also bounded to 48 KB / 1,800 lines). The compressor shortens only unchanged context, preserving every changed line, Git metadata, and selective hunk number. Agents follow continuation offsets and can request raw pages to recover context. Compression respects `compressor.enabled` and the compressor disable environment flags. Lockfile diffs remain accessible when relevant. Git capture is still bounded to 10 MiB; summary tools explicitly omit binary/non-regular untracked files and files larger than 10 MiB. Reading many pages can still consume substantial model context.
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
