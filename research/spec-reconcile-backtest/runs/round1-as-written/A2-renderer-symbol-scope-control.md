## Audit: `buildTimelineString` + attached comments

**A. The docstring isn't attached to the function at all.**
The JSDoc at `extensions/lib/wtft-renderer.ts:693-700` is separated from `export function buildTimelineString` (`:718`) by `MOON_PHASES`, `SYNODIC_MONTH_MS`, `REF_NEW_MOON` and `getMoonPhase` (`:701-716`). TS/editor hover attaches it to `MOON_PHASES`, so the function ships with no visible doc.

**B. Contradicted claims**

| Artifact line | Code | What the code does |
|---|---|---|
| `* (---[colored]---◆---) [⚡ SURGE 2x] [⚡ SURGE APPROACHING]` (`:695`) | `:748` `let result = \`${moon}${timelineBody}${moon}\`` | No parentheses. The string is bookended by a moon-phase emoji on both ends. |
| `@param currentHour - Current local hour (0-23) for diamond marker` (`:699`) | `:735-736` `CLOCK_FACES = ["🕛","🕐",…]` … `char = (isCurrent && h !== 12) ? CLOCK_FACES[h % 12] : …` | No `◆` exists anywhere in the function. The current hour renders as a clock-face emoji. |

**C. Silent / partial claims**

1. **`'ending'` is an accepted input the format line never mentions.** `:695` lists only `[⚡ SURGE 2x] [⚡ SURGE APPROACHING]`, but the signature accepts `'ending'` (`:721`) and `:754-755` emits `⚡ SURGE ENDING` in bold-blink green. A reader concludes only two badges exist. `@param proximityStatus - If set, appends the appropriate surge badge` (`:700`) never enumerates the three values.
2. **`date` is undocumented in the JSDoc.** The 4th parameter has only an inline doc (`:722`, accurate re `:747`); the JSDoc block has no `@param date`, so the documented arity is 3.
3. **Noon (`☀️`) is undocumented.** `:736` emits `☀️` at `h === 12` unconditionally — a fixed glyph in every timeline the docstring never describes.
4. **Current hour at noon has no glyph.** `:736`'s `h !== 12` guard means when `currentHour === 12` the marker is suppressed; only the bold color (`:732`) distinguishes it. The docstring promises a marker for "current local hour (0-23)" without exception.
5. **Emoji output isn't optional.** Callers thread `disabledEmoji` (`:799`, `:813`), but `:1056` calls this with 3 args and `:736`/`:747` emit emoji unconditionally. The docstring is silent on this.

**Verified-clean (checked, no contradiction):** `:701` "8 phases" matches the 8-element array; `:704` reference date matches `:705`; `:710-712` "offset by half a phase width" matches `/16` at `:713` (29.53/16 ≈ 1.85d ≈ ±1.8d as claimed); `:734` "never at noon — ☀️ owns position 12" matches the ternary exactly; negative-date wraparound at `:709` is handled.

Nothing fixed, as requested.
