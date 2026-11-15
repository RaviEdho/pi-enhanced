# Discord gateway runtime

`../daemon.mjs` is the standalone Node entry point. Both `/discord start` and
graceful restarts launch that same file; there is no build step or TypeScript
loader in the background process. Runtime modules use native ESM (`.mjs`).
Importing them does not connect to Discord, spawn Pi, or install process handlers.

## Responsibilities and state ownership

| Module | Responsibility |
| --- | --- |
| `config.mjs` | Read and validate configuration, paths, executable arguments, context-message bounds, and startup reason. |
| `discord-rest.mjs` | Own an isolated Undici 6 dispatcher for Discord REST, with automatic retries disabled. |
| `router.mjs` | Authorize messages, choose DM/thread/channel conversations, deduplicate, and schedule replies. |
| `route-decider.mjs` | Ask a chat model whether a new server conversation needs a thread or a direct channel reply, with timeouts and thread fallback. |
| `sessions.mjs` | Own the session pool, conversation queues, one-shot fork seeds, global run slots, and idle eviction. |
| `pi-rpc.mjs` | Own one conversation's Pi child, RPC framing, settlement, workspace handoffs, and history IPC lifecycle. |
| `history.mjs` | Authenticate session IPC for bounded history reads, channel discovery, silence decisions, and image uploads. |
| `send-image.mjs` | Authorize the active upload destination, bound workspace-file/public-HTTPS image loading, and upload validated image buffers. |
| `workspace.mjs` | Validate and persist per-conversation cwd, exact session file, and switch requests. |
| `session-ui.mjs` | Own one session's prompt card, deferred answer edits, and working-status messages. |
| `interactions.mjs` | Own active prompt tokens, text replies, interaction authorization, and cancellation. |
| `commands.mjs` | Register slash commands and model/thinking autocomplete; handle live steering, force cancellation, commit workflows, setting changes, and home-channel configuration. |
| `components.mjs` | Render Discord controls and cards without performing I/O or managing sessions. |
| `agent-replies.mjs` | Send completed assistant text with ordered table-only images and text fallback. |
| `table-renderer.mjs` | Parse top-level Markdown tables and render bounded, escaped SVG to PNG locally. |
| `messages.mjs` | Split/send text, manage typing, resolve direct reply context, format bounded rich-preview text and recent conversation context, and safely download supported Discord CDN images. |
| `threads.mjs` | Own thread registration, shared conversation keys, persistence, pruning, and generated-title watchers. |
| `lifecycle.mjs` | Own PID/status files, process handlers, restart requests, draining, and replacement startup. |
| `persistence.mjs` | Write private JSON files through temporary-file replacement. |
| `logging.mjs` | Format logs and sanitized error summaries. |

Factories receive their collaborators explicitly. There is no singleton runtime
or shared catch-all context object. The entry point supplies lazy cleanup
callbacks where commands and lifecycle depend on each other.

## Coordination contracts

- Create Discord REST with its own explicitly supplied Undici 6 `Agent`, not the
  process-wide dispatcher. Importing Pi's SDK loads Undici 8 and replaces the
  legacy global dispatcher with a compatibility wrapper; real multipart Discord
  uploads through that wrapper can stall while JSON requests continue working.
  Keep `undici` as a direct major-6 runtime dependency, independent of Pi's copy.
  Set REST `retries: 0`: an aborted message POST may already have been delivered,
  and four default 15-second attempts can outlast the image tool's 55-second IPC
  deadline. This also disables automatic transport/5xx retries for other REST
  requests; normal Discord rate-limit handling remains enabled. Lifecycle owns
  closing the private dispatcher after Discord client shutdown. Never reset the
  process-wide dispatcher to fix uploads; that can break provider traffic.

