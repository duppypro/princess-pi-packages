# Pi Packages

Extensions, skills, and documentation manifests for the Princess-Pi Coding Agent.

## ⛔ Hard Gates

- **Never edit on `main`.** Always use `<issue#>-<slug>` branches (e.g. `73-server-tool-use-cost`).
- **Never edit generated `.mjs` files.** Most `bin/*.mjs` are build artifacts from `.ts`
  sources. Look for the `⚠️ GENERATED` banner. Edit the `.ts`, then `bun run build`.
  Exception: `bin/patch-pi-widgets.mjs` is handwritten.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` |
| Typecheck | `bun run typecheck` |

## Conventions

- [Tool conventions](docs/agents/tool-conventions.md) — manifest-driven `--help`/`--why`, cross-harness architecture
- [Development workflow](docs/agents/dev-workflow.md) — local testing, install methods, hot-swapping
- [Build & toolchain](docs/agents/build-and-toolchain.md) — `.mjs` generation rules, test expectations
