# WTFT Classifier Daemon — Spec Draft

Issue: [#48](https://github.com/duppypro/princess-pi-packages/issues/48)
Branch: `48-wtft-classified-cache-daemon`

---

## Architecture

```
session.jsonl ──▶ [wtft-classifier daemon] ──▶ classified.jsonl
       (harness-specific)                  (harness-agnostic, throttled 90bpm)
                                                     │
                          ┌──────────────────────────┤
                          │                          │
                    Pi TUI widget              wtft --watch (CLI)
                          │
                    wtft --webui daemon ──▶ WebSocket ──▶ WebUI
                       (future issue)                  ──▶ LLM detector
```

The classifier daemon is a pure Unix pipe: one input (session.jsonl), one output
(classified.jsonl). It has no network, no HTTP, no WebSocket. Consumers read
the classified file off disk.

---

## Classified Format (classified.jsonl)

One JSON object per line. First line is a header with the classifier version.

```jsonl
{"_classifier_version":1}
{"t":1719000000000,"c":0.023,"cat":"code","f":[{"p":"src/main.ts","a":"w"}],"cmd":["npm test"],"txt":["Let me fix that."]}
{"t":1719000100000,"c":0.001,"cat":"spec","f":[{"p":"docs/spec.md","a":"r"}],"cmd":[],"txt":["Reading the spec..."]}
```

| Field | Key | Type | Description |
|---|---|---|---|
| Timestamp | `t` | number | Unix ms |
| Cost | `c` | number | USD |
| Category | `cat` | string | One of: spec, code, mixed, tests, research, git, grep, prompt, other |
| Files | `f` | array | `[{"p": "path", "a": "r|w"}]` |
| Commands | `cmd` | string[] | Shell commands executed |
| Texts | `txt` | string[] | Text blocks (prompt/thinking content) |

Keys are intentionally short — this file has as many lines as the source session,
so every byte counts on large sessions.

### Version Management

The first line of `classified.jsonl` is always `{"_classifier_version":<N>}`.
When the classifier logic changes (e.g., new category heuristics, new cost model),
increment the version number. On startup, the daemon reads the first line:
- If version matches: incremental append from last known source position.
- If version differs or file missing: delete, re-parse entire source from scratch.

---

## Daemon Contract

### Throttled Writes

The daemon writes to `classified.jsonl` at most once every **667ms** (90bpm).
During idle (no new source lines), it writes nothing. During a burst of N new
interactions, all N are written in one atomic write at the next throttle window.

### Atomic Lines

Each line is written as one complete `JSON.stringify(obj) + "\n"` in a single
`fs.appendFileSync` call. Consumers treat any final line that fails `JSON.parse`
as a partial write and drop it.

### Staleness Detection & Heartbeat Protocol

The daemon writes heartbeat lines with explicit lifecycle signals:

```jsonl
{"_hb":"start"}                 # Daemon connected, beginning classification
{"_hb":1719000300000}            # Alive, no new data (every ~667ms when idle)
{"_hb":"stop"}                  # Intentional disconnect — daemon shutting down
```

Consumers can distinguish:
- **Connected / alive:** recent `_hb` with timestamp or `"start"`. Heartbeats
  fire every 30s when the daemon is idle.
- **Intentional disconnect:** last heartbeat was `"stop"`. Daemon will not return.
- **Crashed:** no heartbeat for >35s (30s interval + 5s grace), and no `"stop"`
  line present. Consumer may restart the daemon.
- **Idle:** heartbeats with timestamps arriving on schedule, no classified
  data lines between them.

### Consumer Read Protocol

1. Read the entire `classified.jsonl` on startup to build initial state.
2. Watch for changes (inotify or poll). On change:
   - If `_classifier_version` changed: reload from scratch.
   - Otherwise: read only new lines since last known offset and merge.

---

## Daemon Lifecycle

### Startup — Auto-Spawn by CLI

The daemon is auto-spawned by `wtft` CLI commands when they target a session.
Only sessions selected by CLI consumers get daemons; most sessions don't.

When `wtft --watch <session>` or `wtft <session>` runs, it checks if a daemon
is already running for that session (via PID file or heartbeat detection). If
not, it spawns one as a child process. The daemon outlives the CLI consumer.

When the CLI consumer exits, the daemon continues running (detached). If the
daemon detects no consumers for a configurable idle timeout, it writes a
`_hb: "stop"` heartbeat and exits.

### One Daemon Per Session

Each daemon instance watches exactly one `session.jsonl` and writes to one
`classified.jsonl` (placed alongside the source or in a cache directory).

---

## Consumer Changes Required

### DRY Constraint: Single Classifier Implementation

Both the daemon (disk-based) and the Pi TUI widget (in-memory) must use the
**same** `parseEntryToInteraction` and `classifyInteraction` functions. These
already live in `extensions/lib/wtft-shared.ts`. The daemon imports them from
there — no duplication.

### Pi TUI Widget (`extensions/wtft.ts`)

Keeps the in-memory path via `ctx.sessionManager.getBranch()`. The Pi harness
fires notifications (`agent_end`, etc.) faster than 90bpm, and the TUI can
render at that rate — no throttling needed in the TUI path.

The TUI widget **does not** use the daemon or read `classified.jsonl`. It uses
the shared classifier functions directly on in-memory entries.

### CLI `wtft --watch`

Currently reads `session.jsonl` directly with incremental parsing. Switch to
reading `classified.jsonl` — no parsing, no classification, just bin-and-render.
Auto-spawns daemon if not running.

### CLI `wtft` (one-shot)

Currently reads entire `session.jsonl`. Switch to reading `classified.jsonl`
if available (fast path — already classified, no re-parse). Fall back to
`session.jsonl` if no cache exists, spawning the daemon for future runs.

---

## Future: wtft --webui

A separate daemon process that:

1. Reads `classified.jsonl` (same disk contract as other consumers).
2. Serves a WebSocket endpoint.
3. Pushes classified events to connected clients.
4. Optionally streams events to a companion LLM for pattern detection.

This is intentionally out of scope for this issue. The `classified.jsonl` format
is the stable interface that enables it.

---

## Road Not Taken

- **Inline cache (no daemon):** Serialize Interaction[] directly without
  separation. Rejected — doesn't create the harness-agnostic format needed
  for future consumers (WebUI, LLM detector).
- **SQLite cache:** WAL mode handles concurrent reads natively, supports
  indexed queries. Rejected — overbuilt for an append-only, always-full-scan
  workload. JSONL is simpler and `jq`-able.
- **One daemon for all sessions:** More efficient process count, but adds
  multi-session state management. Rejected — most sessions won't have daemons,
  and per-session isolation matches the one-`classified.jsonl`-per-`session.jsonl`
  model.
- **TUI widget reads classified.jsonl:** The Pi TUI already has in-memory
  parsed entries and can update faster than 90bpm. Switching to disk adds I/O
  with no benefit. TUI stays on in-memory path.
