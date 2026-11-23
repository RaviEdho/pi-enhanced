# Terminal workflows and settings

[← pi-enhanced](../README.md)

## Inspect Context Window Breakdown (`/context`)

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

## Enhanced Settings (`/settings-enhanced`)

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
- `subagent.model`: Subagent Model - one saved model for the `subagent` tool and `/subagent` (an available `provider/model` or `session`, the default)
- `subagent.thinkingLevel` (Subagent Thinking): Thinking level for both background and synchronous runs; defaults to `session` (inherit the parent session's thinking)
- `feedback.askUser`: Ask User Tools - interactive clarification & 3-choice decision tool (`ask_user`) with session cache memory (`enabled` / `disabled`)
- `scout.respectGitIgnore`: Honor Git ignore rules in workspace search (`enabled` / `disabled`, default `enabled`)
- `scout.includeHidden`: Index hidden workspace directories, retaining fixed exclusions (`enabled` / `disabled`, default `disabled`)
- `compressor.enabled`: Output Compressor - terminal noise reduction for bash/powershell (`enabled` / `disabled`)
- `git.commitModel` (Git Agent Model): Model used by `/commit`, `/git commit`, and `/git summary` (choose an available model or `session`; defaults to the active session model)
- `git.thinkingLevel` (Git Agent Thinking): Thinking level shared by those commands; defaults to `session`
- `usage.showFooter`: Live quota bars and elapsed time progress in footer (`enabled` / `disabled`). On narrow terminals, line 2 hides the account first, then balances and quota statuses. Starting with the shortest window, it drops each reset timer before hiding the window. After hiding the longest window's timer, it drops cache hit rate, cached token counts, input/output counts together, then cost. The longest window keeps its label, bar, and percentage as long as they fit alongside context usage, which takes priority at the narrowest widths.
- `usage.contextFormat`: Context usage format in footer (`pi-enhanced` tokens e.g. 45k/200k, `pi` percentage e.g. 23.5%/200k, or `off`)
- `timer.showSummary`: Settled turn telemetry in transcript (`enabled` / `disabled`)
- `timer.showWorkingTelemetry`: Live working spinner duration, token count & speed telemetry (`enabled` / `disabled`)
- `continue.dotShortcut`: Single dot `.` prompt continue shortcut (`enabled` / `disabled`)
- `session.autoTitle`: Generate one concise, action-oriented title from the first user message (`enabled` / `disabled`; extra model call)
- `session.titleModel`: Model for title generation; choose `session` or an available `provider/model`
- `balancer.failoverOn429`: Automatic failover on HTTP 429 rate limits (`enabled` / `disabled`)
- `balancer.paceBalancing`: Quota pace balancing across multiple accounts (`enabled` / `disabled`)

Settings persist to `~/.pi/agent/enhanced-settings.json`. Model and thinking settings are independent: for example, `/settings-enhanced set git.thinkingLevel low` sets the effort without changing the model. Use `session` to inherit either setting. With a specific model selected, the thinking control only offers levels it supports. Changing models retains the saved preference; Pi adjusts it at runtime if needed.

At 10,000 context tokens or more, the settings dialog asks for confirmation before enabling or disabling Scout Search, Web Access, Subagent, or Ask User tools. Both changes can invalidate the prompt cache. The explicit `set` command warns and applies the change without prompting.

## Safe Plan Mode & Implement Mode (`/plan`, `/implement`)

Explore and design code solutions safely before committing to file modifications, with zero prompt cache breakage:

```text
/plan                         # Toggle between Plan Mode and Implement Mode
/plan <prompt>                # Enable Plan Mode and immediately start planning <prompt>
/implement                    # Switch back to Implement Mode (restores edit/write tools)
/implement <prompt>           # Switch back to Implement Mode and execute <prompt>
```

- **Keyboard Shortcut**: Press `Ctrl+Alt+P` or `Alt+M` to toggle modes at any time.
- **CLI Startup Flag**: Start Pi in Plan Mode with `pi --plan`.
- **Status & Textbox Sync**: The terminal footer displays `■ plan • ~/dir` or `▶ implement • ~/dir`, and the input textbox border dynamically reflects reasoning effort across both modes. On narrow terminals, line 1 hides the `implement` label, Git counts, branch, and reasoning level in that order. It then drops the dot before the path and shortens the path to `.../dir` as needed. The mode icon stays visible, and the final folder name is never cut in half.
- **Human-in-the-Loop Approval Gate**: When a plan is drafted, an interactive menu presents:
  - `Execute plan`: Automatically switches to Implement Mode and launches execution of step 1.
  - `Refine plan`: Prompts for adjustments while remaining safely in Plan Mode.
  - `Stay in plan mode`: Keeps exploring or asking questions.
- **Cache-Safe Sandboxing**: Tool schemas are never altered dynamically, ensuring prefix caching remains completely intact.

## Autonomous Git Assistant (`/git`, `/commit`)

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
/git pr review [number|url]   # Pick an open PR or review a specific one; submit only after confirmation
/git branch [description]     # Smart conventional branch name recommender & switcher
/git worktree [list|add|rm]   # Git worktree manager for parallel task isolation
/git resolve [file]           # Autonomous merge conflict analyzer & hunk resolver
/git release [tag]            # Release notes & changelog drafter grouped by conventional types

# Instant Routine Helpers (0 LLM Tokens)
/git release npm              # Bump and stage, or stage the version already on main
/git release ship             # Pick a version, review optional notes, then approve the release
/git release ship patch       # Same flow, skipping the version picker
/git release push v0.2.3      # Retry a local release tag without bumping again
/git release status v0.2.3    # Check the tag and CI/release status
/git sync                     # Safe pull --rebase & push to upstream
/git undo                     # Soft-undo last commit, keeping changes in working tree
/git unstage                  # Unstage all changes; keep working-tree files unchanged
/git discard                  # Discard uncommitted tracked changes (staged + unstaged); untracked files are kept
/git discard --untracked      # Also delete untracked files and directories (ignored files are kept)
/git status                   # Interactive status overview
/git summary [staged|unstaged] # AI summary with selectable topic-based commit proposals
```

- **[npm release staging](npm-releases.md)**: `/git release npm` can bump, commit, and push the version before staging the reviewed commit on `origin/main`. Choose **Stage current version** to skip the bump or resume after a PR merge. No Git tag is required, and npm approval with 2FA remains separate.
- **[Tag-triggered releases](git-releases.md)**: Use `/git release ship` when pushing a version tag starts CI, as in Volt. It uses the existing `package.json` and `origin` without a Pi-specific config. Draft notes with AI if you want, or skip them without calling a model.
- **Pull Requests**: Check out the feature branch and run `/git pr main` (replace `main` with the target branch), or choose **Draft Pull Request** in `/git` to use the detected default branch. The active Pi model drafts a title and body from committed changes on the checked-out branch. The comparison prefers the locally cached `origin/<base>` ref and does not fetch. View or edit the body, print the draft to the transcript, or explicitly create the PR using an installed, authenticated GitHub CLI. For GitHub creation, push the branch and set its upstream first (`git push -u origin HEAD`).
- **Review a PR**: In Pi's TUI, run `/git pr review` or choose **Review Pull Request** from `/git` to fetch and choose from up to 50 open PRs in the repository that `gh` resolves from your checkout. Pi’s cancellable loader shows elapsed time and your configured cancel key (`Esc` by default). Draft PRs are marked in the list. Run `/git pr review 123` or pass a full GitHub.com PR URL to skip the picker. This sends the remote PR description, paged diff, and reported check statuses to the active model; it does not check out the branch or run tests. Review and edit the proposed Markdown (Enter keeps the draft locally), browse the patch with **View PR diff** (←/→ to change pages), then choose whether to print the draft locally, approve, request changes, or comment. Nothing is posted without a separate confirmation. Pi rechecks the PR head, diff, and open state before submitting with `gh pr review`. This check is not atomic with submission; GitHub still enforces permissions and disallows self-approval. Plan Mode permits drafting but not submission. For a manual look at the patch or CI, use `gh pr diff` or `gh pr checks` with the same PR number or URL.
- **Git progress**: Commit, summary, PR draft, and PR review draft use the same inline Pi spinner with elapsed time and the configured cancel key. The open PR picker still uses a bordered loader while fetching the list. Publishing a PR or review shows progress without a cancel hint.
- **Change Summaries**: `/git summary` groups inspected changes into coherent commit proposals with **Commit <topic>** actions. Select a topic with `↑`/`↓` and `Enter` (or click it in fullscreen mode) to forward its detailed instruction to `/git commit <instruction>`, which re-inspects current changes and asks for final approval. `PgUp`/`PgDn` or the mouse wheel scroll the summary independently; `Esc` closes without starting a commit. Press `p` to close the dialog and print the entire summary and proposed commits in the transcript. The printed summary persists with the session but is not added to the model's context.
- **Unstage All**: `/git unstage` removes all staged changes from the index while preserving file contents, including new files (which become untracked). It covers the whole repository even when run from a subdirectory, works before the first commit, and does not move HEAD or discard merge/rebase state. The `/git` status menu offers this action when changes are staged. It requires no model call and reports when nothing is staged; arguments and paths are not supported.
- **Instruction-Based Selective Commits**: With `/commit <instruction>`, the instruction goes directly to the isolated agent without the staged/unstaged choice prompt. The agent selects relevant whole files or numbered diff hunks; other changes and their staged/unstaged state are preserved. You still review the proposal before committing.
- **Unstaged Commit Isolation**: With `/commit` and no instruction, when both staged and unstaged changes are detected, choose "Commit only unstaged changes (stash staged)" or pass `-u` / `--unstaged`. Your manual staged changes are safely preserved in git stash while the unstaged changes are committed, and restored to the index automatically upon completion or safely rolled back on cancel.
- Spins up an isolated sub-agent with zero conversation context bloat.
- Transparent live progress and recent action logging in the status box.
- **Large diffs**: Commit, summary, and PR agents use cached, paginated inspection views instead of cutting off the rest of a diff. Commit pages allow 16,000 characters; summary/PR pages allow 32,000 (also bounded to 48 KB / 1,800 lines). The compressor shortens only unchanged context, preserving every changed line, Git metadata, and selective hunk number. Agents follow continuation offsets and can request raw pages to recover context. Compression respects `compressor.enabled` and the compressor disable environment flags. Lockfile diffs remain accessible when relevant. Git capture is still bounded to 10 MiB; summary tools explicitly omit binary/non-regular untracked files and files larger than 10 MiB. Reading many pages can still consume substantial model context.
- Full token usage and cost accounting displayed in the confirmation dialog, CLI output, and completion notification.
- Interactive proposal review with full message preview (header & body), detailed file diff metrics, direct commit (`c`), commit & push (`p`), edit (`e`), or cancel (`Esc`).

## Web Search & Web Fetch

The `web_search` and `web_fetch` tools are automatically available to LLMs during conversations.

### Managing Search & Fetch API Keys:
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

## Interactive User Feedback (`ask_user`)

The extension gives the LLM direct access to user input dialogs during execution via the unified `ask_user` tool:

- **Freeform Text Input**: When called with a `question` (and optional `placeholder`), prompts the user inside a native TUI input box (`ctx.ui.input`). Ideal for gathering missing tokens, URLs, file paths, or custom requirements.
- **3-Choice Decisions**: When called with `choices: ["Option 1...", "Option 2...", "Option 3..."]`, displays an interactive selector (`ctx.ui.select`). Automatically includes a `✎ Type custom answer...` option for typing an alternative choice. Dismissing with `Esc` cancels cleanly.
- **Multi-Question Questionnaires**: When called with `questions: [{ question, choices?, placeholder? }, ...]`, prompts the user sequentially through each question in a single tool turn (e.g. `[1/3] Question...`). Preserves already answered questions even if the user cancels midway. Fully safe and functional in Plan Mode.

### Enabling / Disabling `ask_user`:
The tool is enabled by default, but can be completely disabled via `/settings-enhanced`:
```text
/settings-enhanced set feedback.askUser disabled
```
- When disabled, the tool definition is completely removed from the model's active tool list and prompt instructions.
- **Session Memory & Cache Protection**: Just like Pi remembers model selections on past sessions, toggling `feedback.askUser` applies to **future/new sessions**. Resuming an existing long session automatically remembers its initial tool configuration, preserving 100% prefix prompt cache hits on past conversations!
- Turning `ask_user` on or off is covered by the prompt-cache warning in Enhanced Settings.

## Search, output and background jobs

- **Codebase Scout Search Engine (`tools/scout/`, `/scout-health`, `/scout-rescan`)**: 100% pure TypeScript port of FFF concepts. Replaces standard `find` and `grep` with memory-cached, typo-tolerant search tools (`find`, `grep`). Indexes the workspace on the first search (or `/scout-rescan`), not while Pi opens a session. Features typo-tolerant fuzzy matching, declared-symbol-aware definition ranking, stable bounded top-K filename ranking, unified single and multi-pattern (`patterns: [...]`) OR search in a single pass, git recency awareness, and strict output budgeting with match-centered line truncation (`…match…`) to prevent context blowup.
- **Terminal Output Compressor (`tools/compressor/`, `/recall`)**: Native in-process port of RTK (Rust Token Killer) features without requiring external binaries or command rewriting. Hooks into Pi's `tool_result` event, reducing raw terminal noise (collapsing passing test suites, condensing git status/push/diff, pruning linter squiggles, stripping progress meters, and deduplicating repetitive logs). Caches uncompressed tool-result text for `/recall <id>`. Conservative command routing protects chained/script output; diagnostic blocks and warning reports are retained, and a never-worse guard includes recall-hint overhead. Includes dedicated Bun/Deno and Go NDJSON handling.
- **Autonomous Isolated Subagent Routine (`tools/subagent/`, `/subagent`, `/jobs`)**: In-process subagent execution powered by in-memory sessions (`SessionManager.inMemory`). Defaults to non-blocking background execution (or synchronous blocking with `background: false` / `/subagent --sync`). Uses the saved **Subagent Model** from `/settings-enhanced` (the active parent model by default), inherits the parent's thinking effort where supported, and executes with focused system instructions, guardrails (max turns & timeouts), enhanced tools (`read`, `bash`, `edit`, `write`, `find`, `grep`, `web_search`, `web_fetch`, `escalate`), structured escalation back to the parent agent, context budgeting, cleanly coordinated follow-up delivery into the parent session, and full lifecycle control (`subagent_list`, `subagent_status`, `subagent_cancel`, `/jobs`).

Set the model with `/settings-enhanced set subagent.model <provider/model>` or choose **Subagent Model** in the settings picker. Set it to `session` to inherit the parent model again. Choose **Subagent Thinking** to override the parent's thinking level. These settings apply to new background and synchronous runs without changing the parent session or jobs already running. If the saved model becomes unavailable, new runs stop with an error rather than silently using a different model.

## Session shortcuts and telemetry

- **Automatic Session Titles**: Uses a configurable model to create a concise, action-oriented title (up to 36 characters) from the first user message, with toggles and model selection in `/settings-enhanced`. In the Discord gateway, the generated name is also applied to its server thread.
- **Continue Shortcut (`.` Continue)**: Pressing `.` (literal dot only) immediately resumes agent work on the most recent intent without summarizing, asking for confirmation, or leaving any user message bubble in the chat transcript.
- **Live Turn Telemetry in the Working Status**: The `Working` indicator shows elapsed time plus real-time per-run metrics appended inline — cumulative tokens in/out (`↑15.2k ↓3.1k`), time-to-first-token (`TTFT 0.9s`), and decode throughput (`38 tps`). Counters sum every turn and model call while the agent is still working and reset once the run settles. On narrow terminals, the editor border drops `Working` first, then shortens or hides the session title, then drops TTFT, throughput, input tokens, output tokens, and elapsed time in that order. The spinner stays visible, and waiting-for-reply status takes priority over the title.
- **Settled Turn Summary in the Transcript**: Once the agent finishes its final turn, a compact telemetry line is printed into the transcript right after the response — total elapsed time, total tokens in/out (`↑15k ↓3.0k`), average TTFT across every model call (`TTFT avg 1.0s`), and average decode throughput (`50 tps avg`). Stored as a session entry (never sent to the model) and expandable to reveal the model-call count.

## Startup and UI performance

- **Fast, Cache-First Startup**: Provider registration never waits for network requests. Startup uses cached catalogs (including an expired Codex snapshot) or existing offline fallbacks; Pi refreshes discovery in the background after its TUI/RPC interface initializes. Command viewers, web pipelines, and inference implementations load on demand. Settings and Discord model pickers can also request background refreshes; reopen them to see updates. `--offline` / `PI_OFFLINE` disable automatic catalog, billing, and quota requests.

Credential helpers do not load browser OAuth implementations. Login, token refresh, and raw Antigravity token discovery load those implementations only when needed. The footer caches raw active-branch usage and context statistics until the session, branch, model, or relevant session events change; theme formatting, quota updates, and reset countdowns remain live.

Repeated display reads of settings and credentials share a 250ms file-check window. Local updates are immediate; explicit settings/usage commands, inference credential checks, and native logout synchronization bypass the polling window. External file edits are picked up on the next read after that window expires. Expired, missing, and corrupt Codex catalogs also coalesce metadata checks instead of repeatedly reading/parsing JSON; a successful discovery save updates the in-memory catalog immediately.

Scout honors Git ignore rules by default while retaining fixed exclusions (`node_modules`, build/cache directories, and most hidden directories). Configure `scout.respectGitIgnore` and `scout.includeHidden` in `/settings-enhanced`; changes apply on the next search. In Git workspaces, a read-only `git ls-files` call per scan evaluates nested `.gitignore`, negations, repository/global excludes and tracked exceptions. Non-Git workspaces or Git failures retain fixed exclusions. Explicit external/unindexed-directory searches retain their broad inspection behavior.

Reviewed upstream SHAs, adopted behavior, licensing boundaries, and the next-update procedure are recorded in [UPSTREAM.md](../UPSTREAM.md).

Scout checks directory metadata on demand without filesystem watchers, reusing unchanged directory listings and refreshing file metadata only where needed. File contents use a memory-only LRU with a conservative 32MiB accounting budget and at most 4,096 entries; each reuse validates size, timestamps, and file identity. Directory listings and cached text are also revalidated on the next search after ten seconds, covering coarse filesystem timestamps. Files over 2MiB and known binary extensions remain excluded from content search. Explicit Git filters refresh Git status, `/scout-rescan` forces a full scan and clears cached text, and session shutdown/workspace replacement releases the active index. No cached file contents are written to disk.

Custom TUI dialogs share a titled header, optional right-aligned metadata, and a keyboard-hint footer. Their total height is capped at **24 rows** or **terminal height minus 4 rows**, whichever is smaller (centralized in `ux/dialog.ts`). Action buttons and input controls stay pinned below the scrollable content, above the keyboard hints; the selected `→` row remains visible. Use `PgUp`/`PgDn` to scroll content in forms and selectors, or `↑`/`↓` in viewers. In fullscreen mode, mouse-wheel/trackpad events over custom dialogs scroll their content without leaking into the transcript; settings lists retain native wheel navigation. Pi-native dialogs and Discord's RPC-rendered dialogs are unchanged.
