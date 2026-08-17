# Build & Toolchain

## Generated `.mjs` Files — Hard Rule

Most `bin/*.mjs` files are **build artifacts** generated from `.ts` counterparts. Each carries a `⚠️ GENERATED` banner. Always edit the `.ts` source, then rebuild. They are tracked in git because npm's git-dependency extractor respects `.gitignore` and would omit them otherwise.

**Exception:** `bin/patch-pi-widgets.mjs` is handwritten source (no `.ts` twin) — edit it directly.

Tests must run against the built `.mjs` (the end-user path), not the `.ts` source.

### A symbol reaches the bundle only if it is re-exported (#149)

`bin/wtft.ts` (and its siblings) carry an explicit `export { … }` block, and the bundler
tree-shakes out everything absent from it. **Using a symbol inside the file is not the same
as re-exporting it.** Combined with the rule above — tests import from the built `.mjs` —
the failure mode is a suite that cannot import a function which plainly exists in the source:

```
error: Export named 'renderTokenSummary' not found in module '.../bin/wtft.mjs'
```

`renderTokenSummary` hit exactly this: pre-existing, called by `bin/wtft.ts` on every
`--tokens` run, and still unreachable from the bundle because no caller outside the file had
ever needed it. Add the name to the `export { … }` block and `bun run build`; no runtime path
changes. Expect this whenever a new suite reaches for an *existing* helper, not just a new one.

## Running Tests — `bun run test`

`bun run test` is the one way to run the suite. It drives `tests/run.ts`, which runs every
`tests/*.test.ts` **in its own process**, serially, and exits non-zero if any suite failed.

```
bun run test                 # every suite
bun run test wtft-title      # only suites whose filename matches a substring
bun run test serve wtft-auto # multiple filters are OR'd
```

**Never run `bun test` (or `vitest`, or `node --test`) over the whole `tests/` directory.**
Most suites are standalone scripts ending in `process.exit(...)`. In a shared runner
process the first suite to finish tears the run down — on `main` before #158 that meant
`bun test` ran 3 of 42 files and **exited 0**. A green result that never ran the tests is
the failure this runner exists to prevent.

### Rules a suite must follow

- **Never depend on `~/.config`.** `tests/run.ts` hands each suite a fresh, empty
  `XDG_CONFIG_HOME`. Options that are config-persistable (`wtft --tokens`/`--cost`,
  interval, timezone, …) must be passed explicitly — a bare invocation renders whatever
  the developer last saved, which is how `wtft-auto-fit` and `wtft-title-layout` came to
  fail on one machine and pass on another (#158).
- **Assert on invariants that hold at every hour.** Prefer glyphs the renderer always
  emits over ones that depend on wall-clock time or locale.
- **Either style works.** Plain assertion scripts and `describe`/`expect` suites both run —
  the driver invokes `bun test <file>`, which handles both. `git-guardrails-parity` imports
  `bun:test` and can only run this way.
- **`.test.sh` suites are not driven.** They need sudo, strace, or host state; run them by hand.
  (`serve-no-sudo-nginx.test.sh` still runs without nginx installed — its `/etc/nginx` hash step
  degrades to a `no-etc-nginx` sentinel; the VPS has had no nginx since 2026-08-17, btw#51.)
  `tests/run.ts` prints their names at the end of every run so the gap stays visible.
- **A check that cannot run must say so — `##SKIP## <reason>` (#256).** Twelve suites read
  `~/.claude`, `~/git-projects/dotfiles-doctor`, or the status-line logs. On a machine
  without that state — every CI runner, by construction — they pass having verified
  nothing, and the friendly note they print scrolls away with the rest of the output.
  Import `skip` from `tests/lib/skips.ts` and call it on the gate:

  ```ts
  import { skip } from "./lib/skips.ts";

  if (!fs.existsSync(settingsPath)) {
      skip("no ~/.claude/settings.json — not a Claude Code host, so the live drift check did not run");
      return;
  }
  ```

  `tests/run.ts` counts the markers per suite (`PASS  name  1.0s  (1 skipped)`) and lists
  every reason last, under *"N checks skipped — host state absent, not verified"*. Skips do
  **not** fail the run: a developer laptop legitimately lacks some of this state. They just
  stop `72 passed, 0 failed` from being the whole story.

  Name the missing state, not the check — a reader on CI should learn what to install to
  get the coverage back. `tests/skip-reporting.test.ts` enforces adoption: a suite that
  touches `homedir()`/`$HOME` either speaks the contract or carries a waiver saying why it
  needs no gate, and each waiver is asserted still necessary, so the list drains itself.

## `@earendil-works/pi-tui` — tracked, not pinned

`@earendil-works` owns the Pi harness, so `pi-tui` *is* the extension API. It is a
`devDependency` only — the harness provides it at runtime; we never ship it — and its range
is the `latest` dist-tag rather than a caret pin:

```json
"@earendil-works/pi-tui": "latest"
```

`^0.84.1` would have been the wrong shape: for `0.x` versions a caret means `>=0.84.1
<0.85.0`, so the repo would have sat on 0.84.x while the harness moved to 0.85+ — typechecking
and testing extensions against an API older than the one they actually run under. `bun.lock`
still pins the resolved version, so installs stay reproducible; refresh deliberately with:

```
bun update --latest @earendil-works/pi-tui
```

## Config Is Read AND Written — Both Honour `XDG_CONFIG_HOME`

`extensions/lib/config.ts` resolves the global config path through `$XDG_CONFIG_HOME`
(defaulting to `~/.config`) on **both** the read path (`loadConfig`) and the write path
(`getConfigPaths` → `writeConfig`, `hasConfig`). They disagreed before #158 — reads honoured
XDG, writes hardcoded `~/.config` — which meant a persisted setting could appear not to
stick, and a test could not isolate itself from the developer's real config no matter what
it set.

Note the surface asymmetry, which is deliberate and pinned by `tests/config-persistence.test.ts`:

- **The CLI (`bin/wtft.mjs`) never writes config.** It only reads.
- **The Pi extension (`/wtft`) does write**, for the flags documented as "Config-persistable".
