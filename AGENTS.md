# AGENTS.md

Guidance for AI agents working in `pi-enhanced`, a Pi extension suite. See `README.md` for user-facing capabilities and setup.

## Repository Map

- `index.ts`, `package.json`: root extension entry point and Pi package manifest.
- `accounts/`: credential store, multi-account balancing, failover, quota repository, and health evaluation.
- `providers/`: inference providers and model discovery, including Antigravity, Codex, Command Code, Kenari, and Ollama.
- `tools/`: autonomous Git workflows, output compression, Scout search, web search/fetch, subagents, and interactive feedback.
- `ux/`: context viewer, continuation shortcut, plan mode, settings, telemetry, and usage displays.
- `ux/usage/`: provider report adapters, `/usage`, footer, identity resolution, bucket semantics, timing, and window labels.
- `gateway/`: detached Discord gateway, RPC sessions, routing, and lifecycle commands.

Inspect the relevant code before making changes; this map is intentionally not a complete file inventory.

## Security and Workspace Safety

- Never expose API keys, OAuth tokens, or other secrets in logs, tool output, examples, or commits. Use redacted values; the abbreviated credential identifiers specified below are permitted only for identification.
- Do not modify real user credentials or configuration without approval. Use isolated temporary configuration for verification and remove it afterward.
- Inspect the working-tree status before editing. Preserve unrelated changes, including staged work; do not reset, overwrite, or commit them.

## Package and TypeScript Rules

