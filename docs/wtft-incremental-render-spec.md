# WTFT `--watch` Live Render + Log Parser Daemon Health Monitoring + SURGE Timeline

**Status:** Code and Spec Approved — updated 2026-08-01 with #124 additions

## Goal

Provide a live-updating cost chart in wtft `--watch` mode, backed by a persistent log parser daemon that pre-classifies session entries into a harness-agnostic tag file. The TUI watches the tag file via inotify (`fs.watch`) for zero-latency updates, and monitors the daemon's health with a colored status indicator on the title line. All render paths (Pi widget, CLI non-watch, CLI `--watch`) share a single SURGE timeline rendering inside `buildWtftLines`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  wtft-daemon — detached, singleton per                  │
│  session. Polls session.jsonl every 667ms, classifies   │
│  entries, writes to wtft-tags/<session>.tag.v2.3.4.jsonl│
│  Tag format includes message.id for cross-run dedup.    │
│  Heartbeats: single _hb line updated in-place per idle  │
│  cycle (consolidated, not appended).                     │
│  Poll loop wrapped in try/catch: transient errors       │
│  (disk full, bad JSON) are logged, daemon survives.     │
│  Idle exit: 24h of no new data → clean shutdown.        │
│  Startup grace: 60s before idle exit can fire.          │
│  Costs rounded to 6 decimal places before JSON write    │
│  (eliminates float drift vs in-memory widget).          │
│  Version-aware singleton: detects old tag file, kills    │
│  old daemon, auto-upgrades — no manual restart needed.  │
└────────────┬────────────────────────────────────────────┘
             │  tag file (fs.watch / inotify)
             ▼