- Completed assistant replies and visible tool-call narration pass through
  `sendAgentReply`; ordinary notifications, controls, commit/usage workflows and
  tool reports keep their existing text/card delivery. Parse Markdown with
  `markdown-it`, using source line maps to preserve exact original slices and
  surrounding text order. Fenced/indented code and nested list/quote tables stay
  text. Render top-level tables locally with `sharp`, using only escaped SVG text
  and fixed shapes: never evaluate HTML, fetch links/images/fonts or use a browser.
  Repeat headers on vertical pages and the first column on horizontal panels.
  `tableRendering.enabled` (default false, including legacy configs) is the master
  toggle: only explicit true enables rendering; otherwise send the original text
  through the existing splitter without
  loading the parser/renderer or attaching PNG/Markdown files. It applies to both
  final replies and visible narration, preserving other saved table preferences.
  `tableRendering.showTitleFooter` controls the visible title, page numbering
  and range footer together; `tableRendering.attachMarkdown` independently adds
  the exact original UTF-8 table as `table-N.md`. These two options default to
  false, including legacy configurations. Configure them under `/discord` → Settings → Tables;
  setup preserves saved values and changes apply after a gateway restart, like
  other settings. Validate optional boolean fields in both TS storage and daemon
  config loaders. Pass settings to final replies and visible tool narration.
  Send each table in one message: maximum eight PNGs plus optional source. Always
  keep page/range context in alt text; with decorations off, fit the canvas to
  the table plus a small outer margin. Count optional source bytes against the
  attachment budget. Keep mentions disabled and reference the triggering message
  only on the first outgoing message.
  Bound parsing to 200,000 characters, tables to 64 KiB / 200 body rows / 20
  columns / 4,000 characters per cell, pages to 1100×1400 logical pixels at 2×,
  PNGs to 8 MiB, and each delivery to 12 images / 16 MiB total attachments.
  Oversized layouts, unavailable dependencies and render errors fall back to
  original text without truncating cells. Failed/uncertain uploads send a warning
  and original text, never retry attachments or replay already sent surrounding
  text. Keep Pi session/model content unchanged. Dependencies load lazily so a
  missing native renderer cannot prevent gateway startup or ordinary replies.

- Resolve reply context only for authorized, accepted messages. In auto routing, load
  it before the routing decision; other routes load it inside the queued run. Memoize
  the read per accepted message and reuse it for the agent, including thread fallback.
  Fetch only the directly referenced same-channel message via Discord's message API;
  never traverse reply chains. Treat its text/author and attachment links as quoted
  context, not a new user's instructions. An unreadable reference becomes an explicit
  unavailable-context note without aborting the run.
- Every turn also adds bounded automatic context: up to `contextMessages` recent
  same-channel messages (default 5, maximum 25, `0` disables), oldest first. Replies
  anchor the window immediately before the direct same-channel reply target; non-replies
  anchor it before the incoming message. The target is quoted separately and is not
  part of the history count. Exclude the anchor/current/future and own-bot messages.
  For non-replies, keep a per-conversation delivered-message watermark: pass only
  messages newer than it, and skip automatic context when the watermark belongs to a
  different channel (a freshly created thread has no earlier messages to recover).
  Explicit replies intentionally bypass this watermark so an older target's context
  is available even after newer messages were delivered. Label reply-anchored history
  with its target message ID so it cannot be confused with current channel discussion.
  Mark the incoming message delivered when it is accepted, not when its run finishes,
  so queued messages still see only their own gaps. Label the block as quoted context,
  truncate long text, and degrade to no context on Discord API or permission failures;
  never fail the run. Reply context and automatic context are appended after the
  labeled author turn. Automatic context reads only the conversation's own channel, so
  it obeys the same allowlist and bot permissions that already admit the message.
- Current messages, direct replies, and selected recent messages include text-only
  snapshots of already received Discord rich previews for both routing and the agent.
  Whitelist title, source URL, description, and up to five text fields from at most
  two embeds; cap each message's formatted preview block at 1,000 characters.
  JSON-quote values and label previews as untrusted, possibly incomplete third-party
  excerpts, not instructions or verified facts. Never fetch preview URLs/media,
  process preview images, wait for delayed embeds, or expand message/channel reads.
  Missing/malformed previews fall back to existing text. Reserve all selected recent
  message text first, then allocate previews newest-first from spare space within
  16,000 characters; preserve selection, ordering, author labels, and watermarks.
  The router retains its existing reply/history bounds and independently caps the
  current-message preview block at 1,000 characters. A brief explanation/summary of
  a linked post is CHANNEL; independent verification of its claims is THREAD.
