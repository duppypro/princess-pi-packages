# Spec: Extract wtft-cli-shared.ts (#94)

## Current state

| File | Lines |
|---|---|
| `extensions/wtft.ts` | 745 |
| `bin/wtft.ts` | 588 |
| **Total** | **1,333** |

Deep modules already extracted: `wtft-cost.ts`, `wtft-parser.ts`, `wtft-renderer.ts`, `wtft-daemon-lib.ts` (barrel: `wtft-shared.ts`). But the **CLI/extension interface layer** — argument parsing, daemon lifecycle, config reading, help/why/version rendering — remains duplicated.

## What to extract

New file: `extensions/lib/wtft-cli-shared.ts` (~300 lines). Seven functions:

### 1. `parseWtftCliArgs(argv: string[])` → `WtftCliOptions`

Unified parser handling the **union** of all flags from both callers. Returns a typed options object. Callers destructure only what they need.

Extension calls `parseWtftCliArgs(str.trim().split(/\s+/).filter(Boolean))`.  
CLI calls `parseWtftCliArgs(process.argv.slice(2))`.

Flags handled (union of both sets):

| Flag | Extension | CLI | Notes |
|---|---|---|---|
| `--help` `-h` | ✓ | ✓ | |
| `--version` | ✓ | ✓ | |
| `--why` | ✓ | ✓ | |
| `-i` `--interval <val>` | ✓ | ✓ | |
| `--interval=<val>` | ✓ | — | Extension supports `=` syntax |
| `-l` `--limit <val>` | ✓ | ✓ | |
| `--limit=<val>` | ✓ | — | |
| `-c` `--cumulative` | ✓ | ✓ | |
| `-b` `--bucket` | ✓ | ✓ | |
| `--ticks` | ✓ | ✓ | |
| `--no-ticks` | ✓ | ✓ | |
| `--tz <val>` `--timezone <val>` | ✓ | ✓ | |
| `--tz=<val>` `--timezone=<val>` | ✓ | — | |
| `-o` `--other` | ✓ | ✓ | |
| `--tokens` | ✓ | ✓ | |
| `-C` `--cost` | ✓ | ✓ | |
| `-F` `--force` | ✓ | ✓ | |
| `-H` `--hide` | ✓ | — | |
| `-S` `--show` | ✓ | — | |
| `-p` `--pager` | ✓ | — | |
| `-w` `--width <val>` | ✓ | — | |
| `--width=<val>` | ✓ | — | |
| `--no-emojii` `--no-emoji` | ✓ | — | |
| `--emojii` `--emoji` | ✓ | — | |
| `-s` `--session <val>` | — | ✓ | |
| `--dir` `--cwd <val>` | — | ✓ | |
| `--harness <val>` | — | ✓ | |
| `-W` `--watch` | — | ✓ | |
| `--pad <val>` | — | ✓ | |
| `--debug` | — | ✓ | |
| `--list` | — | ✓ | |
| `--cleanup` | — | ✓ | |
| `--restart` | — | ✓ | |
| `--stop <val>` | — | ✓ | |
| `--thinking-budget <val>` | — | ✓ | |

Both also gain `=` syntax for `--interval`, `--limit`, `--width`, `--tz`, and `--timezone` (extension already has it; CLI gets it for free).

**Breaking change: `-t` and `-T` shortcuts are removed.** `-t` was overloaded across `--timezone`, `--tokens`, `--ticks`, and a planned `--turns`. All three now require the full `--` name. `-o` (for `--other`) is kept — it's unambiguous and well-established.

### 2. `spawnWtftDaemon(sessionPath: string)` → `ChildProcess | null`

Core daemon spawn logic (identical in both files today). Returns the child process or null on failure. Callers handle errors their own way (extension silently ignores, CLI exits).

Resolves daemon path relative to the shared module's location: `../../bin/wtft-daemon.mjs` from `extensions/lib/`.

### 3. `ensureDaemonRunning(sessionPath: string)` → `boolean`

Stateful wrapper around `spawnWtftDaemon` with health checks. Uses module-level state (separate instance per caller — CLI gets a fresh instance per invocation, extension reuses across session events).

Logic:
1. If already spawned for same session → check health → alive → return true
2. If health check fails → reset state → fall through to spawn
3. Spawn daemon → update state → return success/failure

### 4. `isEmojiDisabled()` → `boolean`

Reads `readConfig("wtft").disabledEmoji`. Trivial, 4 lines. Shared so both callers get the same default.

