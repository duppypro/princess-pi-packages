Read all four artifacts plus the source they describe (`bin/wtft.ts`, `extensions/lib/wtft-cli-shared.ts`, `wtft-renderer.ts`, `config.ts`).

## Contradictions

**1. `-w/--width` is dead in the CLI.** manifest:130 `"-w, --width <number>" … "(default: 240)"`; EXT_WTFT.html:60 same. Parser stores it (`wtft-cli-shared.ts:219-226`) but `bin/wtft.ts` never reads `opts.width` — width comes from `getTerminalWidth()` (`bin/wtft.ts:439`, `wtft-renderer.ts:593-601`), clamped to 1023. EXT_WTFT.html:306 self-contradicts: "No `-w/--width` flag", while :77 shows `!wtft -w 90 -i 1d`. The test's `-w String(columns)` (`tests/wtft-title-layout.test.ts:95`) is inert; only `COLUMNS` does anything.

**2. Default limit.** manifest:119 / doc:59 "default: `10`". Code: `loadConfig("wtft", { … limit: 100 …})` (`bin/wtft.ts:162`) and fallback `?? 100` (`:448`). 10 is only the unused parser default (`wtft-cli-shared.ts:99`).

**3. `-t` timezone does not exist.** manifest:228 example `/wtft -t America/New_York`; doc:61 `-t, --tz, --timezone`. `wtft-cli-shared.ts:74-76` says `-t` is "intentionally NOT supported"; `:227` matches only `--tz|--timezone`. Silently ignored.

**4. `-p/--pager` errors out.** manifest:146 "Launch an interactive scrollable fullscreen pager overlay" — no CLI caveat in usage. `bin/wtft.ts:245-248` prints "❌ … not available in the CLI" and `exit(1)`.

**5. `-S/--show`, `-H/--hide`.** manifest:154, examples :236/:248. Parsed (`wtft-cli-shared.ts:160-163`), never referenced in `bin/wtft.ts` — CLI no-ops.

**6. Config paths/defaults.** doc:244-245 `~/.config/princess-pi/wtft.json`, `./.princess-pi/wtft.json`; actual dir is `princess-pi-packages` (`config.ts:21,120,182`), `princess-pi` is read-only migration fallback. doc:243 "timezone=America/Los_Angeles"; code default is `undefined` (`bin/wtft.ts:451,459`).

**7. Taxonomy.** doc:50 "one of 9 work types", table lists 8. `wtft-renderer.ts:46-49` has 14 (`overhead, interrupted, plan, web, agents, compaction` undocumented; `mixed` appears in doc examples but not the table).

## Silent / partial

- Interval accepts turn units `\d+t|turn|turns` (`wtft-cli-shared.ts:206`); manifest:114 documents only `m|h|d|w`.
- `--interval=`, `--limit=`, `--width=`, `--tz=` `=`-syntax accepted (`:235-257`); undocumented.
- `--emojii` / `--no-emojii` accepted (`:164-166`); manifest:158 lists only `--emoji`.
- manifest:163 "`Ctrl+C` to exit"; code also takes `q/Q` and `r` (restart parser) (`wtft-daemon-lib.ts:821-826`).

## Test's own header

- ":6 `(CLI cost, CLI tokens, CLI --watch)`" — `CASES` has no watch case (`:117-120`).
- ":11 `Legend goes to its own row when too wide`" — legend is *always* own row (`wtft-renderer.ts:1065-1070`); `:148` says so, header disagrees.
- `:19 SCRIPT` (the `./wtft` wrapper) is declared and never used.