- Explicit history-tool calls use the existing channel whitelist (including `*`): DM turns can
  read only the active requester's own allowed DM; thread turns can read allowed text,
  announcement, or ordinary voice channels in the same server, with the destination parent also allowed. Both requester and bot need View Channel and Read Message History, plus Connect for voice. Voice text chat requires no voice join; stage channels are excluded. Recheck DM recipient or requester
  and bot membership/permissions, config, and active turn around fetches; reject
  thread sources and cross-server access. Different-participant
  steering revokes history for that run. Shared results can reach participants
  without source access and persist in sessions. Discovery uses the same IPC and active scope, only in server threads: fresh guild, roles, members and channels, current whitelist and both parties' channel permissions using the same channel types and voice Connect requirement; voice results have type `voice`. Names are untrusted, results are capped at 50 with explicit truncation. Channel names and IDs can also persist and be seen by all shared-thread participants. IPC is not an OS sandbox.
- `discord_send_image` is a Discord-only sequential, model-only tool. Send immediately
  through authenticated session IPC, only for an active tracked image tool call and
  settlement waiter, never a command workflow or caller-selected destination. Recheck
  the active turn, scope, allowlists, fresh guild membership/roles and destination
  permissions before loading and again before sending. DMs follow normal message
  authorization (no extra DM channel allowlist); server destinations require the
  allowed parent. Different-participant steering revokes the scope. Private threads
  require membership or Manage Threads. The bot needs Attach Files and Send Messages
  (Send Messages in Threads for threads). Disable all mentions and retain the active
  reply target. Deduplicate each tool-call ID within the turn; return a message ID,
  not image bytes. Successful image-only responses skip the empty-text fallback.
  Reset upload/tool tracking per accepted prompt, not from saved history.
- Image uploads accept one PNG/JPEG/GIF/WebP per call, validated by magic bytes, with
  optional caption (1,900 characters) and alt text (1,024). Bound to four attempts /
  20 MiB per accepted request and 10 MiB per image, including failed attempts. Resolve
  local files against session.cwd; reject realpath escapes/symlink targets outside
  that workspace, non-regular files and oversized/growing files. Read bounded buffers,
  never pass raw paths/URLs to Discord's uploader. HTTPS downloads use port 443 only,
  no credentials/proxies, a ten-second deadline, checked and pinned public DNS answers,
  and at most three independently validated redirects; reject private/reserved IPs,
  mixed DNS answers, compressed responses and oversized streams. Sanitize attachment
  names and force their detected extension. IPC frames are bounded to 32 KiB; upload
  requests get a 55-second daemon deadline / 60-second client timeout. Disconnects
  abort loading and prevent new sends; an already in-flight Discord send cannot be
  rolled back. Report uncertain delivery without automatic retries, and never log
  image contents, URL query strings or raw filesystem/network errors. These checks
  are tool boundaries, not an OS sandbox for the full-tool Pi process.
- All allowlisted participants in a server thread use one shared session and queue,
  including `/model`, `/thinking`, autocomplete, and `/commit`. Resolve its key with
  `getThreadSessionKey(threadId, registration)`, never the current speaker's ID.
  Keep the starter's legacy `:user:<createdByUserId>` suffix to preserve the exact
  hashed session directory, history, workspace, model, and thinking level without
  copying or merging files. Registrations without a starter use a thread-only key.
  Other participants' old sessions stay untouched; do not backfill Discord history.
  DMs keep their existing per-channel/user keys. `/model` in an allowed non-thread server
  channel instead saves the gateway-wide default for new conversations; its catalog
  session is separate, and existing conversation settings must remain unchanged.
  Recheck saved user/channel authorization when applying the default. All participants still require
  allowlist authorization; prompt/picker/approval ownership stays with the initiator.
- Label every incoming message with its author username and stable user ID. The
  appended system prompt distinguishes participants, attributes preferences and
  approvals to their authors, and refuses identity overrides from message text or
  quoted context. Apply this to resumed sessions and workspace handoffs too.
- Route work through `sessions.enqueue(key, task)` to preserve conversation order.
  Use `sessions.withRunSlot(task)` for agent runs to enforce global concurrency.
