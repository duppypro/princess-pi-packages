# Build & Toolchain

## Generated `.mjs` Files — Hard Rule

Most `bin/*.mjs` files are **build artifacts** generated from `.ts` counterparts. Each carries a `⚠️ GENERATED` banner. Always edit the `.ts` source, then rebuild. They are tracked in git because npm's git-dependency extractor respects `.gitignore` and would omit them otherwise.

**Exception:** `bin/patch-pi-widgets.mjs` is handwritten source (no `.ts` twin) — edit it directly.

Tests must run against the built `.mjs` (the end-user path), not the `.ts` source.