- Keep `index.ts` at the repository root; do not introduce redundant nested package directories. The manifest declares `"pi": { "extensions": ["./index.ts"] }`.
- TypeScript uses NodeNext resolution. **All relative TypeScript imports must end in `.js`**, including imports of local `.ts` files.
- Pi core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@earendil-works/pi-agent-core`) are host-provided. Declare them as `"*"` peer dependencies and as dev dependencies, never as runtime dependencies.

## Model Discovery and Provider Pre-flight

- Prefer dynamic discovery of selectable models. If a provider lacks usable discovery, disclose the limitation and obtain approval before implementing a fallback catalog in that provider’s `catalog.json`. Approval covers the fallback design, not each runtime use. Temporary discovery failures should follow the approved cache/fallback policy, not trigger new approval prompts. Populate fallback entries only from verified sources; record source URLs and verification dates in the catalog or adjacent documentation. Do not invent model availability, entitlements, pricing, or capabilities.
- **Before implementing a new provider or endpoint**, audit its documentation and API completeness, present the findings and limitations, and obtain user confirmation. Do not fabricate capabilities, prices, plan identities, entitlements, quota values, reset intervals, or reset mechanics.
- Evaluate inference protocols and streaming, tool calling, reasoning translation and structured output; model discovery and pricing; usage, balances and quota APIs; rate limits, error envelopes and failover; authentication, key lifecycle and multi-account support; and missing endpoints or other edge cases.
- Prefer, but do not require, all three of the following. Disclose gaps and proposed mitigations in the pre-flight report:
  1. **Dynamic catalog:** credential-scoped models, per-token pricing and reasoning levels where available. Report missing metadata as unknown.
  2. **Programmatic plan identification:** use documented account, subscription, billing or quota responses, or verifiable token claims. Filter models by account plan only when supported by provider-reported entitlements or verified plan mappings. Without reliable evidence, do not infer tiers or entitlements, assume access, or exclude models based on an invented tier.
  3. **Parseable usage and resets:** prefer consumed or remaining quota and verified reset times. Distinguish fixed/global resets from rolling windows only when supported by evidence; otherwise leave timing unknown.

## Native UI Conventions

- Match Pi's native visual language, interaction model, and keyboard conventions. Prefer targeted hooks and native dialogs over replacing host components.
- Do not add synthetic `[ Cancel ]`, `[ Back ]`, or `← Back` selector options; Esc handles dismissal.
- Use Pi's `→ ` / `theme.cursor` selection indicator in custom selectors. Avoid competing leading glyphs or status icons; use clean labels and suffixes such as `(active)` or `(current)`.
- Multi-account flows, including `/logout`, should look like native Pi selectors rather than bespoke dashboards.

## Shared Usage and Quota Conventions

### Data and identity

- `/usage` and the footer must share the report repository, identity resolution, and bucket semantics; presentation may differ. Never persist session-specific display state in shared reports.
- Retain the last successful report after refresh failure. `/usage` must show the error and clearly mark stale data and its age; the footer may continue showing the last successful report.
- Prefer a verified account name or user-provided label, then a verified account ID. Do not invent identities. If neither is available, identify an API credential with its first 7 characters, `...`, and last 4 characters; for keys of 12 characters or fewer use `key`. Never display a full credential or treat a shortened key as proof that multiple keys belong to the same account.
- Sort known-duration quota windows longest to shortest using reported durations or canonical window labels. Keep unknown-duration buckets and value-only balances after known windows, retaining their relative provider order. Ordering labels must not create reset timing or marker intervals.
- Show elapsed-time markers and reset countdowns only when supported by valid, known timing data. Do not invent quota values or reset behavior.
- Render balances and credits as named values, not bars. Display only the amount, omitting explanatory suffixes such as `available` or `on-demand (never expires)` without changing the underlying data. Unknown balances are not zero.
- Keep shared semantics in `ux/usage/buckets.ts`, `identity.ts`, `timing.ts`, and `windows.ts`; keep presentation in `format.ts` and `footer.ts`.

### Footer

- Keep the active account's quota compact and right-aligned on the second line, after session statistics. Preserve the native two-line layout and truncate gracefully on narrow terminals.
- Show the longest window as `<window> [<10-character bar>] <used%> (<reset countdown>)`. Use `█` for consumed quota, `░` for unused quota, and `┃` for elapsed time when known. The footer percentage is **used**, not remaining.
- Use compact labels such as `5h`, `1d`, `wk`, and `mo`. Append shorter nonzero-usage windows in descending order as ` · <window>: <used%> (<reset countdown>)`; highlight secondary windows at 80% and 95% used.
- Use compact verified countdowns such as `2d14h`, `3h05m`, or `12m`. Hide balances known to be zero. Show explicit loading, cooldown, or unavailable states when appropriate.

### `/usage`

- Group reports by provider, then account, then quota bucket. Show the active session model and account when available. Mark the active account with `●` and `[in use]`, and other accounts with `○`. Render tier labels in lowercase without altering stored plan identities.
- Use descriptive labels such as `5-Hour`, `Daily`, `Weekly`, and `Monthly`, retaining meaningful provider-specific names. Show bars with **remaining** percentage to one decimal place; use `┃` only for known elapsed-window timing.
- Show verified reset countdowns or `ready` where appropriate. Show known zero balances as named values. Display errors and unavailable reasons within the affected account section.
- Adapt to terminal dimensions; keep each provider's accounts together when flowing into multiple columns.

## Verification and Distribution

- After code changes, run `npm run typecheck` and relevant transient behavior checks before finishing, whether or not a commit is requested. For documentation-only changes, review the diff and run `git diff --check -- AGENTS.md` (substitute the affected paths). Summarize checks performed, failures, and any skipped checks with reasons.
- Do **not** create, commit, or persist unit test files (`*.test.ts`, `*.spec.ts`, `tests/`, `__tests__/`). Verify transiently with inline checks, headless Pi runs, or live CLI checks; clean up any temporary scripts.
- Useful verification commands (select an available, authenticated model from `pi --list-models` and replace `<available-provider/model>`; inference checks may incur usage):

  ```bash
  npm run typecheck
  pi --list-models
  pi -e ./index.ts --model '<available-provider/model>' -p "say hello"
  pi -e ./index.ts -p "/settings-enhanced list"
  pi -e ./index.ts -p "/usage"
  ```

- The package is distributed directly via GitHub (`pi install git:github.com/RaviEdho/pi-enhanced`). `pi install .` is an optional, environment-changing local installation check; obtain approval before running it. There is no npm packaging, version-bump, or GitHub release pipeline; do not run `npm version` or create releases. The package version is informational, and users pick up merged changes on install/update.