- A mention in an allowlisted server channel starts either a thread or a direct channel reply,
  decided by `channelReplies.mode` in the saved config: `always-thread` (default, prior
  behavior), `channel`, or `auto`. Only `auto` consults a model. Resolve the model lazily
  through the installed `@earendil-works/pi-coding-agent` `ModelRuntime`, registering
  `providers/index.ts` with Pi's SDK extension loader first. Load only this provider entry
  point, not the root extension or workspace-discovered extensions: preserve cached
  discovery, plan filters, auth, and streaming/failover without tools, UI, or agent sessions.
  Share initialization between warming and concurrent decisions. An explicit routing model
  must match an authenticated chat model exactly; if unavailable, fall back to a thread,
  never a different model. With no routing model set, use the cheapest authenticated chat
  model, not the gateway's conversation model. The six-second deadline bounds context reads,
  model loading, and completion even if a provider ignores cancellation; also pass its abort signal to the
  request. Never reuse a conversation child, because overlapping prompts are refused.
  Keep the task framing in the user turn, not the system prompt, omit `temperature`
  (subscription transports reject it),
  cap output tokens, and never log message text or the returned prose.
- Auto routing includes the direct reply quote (up to 2,000 characters) and an independent
  same-channel window configured by `channelReplies.contextMessages` (default 5, 0–25;
  `0` disables recent history but not the direct quote). Both router and agent anchor
  history before the direct reply target for replies, or before the incoming message
  otherwise. Routing is stateless and never applies a delivered-message watermark.
  Fetch at most the larger of the agent/router window once per accepted message and
  reuse the snapshot, slicing each consumer's independent window before the agent's
  bot/watermark filtering. Include the gateway bot's own messages in routing context
  so the stateless classifier can resolve follow-up references. Keep the agent's own-bot
  exclusion, non-reply watermark, and separate context limit unchanged.
  Exclude the anchor/current/future messages from both consumers;
  label authors and quoted context, truncate each message as usual, cap router history
  at 16,000 characters, and prioritize the current request over quoted instructions or
  earlier complex work. Unreadable history degrades to no history; an unreadable quote
  is explicit. Context reads must not run for unauthorized/rejected messages, and routing
  reads are skipped for forced modes, follow-up escalation, DMs, and existing threads.
- Channel conversations use one shared session per channel
  (`getChannelSessionKey`), separate from thread sessions, and reply to the triggering
  message. They are exempt from thread title generation but keep normal queueing, run slots,
  author labels, and history scopes (the channel is its own history parent).
- `toolCallVisibility` independently gates tool activity/failure reports and assistant
  narration by the actual Discord destination (`channels`, `threads`, `dms`). Missing
  values default to channels off, threads and DMs on, including legacy configurations.
  Do not classify by `historyScope`: direct server-channel replies also use a thread-shaped
  history authorization scope. `toolCallVerbosity` still controls the detail level where
  visible. Visibility must not alter tool tracking/escalation, final replies, interactive
  prompts, workspace notices, or the dedicated commit/usage workflows.
- Existing server-thread message turns can end with `discord_no_reply`. The model-only,
  sequential tool must be called alone before any other tool or public output. It uses
  the authenticated per-child IPC endpoint to approve its exact active tool-call ID;
  authority comes from the daemon's `allowNoReply` interaction flag and actual guild
  thread destination, not the tool payload or the thread-shaped history scope alone.
  DMs, new channel mentions, command workflows, and steered runs cannot abstain.
  Accept only a successful matching tool result with the no-reply marker; errors,
  cancellation, later assistant messages, or subsequent tool work invalidate silence.
  Reset all decision state for each accepted prompt, never restore it from history.
  Return an explicit `{ disposition: "no_reply" }` outcome so the router skips both
  reply delivery and the empty-response fallback. Keep the incoming message and tool
  reason in the saved history; do not log the reason or message text. Hide successful
  no-reply activity and narration attached to its sole call, but keep failure reporting.
  Suppress working-status posts while an eligible thread turn has not committed to
  a response/tool work, so a slow silence decision creates no status message. Typing
  may still appear. Do not buffer or hide ordinary notifications, errors, or prompts;
  they revoke the ability to abstain instead. Steering revokes silence for the run.
- Every routing failure falls back to a thread: unavailable registry, timeout, provider
  error, or an unlabeled response. Never block or drop a reply on the decision.
