# Build & Toolchain

## Generated `.mjs` Files — Hard Rule

Most `bin/*.mjs` files are **build artifacts** generated from `.ts` counterparts. Each carries a `⚠️ GENERATED` banner. Always edit the `.ts` source, then rebuild. They are tracked in git because npm's git-dependency extractor respects `.gitignore` and would omit them otherwise.

**Exception:** `bin/patch-pi-widgets.mjs` is handwritten source (no `.ts` twin) — edit it directly.

Tests must run against the built `.mjs` (the end-user path), not the `.ts` source.

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
- **`.test.sh` suites are not driven.** They need sudo or a live nginx; run them by hand.
  `tests/run.ts` prints their names at the end of every run so the gap stays visible.
