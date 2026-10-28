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
| `pi-rpc.mjs` | Own one Pi child process, RPC framing, request timeouts, and agent settlement. |
| `session-ui.mjs` | Own one session's prompt card, deferred answer edits, and working-status messages. |
| `interactions.mjs` | Own active prompt tokens, text replies, interaction authorization, and cancellation. |
| `commands.mjs` | Register slash commands and model/thinking autocomplete; handle setting changes and home-channel configuration. |
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
- Preserve hashed session directories and existing JSON formats when refactoring;
  they are the persistence boundary with previous gateway versions.

## Verification

Run `npm run typecheck` and `node --check` on the entry point and runtime modules.
Use transient inline checks with fake Discord objects and a fake newline-delimited
RPC child to exercise queues, routing, prompts, and process lifecycle without
connecting to Discord. Do not add persistent test files.