- With escalation enabled in `auto` mode, a channel reply can escalate deterministically. Two
  independent switches: `escalate` moves a channel run that used `bash`, `edit`, `write`,
  `subagent`, `set_working_directory`, or `discord_gateway_restart` into a thread after its
  reply is delivered (read-only channel replies stay put); `followUp` sends the same user's
  repeat mention in that channel within ten minutes straight to a thread without asking the
  model. Disable `followUp` to let the routing model decide every mention. Escalation registers
  the new thread and seeds its session with the channel conversation file, so the first thread
  turn forks the shared history instead of starting blank; the fork is one-shot and falls back
  to a fresh session when the source is missing or invalid.
- Register accepted asynchronous work with `lifecycle.trackTask(promise)`. Message
  handlers also run through `lifecycle.handleMessage(task)`, so a restart cannot
  overtake thread creation or other pre-queue work.
- `/steer message:<instruction>` requires the same user and conversation-route
  authorization as other conversation commands. Peek at the existing session and
  send Pi's native `steer` RPC immediately, bypassing the conversation queue and
  global run-slot acquisition. Track the request with lifecycle so restarts drain
  it too. Require an active settlement waiter, not merely `running`; refuse idle,
  stopped, post-settlement, workspace-replacement, and `/commit` sessions, and new
  requests during restart drain. Never create a session or orphan a steering queue
  on an idle child. Label the instruction with the command author's username and
  stable ID, but keep the active run's interaction and UI ownership unchanged.
  Pi delivers steering after the current turn's tool calls, before the next model
  call. The existing prompt waiter owns settlement and the final Discord reply;
  steering must not create a second waiter, reset UI, or duplicate the reply.
  Normal Discord messages keep their existing queued behavior.
- `/stop` requires the same user and conversation-route authorization as other
  conversation commands, but bypasses the queue and remains available during a
  restart drain. Never open a session just to cancel it. Stop only the active
  conversation's running child, invalidate its UI/pickers, discard pending cwd
  handoffs, and preserve saved history/workspace for the next request. Signal
  the child without waiting for stdin shutdown; kill its tool descendants
  independently of Pi's signal handler, then force kill Pi after one second
  if it is unresponsive. Reopening must wait for process/UI cleanup and share
  one initialization per conversation, including simultaneous setting requests.
  Treat interrupted prompts and commit workflows as cancellation, not provider
  failures or successful commits. Existing queued requests remain queued;
  completed filesystem/Git operations are not rolled back.
- `/usage` queues the private `discord-usage` extension command in the conversation's Pi session and captures its UI notifications without posting them to the channel. It also accepts allowlisted server channels and their threads outside gateway conversations, using a separate shared usage session without active-session identity. Respect user and channel allowlists and DM/server access settings. Deliver every report chunk ephemerally to the requesting user; never log report contents or fall back to an agent prompt. The shared report collector supplies session-specific identity and quota semantics.
- `/commit` sends the literal extension command through RPC after checking
  `get_commands`; never fall back to a natural-language prompt if it is missing.
  Use the conversation queue, a global run slot, and lifecycle task tracking.
  Resolve the session after dequeuing so earlier workspace handoffs apply; use
  that child's `ctx.cwd`, never the daemon cwd or shared `config.cwd`. Show the
  resolved `session.cwd` in the interaction reply before starting review. Restored
  sessions use their persisted workspace, just like normal agent turns.
  Extension handlers finish before the RPC `handled` response, so allow a longer
  deadline for nested model calls/dialogs and do not wait for `agent_settled` or
  retrieve stale assistant text. On transport timeout, stop that Pi session before
  allowing another command to reuse its working state. Session UI drains proposal
  notifications before posting approval controls, including multi-message proposals;
  a failed notification delivery cancels the dialog instead of hiding review details.
  Mark its interaction `workflow: "commit"` so staging dialogs, notices, and results
  use one reusable Components V2 message per run without changing unrelated RPC
  UI. Serialize all commit message edits (including interaction acknowledgements,
  pagination, text replies, modal completion, expiry, notices, and final results).
  Run/screen generations reject late updates so an old prompt cannot overwrite a
  newer result. Only recreate a card when Discord reports it was deleted, not
  on arbitrary delivery errors. Long notices/results use read-only pagination;
  they must not create extra messages or send RPC answers. Preserve earlier
  warnings/errors when subsequent screens replace them. Commit runner progress
  uses the native RPC `setWidget` request with `widgetKey: "commit"`; plain status,
  model, elapsed time, usage, and recent actions are emitted on status changes and
  a two-second RPC heartbeat (native TUI animation remains at 80ms). Coalesce the
  newest snapshot into the same card at most once per two seconds, measuring the
  interval when the serialized edit actually starts. Never accumulate a backlog
  during slow Discord requests. Interactive prompts/results bypass this progress
  throttle; new screens, widget clear, reset, closure, and RPC finalization cancel
  pending progress so it cannot overwrite review controls or final results.
  Session UI buffers
  the proposal notification until its matching review selector, then renders full
  paginated details with Commit / Commit & Push / Edit / Cancel buttons. Button
  indices resolve to the original RPC option strings and keep normal ownership,
  dismissal, expiry, and text-reply behavior. Refuse final review if its full
  proposal is missing. Flush an unmatched proposal as cards on early exit; never
  lose it or silently truncate a plan to fit a modal.
