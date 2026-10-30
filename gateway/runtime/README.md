# Discord gateway runtime

`../daemon.mjs` is the standalone Node entry point. Both `/discord start` and
graceful restarts launch that same file; there is no build step or TypeScript
loader in the background process. Runtime modules use native ESM (`.mjs`).
Importing them does not connect to Discord, spawn Pi, or install process handlers.

## Responsibilities and state ownership

| Module | Responsibility |
| --- | --- |
| `config.mjs` | Read and validate configuration, paths, executable arguments, and startup reason. |
| `router.mjs` | Authorize messages, choose DM/thread conversations, deduplicate, and schedule replies. |
| `sessions.mjs` | Own the session pool, conversation queues, global run slots, and idle eviction. |
| `pi-rpc.mjs` | Own one conversation's Pi child, RPC framing, settlement, and workspace handoffs. |
| `workspace.mjs` | Validate and persist per-conversation cwd, exact session file, and switch requests. |
| `session-ui.mjs` | Own one session's prompt card, deferred answer edits, and working-status messages. |
| `interactions.mjs` | Own active prompt tokens, text replies, interaction authorization, and cancellation. |
| `commands.mjs` | Register slash commands and model/thinking autocomplete; handle commit workflows, setting changes, and home-channel configuration. |
| `components.mjs` | Render Discord controls and cards without performing I/O or managing sessions. |
| `messages.mjs` | Split/send text, manage typing, and safely download supported Discord CDN images. |
| `threads.mjs` | Own thread registration, persistence, pruning, and generated-title watchers. |
| `lifecycle.mjs` | Own PID/status files, process handlers, restart requests, draining, and replacement startup. |
| `persistence.mjs` | Write private JSON files through temporary-file replacement. |
| `logging.mjs` | Format logs and sanitized error summaries. |

Factories receive their collaborators explicitly. There is no singleton runtime
or shared catch-all context object. The entry point supplies lazy cleanup
callbacks where commands and lifecycle depend on each other.

## Coordination contracts

- Route work through `sessions.enqueue(key, task)` to preserve conversation order.
  Use `sessions.withRunSlot(task)` for agent runs to enforce global concurrency.
- Register accepted asynchronous work with `lifecycle.trackTask(promise)`. Message
  handlers also run through `lifecycle.handleMessage(task)`, so a restart cannot
  overtake thread creation or other pre-queue work.
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
  Do not mutate `process.cwd()`, tool factories, or `ctx.cwd` as a partial override.
- After `agent_settled`, validate the request against the active token, cwd, and
  session file, fully stop the old child, and launch `--fork <source>` in the new
  cwd. This preserves the complete history/tree with a new Pi session ID and
  reloads cwd-bound project resources. Resume the unfinished task automatically
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
