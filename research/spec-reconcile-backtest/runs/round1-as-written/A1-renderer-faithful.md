Read all four artifacts plus `wtft-shared.ts`/`wtft-parser.ts` for the `Category` union.

## Contradictions

**Taxonomy**
1. EXT_WTFT.html:50 "one of 9 work types" → 14 (`wtft-renderer.ts:46-49`).
2. html:85 "the turn is `mixed`" + legend "▒ Mixed" (html:181,190) → no `mixed` category exists (`wtft-renderer.ts:46`; `wtft-parser.ts:630` "no more 'mixed'").
3. html:108-158 table lists 8 categories → silent on `plan`, `web`, `agents`, `compaction`, `interrupted`/Waste, `overhead`/Ovrhd (`wtft-renderer.ts:57-71`).
4. html:119 Spec = "Bright Green `\x1b[92m`" → fg 117, light blue (`:59`). Code="Orange 208"→179 (`:63`); Git="Cyan"→110 (`:65`); all 14 are 256-color, no `\x1b[9xm`.

**Rendering**
5. html:173 bucket overlap resolved "in the reverse priority of the legend… `Spec` always overlay" → sorts by **cost** desc, top-2 (`:1305-1308`). Legend priority unused.
6. html:173 "exactly one colored marker block" → two categories share a cell as `▌` (`:1308`).
7. html:172 cumulative "can only grow, never shrink" → clamp applies only at ≥2 half-slots (`:1113-1117`) and the excess loop decrements (`:1131`); `:1109-1112` says small segments "are allowed to flicker".
8. html:175 legend placed "on the top title row (or… second row if… narrow)" → always row 1 (`:1065-1070`).

**Flags**
9. manifest:114 / html:58 `-i <size><m|h|d|w>` → also accepts `Nt`, `Nturn`, `Nturns` (`:157`, unit `"t"` at `:133`); unparseable input silently becomes 1h (`:162`).
10. manifest:158 `--no-emoji` → "single-width ASCII used instead" → only swaps the title glyph (`:1036-1038`); clock faces, ☀️, moon, ⚡ are unconditional (`:735-736,747`), and `getTerminalWidth` takes `disabledEmoji` and ignores it (`:593`).
11. html:306 "No `-w/--width` flag… clamped at 1023" vs manifest:130 default 240 → width honored (`:815-816`), clamp is a **floor of 40** (`:1013`), no 1023.
12. manifest:194 `--tokens` = "per-model token summary table" → also switches bars to ▃/▇ block-height, adds key + `↑↓R CH` footer (`:1219-1271,1344-1358`).

**Silent behavior**
13. No artifact mentions the auto "Other" bloat warning at >20% **and** >$6.00 (`:1336`).
14. Nothing documents the `CH: n% cache hit` line (`:1364`) or that `renderTokenSummary` drops `(unknown)`/`<synthetic>` rows (`:1567-1570`).
15. html:72 "primary executable… names" → path stripping happens only in grouping (`:1410`); `/usr/bin/ls` stays a separate histogram row (`:1444`). Bars silently truncate at `barWidth` (`:1524`).

**Docstrings**
16. `:87-89` footer example "CH99.7%" → `toFixed(0)`, never a decimal (`:103`).
17. `:764` "undefined if no cache-related tokens" → returns 0% whenever plain `inputTokens` exist (`:772`).
18. `:19` key "e.g. `2026-07-15T18:00`" → keys carry seconds (`:235`) or are `turn:000010` (`:228`).
19. `:143-149` JSDoc for a `.jsonl` file parser (`@param filePath`) sits on `parseInterval` (`:150`); `:137-141` and `:165-167` banners describe functions absent from the file.
20. `:1169` "reused for cache TTL expiry" → TTL model was replaced by observed miss (`:1199-1204`).
21. `:4-8` of `wtft-shared.ts` marks the barrel `@deprecated`, "import directly from the deep modules" → `wtft-renderer.ts:9-14` imports from that barrel (circular).
