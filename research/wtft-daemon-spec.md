# WTFT Tagger Daemon — Spec

Issue: [#48](https://github.com/duppypro/princess-pi-packages/issues/48)
Branch: `53-wtft-inotify-watch` (watch via inotify + daemon self-contained)
Updated: 2026-07-06 (v2.2.0 cost model, inotify watch, CLI tag-file read)

---

## Architecture

```
session.jsonl ──▶ [wtft-daemon] ──▶ wtft-tags/<session>.wtft-tag.v{N}.jsonl
  (harness-specific,                (harness-agnostic, throttled 90bpm,
   Pi or Claude Code)                pre-costed, pre-classified, deduped)
                                                     │
                          ┌──────────────────────────┤
                          │                          │
                    wtft (non-watch)           wtft --watch (CLI)
                    readClassifiedTagFile      watchTagFile (inotify)
                          │                          │
                          └──────────┬───────────────┘
                                     │
                              buildWtftLines
                              (shared renderer)
```

The tagger daemon is the **sole harness-specific component**. It reads raw
Pi/Claude Code session.jsonl, applies cost model and classification,
deduplicates by message.id (#54), and writes harness-agnostic classified
output. All consumer paths (watch, non-watch) read the same tag file format.

The daemon source is `bin/wtft-daemon.ts` — esbuild bundles it into
`bin/wtft-daemon.mjs` as part of `npm run build`. Shared rendering functions
live in `extensions/lib/wtft-shared.ts`.

Consumers never parse raw session.jsonl (except as emergency fallback).

---

## Tag Cache Format

File: `<sessionDir>/wtft-tags/<sessionBase>.wtft-tag.v{N}.jsonl`

One JSON object per line. **No version header** — version is embedded in the
filename. Tag files live in a `wtft-tags/` subdirectory to keep them out of
session discovery.

```jsonl
{"_hb":{"first":1719000300000}}
{"t":1719000000000,"c":0.023,"cat":"code","f":[{"p":"src/main.ts","a":"w"}],"cmd":["npm test"]}
{"t":1719000100000,"c":0.001,"cat":"spec","f":[{"p":"docs/spec.md","a":"r"}],"cmd":[]}
{"_hb":"stop"}
```

| Field | Key | Type | Description |
|---|---|---|---|
| Timestamp | `t` | number | Unix ms |
| Cost | `c` | number | USD (computed by current cost model) |
| Category | `cat` | string | spec, code, mixed, tests, research, git, grep, prompt, other |
| Files | `f` | array | `[{"p": "path", "a": "r|w"}]` |
| Commands | `cmd` | string[] | Shell commands — needed by `--other` histogram |
| Heartbeat | `_hb` | object/string | Daemon health signal; consumers skip these lines |

### Cost Model — Tagger Version v2.2.0

Current pricing logic (TTL-split cache-write, message-ID deduplication):
- **#54**: Costs deduplicated by `message.id` (Claude Code emits multiple JSONL
  lines per API response; dedup prevents ~1.8× inflation).
- **#55**: Cache-write tokens priced by TTL: 5-minute @ 1.25× input, 1-hour @ 2× input.
  Falls back to flat 1.25× when TTL breakdown unavailable (Pi schema, DeepSeek).
- DeepSeek: input/output only, peak-valley surge pricing (2× during
  UTC 01:00–04:00 and 06:00–10:00).

### Version Management (Filename-Based)

Version is embedded in filename: `.wtft-tag.v{N}.jsonl` where `{N}` is semver.

On startup, the daemon scans `wtft-tags/` for `<sessionBase>.wtft-tag.v*.jsonl`.
- If current version file exists: resume incremental append.
- If old-version files exist (different semver): delete them (stale cost model).
- If no tag file: create new, full reparse.

**No `_cv` or `_classifier_version` header needed** — cache invalidation is a
filesystem operation. Bump `TAGGER_VERSION` in `bin/wtft-daemon.ts` when
classification heuristics or cost model change.

---

## Daemon Contract

### Throttled Writes

Writes to tag file at most once every **667ms** (90bpm). Idle writes nothing.
Burst of N interactions flushed in one atomic write at next throttle window.

### Atomic Lines

`JSON.stringify + "\n"` in single `fs.appendFileSync`. Consumers can assume
every line is a complete, valid JSON object — no partial writes, no mid-write
reads. This guarantee is what enables the inotify consumer to skip debouncing.

### Heartbeat Protocol

```jsonl
{"_hb":{"first":1719000300000}}                    # Connected / idle period begins
{"_hb":{"first":1719000300000,"last":1719000600000}}  # Updated in-place, never grows
{"_hb":"stop"}                                     # Intentional disconnect
```

Last line overwritten in place during idle. Next data arrival ends idle period;
next idle cycle appends new `_hb`.

### Idle Exit

30 minutes of no `session.jsonl` modification → clean shutdown (`_hb:"stop"`,
remove PID, exit).

### Consumer Read Protocol

1. Read entire tag file on startup for initial state.
2. Watch for changes via `fs.watch` (inotify). On change: read new lines since
   last byte offset, convert via `classifiedToInteraction()`, merge into
   accumulator, re-render.
3. No version header to check — filename handles versioning.
4. No debounce needed — daemon guarantees complete lines.

---

## Daemon Lifecycle

### Auto-Spawn by CLI

Both `wtft` and `wtft --watch` auto-spawn the daemon for the selected session.
Daemon outlives CLI consumer (detached child). One daemon per session (PID
files at `/tmp/wtft-daemon-<sha256>.pid`, singleton enforced via atomic
`wx` file creation).

### Management Commands

```
wtft --list              # Show all running daemons (passthrough to wtft-daemon)
wtft --cleanup           # Kill daemons with deleted source sessions
wtft --restart           # Kill all running daemons, fresh spawn on next wtft
wtft --stop <path>       # Stop daemon for a specific session path

wtft-daemon --list       # Same commands available directly on daemon binary
```

Idle time from tag file mtime (in `wtft-tags/` subdirectory).

---

## Consumers

### Pi TUI Widget (`/wtft`)
In-memory path via `ctx.sessionManager.getBranch()`. Does **not** use daemon
or tag file — entries are in-memory, not on disk. Uses shared classifier
functions from `wtft-shared.ts` directly.

### CLI `wtft` (non-watch, one-shot)
Auto-spawns daemon. Polls up to 3s for the tag file to contain classified
data. Reads all entries via `readClassifiedTagFile()`. Renders via
`buildWtftLines()`.

### CLI `wtft --watch` (live mode)
Auto-spawns daemon. Polls up to 5s for the tag file to exist. Opens `fs.watch`
(inotify) on the tag file via `watchTagFile()`. On every change event, reads
new bytes by offset, converts to Interactions, merges into accumulator,
re-renders. No polling, no debounce — daemon guarantees complete atomic lines.

Falls back to polling `watchMode()` (reads session.jsonl directly) if daemon
spawn fails.

---

## Implementation

### Daemon Source (`bin/wtft-daemon.ts`)
Self-contained — does **not** import from `wtft-shared.ts`. Inlines all
harness-specific functions:
- `getDeepSeekPeakMultiplier`, `calculateClaudeCost` (TTL-split pricing)
- `parseEntryToInteraction` (Pi + Claude Code schemas, messageId extraction)
- `classifyInteraction` (file/command → category taxonomy)
- `deduplicateInteractions` (message-ID dedup, #54)
- Daemon-specific: `serializeClassified`, `upsertHeartbeat`, PID/singleton,
  poll loop, arg parsing, management commands

Built by esbuild as step 4 in `build.mjs` → `bin/wtft-daemon.mjs`.

### Shared Renderer (`extensions/lib/wtft-shared.ts`)
Harness-agnostic — consumed by both CLI paths and Pi extension:
- `classifiedToInteraction()` — converts tag-file line → `Interaction`
- `readClassifiedTagFile()` — reads all classified entries (skips heartbeats)
- `watchTagFile()` — inotify-based live watch + render loop
- `buildWtftLines()` — chart layout compiler
- Formatting, rendering, timeline helpers

### CLI Entry Point (`bin/wtft.ts`)
Orchestrates session discovery, daemon spawn, tag-file read/render.
Both watch and non-watch paths use the same tag-file reader.

---

## Cost Model Version History

| Version | Changes |
|---|---|
| v1.0.0 | Initial classifier (flat 1.25× cache-write, per-line cost, no dedup) |
| v2.0.0 | #54 message-ID dedup + #55 TTL-split cache-write pricing |
| v2.1.0 | (internal — daemon imported from wtft-shared.ts; reverted) |
| v2.2.0 | Daemon self-contained (no shared imports). Both CLI paths read tag file. Inotify watch via `watchTagFile`. Daemon management passthrough (`wtft --list`). TTY helpers extracted (#58). |

---

## Road Not Taken

- **`_classifier_version` header:** Replaced by version-in-filename. Eliminates parsing step.
- **Cache files alongside sessions:** Moved to `wtft-tags/` subdirectory — session discovery
  never sees them.
- **SQLite / inline cache:** Overbuilt for append-only workload. JSONL is simpler.
- **One daemon for all sessions:** Adds multi-session state. Per-session isolation preferred.
- **Daemon importing from wtft-shared.ts:** Added then reverted. The daemon is the sole
  harness-specific parser — keeping it self-contained prevents cost-model drift between
  the daemon and the Pi extension's in-memory path.
- **Polling loop in watch mode:** Replaced by `fs.watch` (inotify) on the daemon's tag file.
  No throttling needed — daemon guarantees atomic complete lines at ≤667ms.
