# WTFT --watch Live Mode — Spec (#45)

## Summary
`--watch` flag: watches session `.jsonl` for changes and re-renders bar chart
in-place. Targeted at Claude Code users running WTFT in a companion tmux pane.

Updated: `54-55-wtft-dedup-ttl-cache` (alt screen, q-to-quit, cost dedup)

## Design

### Watch mechanism
- Poll every 667ms (`fs.statSync` + byte-offset incremental read)
- Track byte offset: only parse new bytes since last read
- Handle partial writes: skip incomplete last line
- Detect truncation: file shrinks → reset offset to 0

### Session Selection
When no `--session` flag is provided, the interactive session selector runs
**in-place on the main screen** (no alt screen). Arrow keys/j/k navigate,
Enter selects, q/Ctrl+C cancels. After selection, watch mode begins.

### Watch Mode Rendering
- **Alt screen buffer** (`\x1b[?1049h`): live updates inside alt screen.
  Main screen (with prompt + scrollback) preserved and restored on exit.
- **Home + clear** (`\x1b[H\x1b[J`) on every render inside alt screen.
- **Render loop:**
  1. Read new bytes → parse → accumulate interactions
  2. Call `buildWtftLines()` (auto-dedup by message.id via #54)
  3. Home cursor, clear alt screen
  4. Print: session path, chart, "Other" warning, `q/Ctrl+C to exit` footer
  5. SIGWINCH → immediate re-render

### Exit
- **q / Q / Ctrl+C**: raw stdin handler catches input → calls `exitWatch()`
- `exitWatch()`: exits alt screen (`\x1b[?1049l`), restores cursor, prints final
  chart to main screen (so it persists), logs session stats, exits
- Status line: `WTFT watch stopped — <N> interactions, $<total> total cost.`

### Cost Model
- Deduplicated by `message.id` (#54): Claude Code multi-line-per-message dedup
- TTL-split cache-write pricing (#55): 5-min @ 1.25×, 1-hour @ 2×
- Total displayed uses deduped costs

---

## TUI Layout
```
/home/.../session.jsonl
💸 WTF Tokens?  (timeline)
█Spec ▒Mixed █Code █Tests █Research █Git █Grep ░Prompt ░Other
── Jul-05 ────────── $0.00 ── ... ── $65.00
13:30  +$0.31  $62.65  █████████...
...
⚠️  "Other" category: 40% of session cost ($25.01). Run wtft --other to drill down.
q/Ctrl+C to exit
```

---

## Non-Watch Mode
- Selector in-place on main screen
- After selection: prints session path + chart via `console.log`
- No alt screen, no live updates
