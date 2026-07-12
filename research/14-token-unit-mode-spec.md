# Spec Draft: Token-Unit Mode — Visual Encoding Options for #14

Issue: [FEAT: wtft token-unit mode (vs cost) with custom scale factors](https://github.com/duppypro/princess-pi-packages/issues/14)

## Goal

Show both token volume and cost in the same bar chart so the user can spot where
cheap-token strategies diverge from cheap-cost strategies. The visual gap between
the two dimensions is the signal.

## Dataset for Examples

A session with three 1-hour intervals:

| Interval | Category | Input Tokens | Output Tokens | Cache-Read | Cost ($) |
|----------|----------|-------------|--------------|------------|---------|
| 13:00    | Spec     | 8,000       | 1,000        | 2,000      | $0.0216 |
| 13:00    | Code     | 1,000       | 500          | 0          | $0.0083 |
| 14:00    | Spec     | 3,000       | 500          | 500        | $0.0083 |
| 14:00    | Code     | 800         | 2,000        | 0          | $0.0240 |
| 15:00    | Code     | 2,000       | 2,500        | 0          | $0.0313 |
| 15:00    | Git      | 0           | 0            | 0          | $0.0000 |

Token totals (per interval): 13:00 = 12,500, 14:00 = 6,800, 15:00 = 4,500
Cost totals (per interval): 13:00 = $0.03, 14:00 = $0.032, 15:00 = $0.031

Key observations:
- 13:00: largest token count, mid-range cost (cheap input/cache tokens drag $ down)
- 14:00: medium tokens, highest cost (output-heavy Code drives $ up)
- 15:00: smallest tokens, same cost as 13:00 (all output, no cache)

---

## Option 2: Vertical Split (two rows per bar interval)

Each interval renders two rows:

1. **Token row**: bar scaled to token proportions. One prefix showing total tokens.
2. **Cost row**: bar scaled to cost proportions (identical to today's $ chart). One prefix showing total $.

The comparison is vertical — your eye scans down to see whether token-width and cost-width
align or diverge for each segment.

### Layout

```
                   ── token-scale ──
13:00  12.5k        ████████████████      ← Spec: 9.6k, Code: 2.9k (tokens)
         $0.03      ████████              ← Spec: $0.022, Code: $0.008 (cost)
                   ── cost-scale ──
14:00   6.8k        ████████              ← Spec: 5k, Code: 1.8k
         $0.032     ██████████████        ← Spec: $0.008, Code: $0.024
15:00   4.5k        ████████████          ← Code: 4.5k (100%)
         $0.031     ██████████████        ← Code: $0.031 (100%)
```

### Detailed render (with actual ANSI colors)

```
── Jul-11 ────────────────────────────────────────────────────
13:00  12.5k  ████████████████████████
        $0.03  ██████████████████████
14:00   6.8k  ████████████████████████████████
        $0.03  ██████████████████
15:00   4.5k  ████████████████████████████████
        $0.03  ██████
```

### Visual signal

- **13:00**: token bar slightly wider than cost bar → cheap tokens (input/cache-heavy Spec)
- **14:00**: token bar narrower than cost bar → expensive tokens (output-heavy Code)
- **15:00**: token bar much wider than cost bar → dirt-cheap tokens (no output, pure operations?)

The divergence IS the signal. Same-width = cost-per-token is average. Wider token = cheaper.
Wider cost = more expensive per token.

### Pros
- Unambiguous — nothing is overlaid, no density tricks
- Reader can directly compare token vs cost widths segment by segment
- Same legend works for both rows (color = category)

### Cons
- Doubles vertical space per interval
- For 10 intervals + legend + timeline + cache line, that's ~30 rows — may overflow Pi's widget
- Two rows per interval could be confusing ("is this one bar or two?") without clear labeling

---

## Option 4: Char + BG Per Cell (single row, hybrid overlay)

Each bar segment is a single row. Two dimensions encoded simultaneously:

1. **Background color width** = token proportion. The filled-background region spans the token-scaled
   width. Category determines background hue (green=Spec, orange=Code, etc.)
2. **Foreground character density** = cost/divergence signal. The character drawn on each cell
   varies from ░ (sparse — cost cheaper than tokens suggest) to █ (dense — cost more expensive
   than tokens suggest).

The bar width = token-scaled. Within that width, dense chars mean "expensive" and sparse chars
mean "cheap relative to token count."

### Density encoding

For each cell, the cost-per-token for that segment within that interval determines density:

| Cost/tok vs session average | Density | Meaning |
|---------------------------|---------|---------|
| Much cheaper (≤0.5× avg)  | ░       | Input/cache-heavy — tokens inflated, cost low |
| Cheaper (0.5-0.8× avg)   | ▒       | Some cheap tokens mixed in |
| Average (0.8-1.2× avg)    | ▓       | Token→cost conversion is linear (average blend) |
| More expensive (1.2-2× avg)| █ solid | Output-heavy — each token costs a lot |
| No tokens (pure $)        | █ solid | e.g. web search fees — cost with zero tokens |

**Note**: when tokens=0 but cost>0 (server tool fees like web search), the background has
nothing to fill but the cost is real. These use a distinct foreground color (current web
orange-gold) at solid density, no background fill.

### Layout

Single row per interval, same as today. The prefix changes to show tokens instead of $:

```
💸 WTF Tokens?  (── Jul-11 ──)
13:00  12.5k  ████████████████░░░░
14:00   6.8k  ▒▒▒▒████████████████
15:00   4.5k  ████████████████████
```

### Detailed render (with ANSI)

Using terminal notation where `\x1b[48;5;N` = background color N, `\x1b[38;5;M` = foreground M:

```
── Jul-11 ────────────────────────────────────────────────────
13:00  12.5k  [bg-green ████████][bg-green ████████][bg-green ░░░░][bg-orange ▓▓▓][bg-orange ████]
              ←  Spec tokens (8k input)  →  ← Spec cheap → ← Code →
              
14:00   6.8k  [bg-green ▒▒][bg-green ███][bg-orange ████████][bg-orange ████████]
              ← Spec →  ← expensive Code output →

15:00   4.5k  [bg-orange ████████████████████]
              ← Code output-heavy, 100% dense →
```

### Per-interval density signal summary

- **13:00**: Spec segment = mostly █ (input tokens, cheap) then ░ at tail (cheaper per token than average), Code segment = ▓ (average blend)
- **14:00**: Spec segment starts ▒ (some cheap tokens), Code = █ (all expensive output tokens)
- **15:00**: Code = ██ solid throughout (pure output tokens → most expensive per token)

### Pros
- Single row per interval — same vertical density as today's widget
- Bar width = token scale gives immediate "which intervals used most tokens?"
- Density = pricing distortion gives "where are tokens being wasted on expensive operations?"
- Category color preserved as background hue

### Cons
- Density reading requires learning a legend (░ cheap → █ expensive)
- Overlaid encoding is less precise than side-by-side comparison
- Background colors may not work well in all terminal emulators
- Need to ensure foreground category colors are still visible against the colored backgrounds

---

## Decisions (grilling session 2026-07-11)

1. **Encoding**: Option 4 (Char + BG per cell) — single row, bg = token width, fg density = cost-per-token signal
2. **Legend**: Decoupled — category color stays same, separate density key bar below chart
3. **Interaction**: `--tokens` toggle flag — no flag = cost mode (current default), `--tokens` = token-unit mode
4. **Flag collision**: Merge into existing `--tokens` flag — bar chart switches to token mode AND summary table still renders below
5. **No `--cost` inverse flag** — remove from config to revert
6. **Total token formula**: `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens` (Anthropic API fields are mutually exclusive, no double-counting)
7. **Input/output distinction**: Density gradient covers it — input-heavy = sparse (░), output-heavy = dense (█). No explicit token-type breakdown needed
8. **Bin type**: Extend `Bin` with `tokens: Record<Category, { total: number; output: number }>`, `total_tokens`, `incremental_tokens`
9. **Density formula**: `outputShare = segment.outputTokens / segment.totalTokens` → map ░(0-25%) ▒(25-50%) ▓(50-75%) █(75-100%). No cost normalization needed.
10. **Bin token granularity**: Minimal — only `{ total, output }` per category. Full breakdown deferred.
11. **Per-bar prefix**: `14:00  +3.4k  12.5k tok` — same structure, swap `$` for `tok`. No inline output-share.
12. **Server tool costs**: Render as 1-char `◆` marker at bar tail, distinct color. No bar width. Explained in density key.
13. **Density key bar**: `cheap $/tok  ░░ ▒▒ ▓▓ ██  expensive $/tok` — single row below chart, 4-block gradient.
14. **Footer summary**: Add `↑47k ↓14k R1.3M CH99.7%` line below chart in token mode — mirrors Pi/Claude footer.
15. **Custom scale factors**: DEFERRED — open follow-up issue. Density gradient already answers "where are expensive tokens?"
16. **Quota mode**: DEFERRED — needs its own grilling session. Unknown data dependency (subscription limits).
17. **Renderer architecture**: Extract shared binning/ticks/date-header into helpers. Two separate render functions: `buildCostBars()` (current) and `buildTokenBars()` (new). Caller dispatches based on `unit` param.
18. **Config persistence**: Add `tokens: boolean` to `~/.config/pi/wtft.json`. CLI flag overrides.
19. **Background color palette**: Dedicated 256-color bg codes per category (see table below). Density chars in bright white (15) against dark backgrounds.
20. **Test strategy**: Unit test density calc + snapshot test for token mode output + parity test with cost mode.
21. **Density key bar**: Position between last bar and footer summary. Category legend (top) = what colors mean; density key (bottom) = how to read overlay.
22. **Footer summary format**: `↑47k ↓14k R1.3M CH99.7%` — exact Pi footer convention. No cost total in token mode.

## Background Color Palette (Token Mode)

Density characters render in `\x1b[38;5;15m` (bright white) against dark backgrounds.

| Category | FG (cost mode) | BG (token mode) | BG Name |
|----------|---------------|-----------------|---------|
| Spec | 108 (sage green) | 22 (dark green) | Deep forest |
| Mixed | 108 on 173 | 94 (dark gold) | Earth tone |
| Code | 173 (terracotta) | 130 (dark orange) | Burnt orange |
| Tests | 223 (sand) | 178 (dark sand) | Warm tan |
| Research | 134 (plum) | 54 (dark purple) | Midnight plum |
| Git | 73 (teal) | 23 (dark teal) | Deep teal |
| Grep | 67 (steel blue) | 24 (dark blue) | Navy |
| Web | 209 (orange-gold) | 88 (dark red) | Crimson |
| Prompt | 168 (rose) | 89 (dark rose) | Mauve |
| Other | 238 (charcoal) | 236 (dark charcoal) | Near-black |

## Comparison (historical)

| | Option 2 (Vertical Split) | Option 4 (Char + BG) **← chosen** |
|---|---|---|
| Rows per interval | 2 | 1 |
| Ambiguity | None — two separate bars | Moderate — density is comparative |
| Learning curve | Low — it's just two bar charts | Medium — density scale is unfamiliar |
| Best for | Precise comparison of specific intervals | Scanning for outliers at a glance |
| Fits Pi widget? | Tight — 10 intervals = 20 rows + overhead ~30 | Yes — same height as today |
| Test cost | Low — reuse existing bar renderer twice | Higher — new render path, terminal compat testing |
