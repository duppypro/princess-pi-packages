# WTFT --watch Live Mode — Spec (#45)

## Summary
Add `--watch` flag to WTFT CLI: watches session `.jsonl` for changes and re-renders bar chart in-place in a terminal. Targeted at Claude Code users running WTFT in a companion tmux pane.

## Design

### Watch mechanism — `fs.watchFile()`
- Poll every 500ms (reliable for append-only `.jsonl`, unlike `fs.watch` which can miss events on VPS filesystems)
- Track byte offset: only parse new bytes since last read
- Handle partial writes: if last line is incomplete JSON, skip it and retry next tick
- Detect file rotation/truncation: if file shrinks, reset offset to 0 and re-parse

### Rendering loop
1. Read new bytes → split on `\n` → parse each complete line as JSON → `parseEntryToInteraction()`
2. Accumulate all interactions into array
3. Call `buildWtftLines()` with accumulated interactions
4. ANSI clear + reposition: `\x1b[2J\x1b[H`
5. Print all lines
6. Print status footer: `Watching <session-filename> (<N> interactions, $<total>) — Ctrl+C to exit`
7. `process.stdout.write()` the full output (single write = double-buffer-like, avoids flicker)

### Terminal resize
- Install `SIGWINCH` handler → set a `needsRedraw` flag
- Next poll cycle picks up the flag and re-renders with updated terminal width
- `getTerminalWidth()` already handles this dynamically

### Graceful shutdown
- `SIGINT` handler: clear screen, print final stats, `process.exit(0)`
- `process.on('exit', ...)`: restore cursor (`\x1b[?25h`)

### CLI flag
- `--watch` / `-W` (uppercase W, distinct from `-w` width flag)
- All existing WTFT flags support: `--session`, `--interval`, `--mode`, `--limit`, `--no-ticks`, `--tz`

### Implementation location
- New function: `watchMode()` in `bin/wtft.mjs` (and `bin/wtft.ts`)
- Reuses existing `parseEntryToInteraction()` and `buildWtftLines()` — no changes to shared lib
- Manifest `wtft-cmd.json`: add `--watch`/`-W` to usage and examples

## Edge Cases
- **Empty/missing session file**: wait for first write, don't error
- **Massive sessions (100k+ lines)**: `buildWtftLines()` already handles this with limit
- **Incomplete JSON at EOF**: skip last line if `JSON.parse` throws, retry next tick
- **File deleted mid-watch**: log warning, keep watching for recreation
- **STDOUT not a TTY**: refuse to start `--watch` mode (needs a real terminal)
