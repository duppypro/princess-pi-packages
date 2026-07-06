# WTFT Tagger Daemon — Spec

Issue: [#48](https://github.com/duppypro/princess-pi-packages/issues/48)
Branch: `48-wtft-classified-cache-daemon`
Updated: `54-55-wtft-dedup-ttl-cache` (cost model v2, tag format rename)

---

## Architecture

```
session.jsonl ──▶ [wtft-daemon] ──▶ wtft-tags/session.jsonl.wtft-tag.v2.0.0.jsonl
       (harness-specific)             (harness-agnostic, throttled 90bpm)
                                                     │
                          ┌──────────────────────────┤
                          │                          │
                    Pi TUI widget              wtft --watch (CLI)
                    (in-memory, not disk)
```

The tagger daemon is a pure Unix pipe: one input (session.jsonl), one output
(tag file in `wtft-tags/` subdirectory). No network, no HTTP, no WebSocket.
Consumers read the tag file off disk.

---

## Tag Cache Format

File: `<sessionDir>/wtft-tags/<sessionBase>.wtft-tag.v2.0.0.jsonl`

One JSON object per line. **No version header** — version is embedded in the
filename (`v2.0.0`). Tag files live in a `wtft-tags/` subdirectory to keep
them out of session discovery.

```jsonl
{"_hb":{"first":1719000300000}}
{"t":1719000000000,"c":0.023,"cat":"code","f":[{"p":"src/main.ts","a":"w"}],"cmd":["npm test"]}
{"t":1719000100000,"c":0.001,"cat":"spec","f":[{"p":"docs/spec.md","a":"r"}],"cmd":[]}
```

| Field | Key | Type | Description |
|---|---|---|---|
| Timestamp | `t` | number | Unix ms |
| Cost | `c` | number | USD (computed by current cost model) |
| Category | `cat` | string | spec, code, mixed, tests, research, git, grep, prompt, other |
| Files | `f` | array | `[{"p": "path", "a": "r|w"}]` |
| Commands | `cmd` | string[] | Shell commands — needed by `--other` histogram |

### Cost Model — Tagger Version v2.0.0

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
filesystem operation. Bump `TAGGER_VERSION` in `bin/wtft-daemon.mjs` when
classification heuristics or cost model change.

---

## Daemon Contract

### Throttled Writes

Writes to tag file at most once every **667ms** (90bpm). Idle writes nothing.
Burst of N interactions flushed in one atomic write at next throttle window.

### Atomic Lines

`JSON.stringify + "\n"` in single `fs.appendFileSync`. Consumers drop final
line that fails `JSON.parse`.

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
2. Watch for changes. On change: read new lines since last offset, merge.
3. No version header to check — filename handles versioning.

---

## Daemon Lifecycle

### Auto-Spawn by CLI

`wtft --watch` or `wtft` auto-spawns daemon for selected session.
Daemon outlives CLI consumer. One daemon per session (PID files at
`/tmp/wtft-daemon-<sha256>.pid`).

### Management Commands

```
wtft-daemon --list        # Show all running daemons
wtft-daemon --cleanup     # Kill daemons with deleted source sessions
wtft-daemon --stop <path> # Stop specific daemon
```

Idle time from tag file mtime (in `wtft-tags/` subdirectory).

---

## Consumers

### Pi TUI Widget
In-memory path via `ctx.sessionManager.getBranch()`. Does not use daemon or
tag file. Uses shared classifier functions directly.

### CLI `wtft --watch`
Currently reads `session.jsonl` directly. Future: read tag file for fast path.
Auto-spawns daemon.

### CLI `wtft` (one-shot)
Reads `session.jsonl` directly with `parseSessionFile()`. Dedup applied
in `buildWtftLines()`. Future: prefer tag file when available.

---

## Cost Model Version History

| Version | Changes |
|---|---|
| v1.0.0 | Initial classifier (flat 1.25× cache-write, per-line cost) |
| v2.0.0 | #54 message-ID dedup + #55 TTL-split cache-write pricing |

---

## Road Not Taken

- **`_classifier_version` header:** Replaced by version-in-filename. Eliminates parsing step.
- **Cache files alongside sessions:** Moved to `wtft-tags/` subdirectory — session discovery
  never sees them.
- **SQLite / inline cache:** Overbuilt for append-only workload. JSONL is simpler.
- **One daemon for all sessions:** Adds multi-session state. Per-session isolation preferred.