┌─────────────────────────────────────────────────────────┐
│  wtft --watch (TUI consumer)                             │
│  Reads initial classified entries from tag file, then   │
│  watches for changes via fs.watch. Collapses lines      │
│  sharing a message.id to one interaction at max cost    │
│  (#270 review) — on the initial read AND on every       │
│  incremental append. Renders full chart                 │
│  on every new data event + per-minute timeline refresh. │
│  Monitors daemon health via PID file + _hb heartbeat.   │
│  'r' key restarts the daemon (5s fast-poll after).      │
└─────────────────────────────────────────────────────────┘
```

**Why daemon + fs.watch, not polling:**
- Polling directly on session.jsonl required re-parsing classified data on every tick
- The daemon does the expensive classification once, consumers read pre-computed entries
- `fs.watch` on the tag file gives zero-latency updates vs. 667ms poll worst-case
- Same classified tag file format works across Pi (in-memory) and CLI (daemon-backed)

## Log Parser Daemon Lifecycle

| Event | Behavior |
|---|---|
| `session_start` (Pi) or `wtft` / `wtft --watch` invoked (CLI) | Auto-spawns daemon if not already running (singleton via PID file) |
| New session data arrives | Daemon parses, classifies, flushes to tag file at 90bpm throttle |
| No new data for 24h | Daemon cleanly exits ("idle timeout") |
| Daemon just spawned (< 60s) | Idle exit suppressed (startup grace period) |
| Session file deleted | Daemon exits ("session removed") |
| Session file not yet created | Daemon waits (no exit), writes heartbeats so widget shows "waiting for session .jsonl..." (#124) |
| Press `r` in `--watch` | Kills stale daemon, spawns fresh, fast-polls health at 1s × 5 |
| **New activity after idle timeout** | Pi's `agent_end` handler calls `ensureParserRunning`, which checks daemon health via `checkDaemonHealth` and re-spawns if dead |

## Sub-Agent Transcript Read Path (#270 / #420)

Two kinds of sub-agent transcript exist, discovered and written differently, and only one of them is re-read on every poll:

| Kind | Discovery | Discovery→write | Per-file state |
|---|---|---|---|
| Task/agent/workflow sub-agents (#82) | `discoverSubagentSessionFiles(sessionPath)`, re-run every poll | Re-parsed WHOLE on every `size`/`mtimeMs` change, appends only unwritten lines (#270) | `discoveredSubagentFiles: Map<sessionId, {size, mtimeMs, writtenLines}>` (`bin/wtft-daemon.ts:155`) |
| `claude -p` bash sub-agents (#138) | `discoverClaudeSubAgentSessionFiles(cwd, ts)`, re-run every poll while pending | Parsed ONCE, at first discovery, via `writeSessionToTagFile` (`bin/wtft-daemon.ts:341-346, 440-454`) | `discoveredClaudeSessions: Set<sessionId>` — boolean seen-set, no size/mtime tracking (`bin/wtft-daemon.ts:88`) |

Everything below describes the first row — the #270 fix. **The second row still has #270's original bug**: a `claude -p` bash sub-agent transcript discovered while the invoking command is still running has whatever it writes afterward silently dropped, because `discoveredClaudeSessions` records only "seen," never "seen at what size." It is a narrower window than #270's original parent-facing bug (the invoking bash command usually finishes inside one or two polls), but it is not fixed on this branch, and neither #270 nor #420 name it — recorded here so the next re-read of this section doesn't assume both paths were fixed together.

**Why the parent is incremental and a sub-agent transcript is not.** The parent `session.jsonl` is one file the daemon owns exclusively and only ever appends to; `parseNewLines` (`bin/wtft-daemon.ts:456`) tracks a byte offset (`lastSize`) and reads only the delta each poll, threading parse state forward. A Task/agent sub-agent transcript is a file the daemon does not own — written by a subprocess the daemon only observes, discovered while that subprocess is still running (`bin/wtft-daemon.ts:102-105`). Byte-offset incremental reading was built for it and reverted: every invariant the parser provides turned out to be scoped to "the whole array `parseSessionFile`/`deduplicateInteractions` is handed," and a poll batch is a smaller, different array than the whole file. Three review rounds found the same shape of defect:

- `deduplicateInteractions` (`extensions/lib/wtft-parser.ts:566`) collapses lines sharing one `message.id`, keeping the max-cost copy. This is the common case, not an edge case — measured across twelve live transcripts, 40–76% of message ids carrying `usage` are re-emitted with growing cost across several lines (`tests/wtft-270-subagent-crosspoll-dedup.test.ts:17-22`). Two emissions of the same id landing in *different* poll windows never meet inside one `deduplicateInteractions` call, and get summed instead of collapsed.
- `attributeClaudeSubAgentCosts` (`extensions/lib/wtft-parser.ts:977`) opens `const seenSessionIds = new Set<string>()` (line 980) — scoped to the single call, not global (see below). Calling it once per poll batch — which happens automatically, since it runs inside `parseSessionFile` (`extensions/lib/wtft-parser.ts:485`) — attributed the same nested `claude -p` grandchild session's cost twice, once from each batch that referenced it (`tests/wtft-270-subagent-nested-claude-attribution.test.ts:5-22`).
- A failed tag-file append had to rewind the read offset but could not un-mutate the stream state it had already advanced, silently losing compaction attribution.

**The fix**: on every poll, `scanForSubAgents` (`bin/wtft-daemon.ts:321`) stats each known Task/agent sub-agent file; if `size`/`mtimeMs` moved, it re-parses the file WHOLE — `deduplicateInteractions(parseSessionFile(file))` (`bin/wtft-daemon.ts:393`), the exact single-call shape both functions above assume — and appends only the serialized lines not already on disk for that file (`bin/wtft-daemon.ts:394-405`). A quiet transcript costs one `stat` and nothing else (`bin/wtft-daemon.ts:376`). The comment at the call site is explicit that this must stay a single call per poll: "do NOT add a second call here, that is the round-3 High" (`bin/wtft-daemon.ts:391-392`).

**The append filter, and what the tag file may contain.** `writtenLines` is a multiset (`Map<hash, count>`) of sha1 hashes of tag-file lines already appended for that transcript (`bin/wtft-daemon.ts:99, 396-405`). Usage growing on a re-emitted `message.id` changes the serialized line, so it hashes differently, so it is appended again alongside the earlier line for that id — the READER, not the writer, is responsible for collapsing them: `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts:172`) does that collapse on every read, taking max cost, exactly as `deduplicateInteractions` would over the whole file. An unchanged line hashes the same and is skipped — this is the cost bound that makes "re-parse whole every poll" viable at all; without it, re-appending a transcript's unchanged prefix every poll is O(n²) over its lifetime (`tests/wtft-270-subagent-tagfile-growth.test.ts`). The counter is a multiset rather than a plain set because two distinct interactions can serialize identically (no `message.id`, same millisecond, same content) — a set would silently drop the second, the exact bug class this exists to prevent (`bin/wtft-daemon.ts:133-136`).

So: **a subagent's growing-usage message legitimately appears as multiple tag-file lines sharing one `message.id`, at different costs, written across different polls.** This is expected, not a defect. Every reader of a tag file that may hold sub-agent lines must collapse by `message.id` (max cost) before summing; `readClassifiedTagFile` (`extensions/lib/wtft-daemon-lib.ts:204-225`) runs `dedupeClassifiedById` on every read so no caller can forget it, and `--watch` does the same collapse on both its initial read and every incremental append (see the consumer diagram above).

**What bounds tag-file growth.** Nothing does, formally. `discoveredSubagentFiles` holds one `SubagentFileState` per sub-agent transcript ever discovered in the daemon's life, never evicted — eviction was tried twice and reverted, because `discoverSubagentSessionFiles` re-lists every transcript on disk every poll, so an evicted entry is simply re-discovered next poll with an empty `writtenLines` and re-appends its whole transcript from scratch (`bin/wtft-daemon.ts:146-154`). In practice it is bounded by how many sub-agents one session spawns and how much each writes: measured at 147 real transcripts on this host (median 417KB, max 1.18MB), whole-parse+dedupe+serialize+hash costs 2.89ms median / 9.06ms max per file, 421.7ms total for all 147 against the 667ms poll budget — a worst case that cannot actually occur, since only changed files are re-read (`bin/wtft-daemon.ts:138-144`).

## `attributeClaudeSubAgentCosts`: Per-Call, Not Global

The docstring at `extensions/lib/wtft-parser.ts:975-976` reads: *"Sub-agent session IDs are tracked globally to prevent double-counting across multiple interactions that reference the same session."* This is true only for a single call. `seenSessionIds` (line 980) is a local `Set` created fresh every time the function runs; it has no lifetime beyond that one call.

The invariant the function actually provides: within the array of interactions handed to it in one call, no nested `claude -p` session's cost is attributed twice. It provides no protection across two separate calls — whether those calls are seconds apart in the same poll, or a beat apart across two polls.

`attributeClaudeSubAgentCosts` runs exactly once per whole-file parse, invoked internally by `parseSessionFile` (`extensions/lib/wtft-parser.ts:485`). The daemon's Task/agent read path preserves the "one call, whole file" shape by construction — `scanForSubAgents` always calls `parseSessionFile` on the full transcript, never a batch slice (`bin/wtft-daemon.ts:391-393`). The bug this recorded (`tests/wtft-270-subagent-nested-claude-attribution.test.ts`) was an earlier cut of #270 that called this path once per poll batch: two bash turns invoking `claude -p` against the same project, landing in different poll windows but resolving to the same nested session file (inside `discoverClaudeSubAgentSessionFiles`'s ±15s matching window), each attributed that nested session's full cost — doubling it, with nothing in the output signaling the double-count.

**Rule for any future caller**: never call `attributeClaudeSubAgentCosts` — directly, or indirectly via `parseSessionFile` — over anything less than the complete file whose nested sessions you intend to dedupe. A partial slice does not error; it silently produces a partial, non-global, `seenSessionIds`.

## `deduplicateInteractions`: Return Order Is Not Chronological

`deduplicateInteractions` (`extensions/lib/wtft-parser.ts:566-585`) returns `[...withoutId, ...oneCollapsedInteractionPerId]`: every interaction with no `messageId` first, in original relative order (`withoutId`, declared line 568, spread at line 583), followed by one collapsed interaction per distinct `messageId`, ordered by that id's FIRST occurrence in the input (`Map` insertion order, iterated at line 585) — not by timestamp, and not interleaved with the `withoutId` items' true chronological position.

**`deduped[deduped.length - 1]` is never guaranteed to be the chronologically last interaction.** Code that indexes the last element of this function's output to mean "the most recent turn" is wrong whenever the input mixes id-bearing and non-id-bearing interactions, or whenever the chronologically-last interaction is not the last distinct id to first appear. A caller that needs chronological order must sort by `timestamp` itself — this function does not provide it.

This is a narrower, different guarantee than `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts:172-202`), the tag-file reader's own collapse function, whose docstring explicitly promises first-appearance-order preservation ("a pure subtraction... same sequence minus the duplicates," lines 167-170) so append-order consumers (bucket rendering, `limit`) see a stable sequence. `dedupeClassifiedById` calls `deduplicateInteractions` only to resolve ONE id-group at a time (line 199) and reassembles the surrounding order itself via `slots`/`slotIds` — it does not inherit `deduplicateInteractions`'s ordering, it builds its own on top of it.

## Terminal Layout (watch mode)

```
Row 1:  sessionPath  (dim)
Row 2:  💸 WTF Tokens?  (◆--orange--green--|--green---orange--◆) ⚡ SURGE 2x  ● live
Row 3:  [legend: Spec, Mixed, Code, Tests, Research, Git, Grep, Prompt, Other]
Row 4+: ticks line (if --ticks), date dividers, bucket rows
Footer: q/Ctrl+C to exit, 'r' to restart  (r in red when daemon dead)
```

The 24-hour SURGE timeline and daemon status indicator are appended inline to the title line if they fit within terminal width; otherwise they wrap to separate lines between title and legend.

## Daemon Status States

| State | Indicator | Trigger |
|---|---|---|
| Alive | `🟢 live` (green) | PID alive |
| Dead | `🔴 stopped HH:MM` (red) | PID dead, last _hb timestamp shown |
| Restarting / Starting | `🟡 starting...` (yellow) | Daemon spawned but PID file not yet claimed; 5s grace window (#124) |
| Waiting | `🟡 waiting for session .jsonl...` (yellow) | Daemon alive or just spawned, but session file doesn't exist yet (#124) |

Health is checked:
- 10s after `--watch` startup
- Every 60s on the minute-boundary re-render
- After pressing `r`: every 1s for 5s (fast-poll)

## Pi Widget Integration

The Pi `/wtft` widget also spawns a log parser daemon on `session_start`, using `ctx.sessionManager.getSessionFile()` to determine the session path. This keeps the wtft-tag file warm for CLI use. The widget renders its own daemon status indicator on the title line (inline or wrapped), using the same `checkDaemonHealth`/`getTagPath` functions.

**Daemon auto-revive:** If the daemon died from idle timeout (24h), the Pi `agent_end` handler calls `ensureParserRunning`, which now checks actual daemon health via `checkDaemonHealth` before trusting the module-level `_parserSpawned` flag. If the daemon is dead, the flag is reset and the daemon is re-spawned. This keeps `wtft --watch` in an external terminal alive even after long idle periods — just type a new prompt and the daemon wakes up.

## SURGE Timeline (24-hour pricing bar)

The 24-hour timeline on the title line shows DeepSeek peak-valley surge pricing windows:
- **Orange segments**: Local hours that fall within surge windows (UTC 01:00–04:00, 06:00–10:00)
- **Green segments**: All other hours (normal pricing)
- **◆ diamond marker**: Current local hour
- **Surge badges**: Appended when in or near a surge window:
  - `⚡ SURGE 2x` — currently in a surge window (2× pricing active)
  - `⚡ SURGE APPROACHING` — within 20 minutes of surge start (blinking orange)
  - `⚡ SURGE ENDING` — within 20 minutes of surge end (blinking green)

**Unified rendering:** The timeline computation lives in `buildWtftLines` (one function, one call site). The `model` opt controls whether DeepSeek surge coloring is applied:
- **Pi widget**: passes `sessionCtx.model.modelId` from the session context
- **CLI paths**: auto-detects model from classified interactions (scans for "deepseek" substring)
- **Non-DeepSeek models**: renders an all-green timeline with no badges

## SIGWINCH (terminal resize)

Handler calls `render()` directly. Daemon status indicator reflows — may move from inline to separate line or vice versa depending on available width.

## Daemon Correctness Verification (#124)

The `--debug` flag was extracted from wtft into a standalone diagnostic script:

```
node debug/verify-daemon-parse.mjs --session <path/to/session.jsonl>
```

It compares three cost totals: tag file (daemon's incremental parse), direct parse+dedup
(fresh full re-parse), and raw parse (no dedup). Mismatch → exit code 1. Uses the same
`parseSessionFile` / `deduplicateInteractions` functions exported from the bundled wtft.mjs.

wtft.mjs gained an entry-point guard so importing it (e.g. from the debug script) does not
trigger `main()`.

## Settings Persistence (Cross-Harness Config)

All WTFT settings are persisted in harness-agnostic JSON config files via the shared `extensions/lib/config.ts` module. No `.jsonl` persistence — settings survive across Pi sessions, Claude Code invocations, and machine restarts. Config hierarchy: code defaults → `~/.config/princess-pi/wtft.json` → `./.princess-pi/wtft.json` → CLI flags. Widget auto-shows on session start if a config file exists. See `EXT_WTFT.html` for the full config reference.

## SIGINT / 'q'

Clears alt screen, restores cursor, prints final chart + summary line.

## Edge Cases

| Situation | Handling |
|---|---|
| Daemon exits (idle timeout, 24h) | Title shows `● stopped HH:MM` in red; footer shows red `'r' to restart` |
| No activity for 2m2s | Status flips to `● idle (M:SS to expire)` — countdown from model cache TTL. Model is read from the most recent classified tag entry (scanning past the consolidated heartbeat line). |
| Local model (no cache) | Status shows `● idle` without countdown |
| User presses `r` | Daemon restarts, status shows `● restarting...`, clears to `● live` within 5s |
| Tag file deleted/truncated | `fs.watch` handler re-reads from zero |
| Daemon spawned before session file exists | Status shows `● waiting for session .jsonl...` (yellow); daemon polls until file created (#124) |
| Daemon never started | PID check fails, status shows "daemon not found" |
| Daemon restarts after crash | Reads `_meta` offset from tag file for exact resume position; falls back to full re-parse if no meta offset found (#124) |
| Daemon encounters transient error | Error logged (debug mode), daemon continues on next poll cycle — does not crash |
| Terminal too narrow for inline status | Status wraps to separate line between title and legend |
| Session file gone | Daemon exits cleanly; TUI continues showing last-known data with stopped indicator |

## Verification

1. Start `wtft --watch` → confirm `● live` on title line
2. `kill <daemon-pid>` → within 60s, title shows `● stopped HH:MM` in red
3. Press `r` → status shows `● restarting...`, clears to `● live` within 5s
4. Wait 2m2s with no session activity → status flips to `● idle (M:SS to expire)`
5. Wait 24h with no session activity → daemon exits, title shows stopped indicator
6. Run `wtft --list` → shows running parsers with idle times
7. Pi `/wtft` widget → shows same idle/stopped states as CLI (shared `renderDaemonStatus`)
8. Terminal resize → width auto-fits; status reflows correctly (inline vs. separate line)
9. Idle for 2m2s with a remote model (Claude/DeepSeek) → countdown timer shows `(M:SS to expire)`
10. Kill daemon, restart Pi, send prompt → daemon auto-revives on agent_end (ensureParserRunning)
11. Start Pi in a git repo on `main` branch → git-guardrails shows warning notification on session_start (#124)
12. Run `node debug/verify-daemon-parse.mjs --session <path>` → reports tag-vs-direct cost match/mismatch (#124)
