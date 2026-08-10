Read all four artifacts plus `config.ts`'s own comments. Contradictions found:

**1. Walk-up terminates at `/`, not `~/`**
- `config.ts:169` — "`$CWD/.princess-pi-packages/<tool>.json` (with walk-up to ~/)"
- `config.ts:154` — `if (parent === dir || parent === "/") break;` walks to filesystem root. A config in `/tmp/.princess-pi-packages/` is loaded from any cwd below it.

**2. `getConfigPaths` returns no legacy paths**
- `config.ts:117-118` — "Also returns legacy paths (old directory) for migration read fallback."
- `config.ts:119-126` returns only `{global, local}` under `CONFIG_DIR`. Legacy paths live in a separate unexported `getOldConfigPaths` (`:128`).

**3. `readConfig` is not a flat/shallow read**
- `config.ts:204` — "Returns flat merge (no walk-up, shallow merge) for backward compat."
- `config.ts:207` delegates to `loadConfig`, which does walk-up (`:190`) and deep merge (`:187`).

**4. `XDG_CONFIG_HOME` honored on read, ignored on write**
- `config.ts:29` — "`~/.config/princess-pi-packages/<tool>.json`"
- `config.ts:181` uses `process.env.XDG_CONFIG_HOME`; `config.ts:120` hardcodes `homedir()/.config`. With XDG set, `writeConfig`/`hasConfig` target a path `loadConfig` never reads.

**5. Writes destroy comment-bearing configs**
- `config.ts:3` — "JSON with comments (stripJsonComments)."
- `config.ts:245` uses bare `JSON.parse`; the `catch` at `:249` silently yields `existing = {}`, so `:253` overwrites the file — comments and all prior keys lost.

**6. `stripJsonComments` corrupts string values**
- `config.ts:49` — "Strip // single-line and /\* block comments from JSON."
- `config.ts:52` truncates any line containing `//` inside a string (`"https://…"`), making the file unparseable → `tryReadConfig` returns `null` (`:69`) and the config is silently ignored.

**7. `hasConfig` misses walk-up configs**
- `config.ts:260` — "Check whether any config file exists for a tool (global or local)."
- `config.ts:263-270` checks only cwd + home; a parent-directory config that `loadConfig` applies reports `false`.

**8. `WtftConfig` is incomplete and unused**
- `config.ts:35-42` omits `tokens`, read at `bin/wtft.ts:166`; manifest calls `--tokens` "Config-persistable" (`wtft-cmd.json:195`). No API is typed with it — both `loadConfig`/`readConfig` return `Record<string, unknown>`.

**9. Manifest silent on config files**
`wtft-cmd.json` mentions only `wtft-pricing.json` (`:199`). `interval`/`limit`/`mode`/`showTicks`/`timezone`/`disabledEmoji` all persist (`config.ts:35-42`, read at `bin/wtft.ts:423-429`), and project-local `.princess-pi-packages/wtft.json` is unmentioned — a reader concludes neither is supported.

**10. Manifest default `limit` wrong**
- `wtft-cmd.json:119` — "default: 10"; `bin/wtft.ts:161` passes `limit: 100`.

**11. Tests run against `.ts`, not `.mjs`**
- `build-and-toolchain.md:9` — "Tests must run against the built `.mjs`."
- `tests/config-loader.test.ts:44` imports `../extensions/lib/config.ts`. No `bin/config.mjs` exists; `build.ts:158` only builds `bin/<name>.ts`, so `config.ts` is inlined into `bin/wtft.mjs:4022`.
