# Upstream review checkpoints

These are **last reviewed commits**, not vendored versions or claims of full
upstream parity. Local implementations stay in-process TypeScript; neither RTK
nor FFF binaries are required. Earlier adaptations did not record a baseline.

## Last reviewed: 2026-11-17

| Local subsystem | Upstream / branch | Last reviewed commit | Commit date (UTC) |
| --- | --- | --- | --- |
| `tools/compressor/` | [rtk-ai/rtk](https://github.com/rtk-ai/rtk), `develop` | [`8bb6096b773546547d7704f9a8683ea9719a5017`](https://github.com/rtk-ai/rtk/commit/8bb6096b773546547d7704f9a8683ea9719a5017) | 2026-11-16 |
| `tools/scout/` | [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff), `main` | [`924cb4d758f09bb54654555b0c9440bacd1f97f0`](https://github.com/dmtrKovalenko/fff/commit/924cb4d758f09bb54654555b0c9440bacd1f97f0) | 2026-11-13 |

### RTK: behavior adopted independently

- Never-worse guard ([source](https://github.com/rtk-ai/rtk/blob/8bb6096b773546547d7704f9a8683ea9719a5017/src/core/guard.rs)):
  compare bytes and a character-based token estimate, including the actual-size
  `/recall` hint. These are estimates, not a provider-tokenizer guarantee.
- Conservative executable/subcommand recognition: recognize selected wrappers
  and Git global options, but never apply one specialized parser to combined
  shell output, scripts, substitutions, redirections or unknown commands.
- Retain complete Go/Rust test failure details and every Rust suite summary;
  support Go test NDJSON with raw fallback for mixed or truncated records.
- Preserve TypeScript diagnostic continuations, linter file headings, warnings,
  source excerpts and suggested fixes. Unknown formats pass through.
- Pytest section-aware progress removal retains shortened failure headings,
  traceback/E lines, warnings and expected/unexpected failure reports
  ([upstream parser](https://github.com/rtk-ai/rtk/blob/8bb6096b773546547d7704f9a8683ea9719a5017/src/cmds/python/pytest_cmd.rs)).
- Dedicated Bun/Deno handling distinguishes test stdout from runner-owned
  diagnostics; unrecognized failing output is retained
  ([upstream runner](https://github.com/rtk-ai/rtk/blob/8bb6096b773546547d7704f9a8683ea9719a5017/src/core/runner.rs)).
- Declarative rules do not truncate unsuccessful commands or warning/security
  reports. Every specialized semantic rewrite exposes recall, even below caps.
  Download filters retain response data containing percent signs/ETA text, disk
  filtering retains real `/dev/...` device rows, and generic deduplication does
  not conflate differently indented lines.

Intentional differences: no command rewriting, output-format injection,
classifier/model calls, streaming subprocess runner, telemetry service or SQLite
recall migration. Conservative failure handling can save fewer tokens than RTK.
Existing shell Git-diff reduction remains lossy; the separate Git-agent diff
compressor preserves every changed line and its metadata.

**Licensing:** RTK's root source license at the checkpoint is Apache-2.0, but
`engine/` and `proxy/` have separate licenses. In particular,
[`engine/LICENSE`](https://github.com/rtk-ai/rtk/blob/8bb6096b773546547d7704f9a8683ea9719a5017/engine/LICENSE)
is BUSL-1.1 with an additional use grant. Do not assume the whole repository is
Apache-2.0 or copy that engine into this project without a license review.

### FFF: behavior adopted independently

- Stable bounded top-K filename ranking, including external filename searches:
  retain at most `offset + limit` candidates while counting every match
  ([#963](https://github.com/dmtrKovalenko/fff/pull/963),
  [#1005](https://github.com/dmtrKovalenko/fff/pull/1005)).
- Grep ranks its first candidate batch eagerly and sorts the suffix only if
  needed; equal-score ordering and existing scan caps stay unchanged
  ([#960](https://github.com/dmtrKovalenko/fff/pull/960)).
- Definition-first ranking requires the match to overlap the declared name;
  fuzzy ranges must remain within that name. Includes Rust auto/const/unsafe
  traits, inline attributes, raw identifiers and namespace exports
  ([#996](https://github.com/dmtrKovalenko/fff/pull/996),
  [definition classifier](https://github.com/dmtrKovalenko/fff/blob/924cb4d758f09bb54654555b0c9440bacd1f97f0/crates/fff-core/src/definition/mod.rs)).
- Configurable workspace ignore behavior
  ([#988](https://github.com/dmtrKovalenko/fff/pull/988)). Defaults honor Git ignore
  rules **and** preserve existing fixed/hidden-directory exclusions.
  `scout.respectGitIgnore` and `scout.includeHidden` take effect on the next
  search without changing tool schemas. Git evaluates nested `.gitignore`,
  negations, repository/global excludes and tracked exceptions through one
  read-only `git ls-files` call per scan. Outside Git workspaces, or if that
  call fails, Scout retains its fixed exclusions. Explicit external/unindexed
  search routes keep their broad inspection behavior.

Already covered locally: basename-only slashless globs ([#902](https://github.com/dmtrKovalenko/fff/pull/902))
and unchanged-content caching. Not ported: Rust search pools/SIMD, filesystem
watchers, mmap/arena storage, native SDK bindings, Neovim UI changes or aux-finder
pool changes (our external route has no such pool). FFF is MIT-licensed at the
checkpoint; preserve applicable notices when copying upstream code.

### Verification for this checkpoint

Use transient checks only; do not add persistent test files. Cover command
routing, never-worse/recall behavior, failing and passing runner formats,
diagnostic preservation, definition spans across single/multi/fuzzy/external
search, stable ranking equivalence (including ties and pagination), and isolated
Git-ignore fixtures. Benchmark bounded selection against a stable full sort;
this measures ranking only, not an end-to-end search-speed guarantee.

Implementation verification: `npm run typecheck` and `git diff --check` passed;
160 transient checks passed, including real external search routes and isolated
Git/global-exclude fixtures. A 100,000-candidate ranking run produced identical
top-30 results in 4.5 ms bounded versus 80.9 ms full-sort (single-run observation,
not a performance contract). No inference or environment installation was needed.

## Next review

1. Fetch each upstream branch and compare history **after the full SHA above**.
   Pin the new checkout before reviewing it; a remote tip is not a reviewed SHA.
2. Compare source and fixtures with the local implementation, not just release
   notes. Distinguish new behavior from fixes we already have.
3. Check licenses per subtree before copying code. Prefer independently
   implemented behavior that fits our TypeScript/runtime constraints.
4. Run `npm run typecheck`, relevant transient behavior/equivalence checks and
   performance checks. Remove temporary scripts, fixtures and checkouts.
5. Update this file's full SHAs, dates, adopted changes and intentional gaps only
   after that review. Keep `README.md` and `AGENTS.md` pointers current.