- `set_working_directory` is a Discord-only, sequential model tool. It writes a
  private per-child-token request and returns `terminate: true`; subsequent tools
  are blocked until the handoff. It refuses to interrupt running background jobs.
  Do not mutate `process.cwd()`, tool factories, or `ctx.cwd` as a partial override;
  move `process.cwd()` only as part of a full in-process session rebind.
- After `agent_settled`, validate the request against the active token, cwd, and
  session file. Prefer an in-process handoff: write a forked session file whose
  header points at the target cwd, then send the `switch_session` RPC. Pi tears
  down and rebinds the session in place, reloading cwd-bound project resources
  without paying a full process startup. Move `process.cwd()` in
  `session_before_switch`/`session_start` so cwd-bound extensions see the new
  directory. If the in-process switch fails, fall back to stopping the child and
  launching `--fork <source>` in the new cwd. Both paths preserve the complete
  history/tree with a new Pi session ID. Resume the unfinished task automatically
  inside the same conversation queue, run slot, and lifecycle task. At most five
  switches are allowed per accepted message to prevent workspace loops.
  After a successful handoff is persisted, send the active thread/DM a workspace
  change notification with the old and new paths before continuing the task.
  Failed/no-op switches do not announce success; notification delivery failures
  are logged without undoing the switch or preventing continuation. A switch
  recovered during startup is announced when the next conversation operation
  supplies its Discord channel; ordinary resumes do not repeat the notice.
- Persist `{ cwd, sessionFile, appliedRequestId }` in each hashed conversation's
  private `workspace.json`; future starts use that exact file with `--session`.
  `--continue` filters by cwd and must only be used for legacy/first starts.
  Existing conversations without metadata retain their original continuation
  behavior. Keep the shared config immutable. Failed handoffs restore the source
  child; interrupted requests recover on startup, with applied IDs deduplicated.
  Missing directories/files fail closed rather than silently choosing another repo.
- During a restart, pending UI answers remain usable while accepted runs drain.
  New prompts and setting changes are refused.
- Closing the pool rejects new/queued work and run-slot waiters before stopping
  children, so shutdown cannot spawn a process outside the cleanup snapshot.
- Closing a Pi session cancels its UI prompts and clears working-status messages.
  Status updates are serialized; cleanup invalidates late updates and waits for
  in-flight sends. Pool eviction also invalidates model/thinking pickers for that
  session.
- Always pass the **daemon entry-point path** to lifecycle. `import.meta.url` in
  `lifecycle.mjs` points to a helper, not a runnable replacement daemon.
- The daemon discovers its extension root from its own `import.meta.url`, resolving
  symlinks, and passes it explicitly to every `PiRpcSession`. Each child receives
  it in `--append-system-prompt` and `PI_ENHANCED_EXTENSION_ROOT`. Keep this
  independent of the configured workspace and the extensions loaded by the child.
  The prompt applies to new and resumed sessions without relying on chat history.
- Preserve hashed session directories and existing JSON formats when refactoring;
  they are the persistence boundary with previous gateway versions.

## Verification

Run `npm run typecheck` and `node --check` on the entry point and runtime modules.
Use transient inline checks with fake Discord objects and a fake newline-delimited
RPC child to exercise queues, routing, prompts, and process lifecycle without
connecting to Discord. Do not add persistent test files.