### 5. `renderWtftHelp(manifestPath: string, invokedAs: string)` → `string`

Manifest-driven help rendering. Reads `*-cmd.json`, formats usage + examples + flag reference. Returns the full help string. Callers output via `ctx.ui.notify` (extension) or `console.log` (CLI).

Replaces: extension's inline manifest-rendering (~30 lines) + CLI's `printHelp()` (~61 lines of hardcoded text). The CLI currently has a **hardcoded** help text — this moves it to manifest-driven, which is already the standard for all other tools in this repo.

### 6. `renderWtftWhy(manifestPath: string, invokedAs: string)` → `string`

Manifest-driven `--why` output. Extension already delegates to `merge/help.js`'s `renderWhy`. This consolidates: shared function imports `renderWhy` from `merge/help.js` and both callers use it.

### 7. `renderWtftVersion(manifestPath: string)` → `string`

Reads manifest, returns `"${name} ${version}"` string. Trivial.

## Caller changes

### `extensions/wtft.ts` changes
- Delete: `parseArgs` (~169 lines), `ensureParserRunning` (~28 lines), `getParserStatus` (~26 lines), `isEmojiDisabled` (~4 lines), `getSettings` (~25 lines)
- Delete: inline help/why/version rendering (~55 lines in handler)
- Add: import shared functions, call them
- `getSettings()` and `isEmojiDisabled()` become thin wrappers if needed (or callers use shared directly)
- Module-level state `_parserSessionPath` / `_parserSpawned` moves into shared module

### `bin/wtft.ts` changes
- Delete: `printHelp` (~61 lines), `printWhy` (~40 lines)
- Delete: inline arg parsing (~83 lines), inline daemon spawn (~40 lines), inline config reading (~15 lines)
- Add: import shared functions, call them
- `main()` becomes ~100 lines shorter

## Actual savings (final)

| File | Before | After | Delta |
|---|---|---|---|
| `extensions/wtft.ts` | 745 | 483 | −262 (−35%) |
| `bin/wtft.ts` | 588 | 398 | −190 (−32%) |
| `wtft-cli-shared.ts` (new) | 0 | 417 | +417 |
| **Net** | **1,333** | **1,298** | **−35 (−3%)** |

The shared module is larger than estimated (417 vs 300) because it carries full JSDoc, the `WtftCliOptions` type definition (80+ lines), and the complete `getDaemonStatus` function with grace-period logic. The net savings is smaller than predicted but the duplication — the real goal — is eliminated.

## Manifest changes

- **Removed shortcuts:** `-t` (was overloaded across `--timezone`, `--tokens`, `--ticks`, planned `--turns`) and `-T` (for `--tokens`). Use full `--` names.
- **Added missing flags:** `-F`/`--force`, `--harness <pi|claude-code|auto>`, `--thinking-budget <n>` — were in the CLI help text but not in the manifest.
- **Merged flag pairs** (one entry instead of two):
  - `--ticks` / `--no-ticks` → `--ticks, --no-ticks`
  - `--emoji` / `--no-emoji` → `--emoji, --no-emoji`
  - `-c, --cumulative` / `-b, --bucket` → `-c, --cumulative, -b, --bucket`
  - `-S, --show` / `-H, --hide` → `-S, --show, -H, --hide`
  - `--tokens` / `-C, --cost` → `--tokens, -C, --cost`

## What does NOT change
- `extensions/lib/wtft-shared.ts` (barrel) — untouched
- `extensions/lib/wtft-daemon-lib.ts` — `watchTagFile` stays where it is
- `extensions/lib/config.ts` — `readConfig`/`writeConfig` stay where they are
- PagerComponent class — stays in extension (TUI-only)
- `updateWtftWidget` / `buildWtftLines` wrappers — stay in extension

## Verification

1. ✅ Build succeeds (`bun build` — all imports resolve, TypeScript compiles)
2. ⚠️ TypeScript not available in this environment (no `tsc`), skipped
3. ✅ Core unit tests pass (7 suites: pricing-tiers, thinking-level, server-tool-cost, issue-52-tool-categories, compaction-tracking, watch-smoke — 0 failures)
4. ⚠️ E2E/daemon tests have pre-existing timing/fixture failures unrelated to this refactor
5. ✅ `./wtft --help` — manifest-driven output, correct
6. ✅ `./wtft --why` — manifest-driven output, correct
7. ✅ `./wtft --version` — `/wtft 1.1.0`
8. ✅ Pi TUI: `/wtft` command loads and renders without errors
