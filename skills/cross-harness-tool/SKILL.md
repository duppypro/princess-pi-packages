---
name: cross_harness_tool
description: Recipe for building/porting a tool that works in BOTH Pi (as a /command + optional TUI widget) and Claude Code (as a zero-token CLI), driven by one shared manifest.
---

# Skill: Build a Cross-Harness Tool (Pi `/command` + Claude CLI)

Use this when adding a **new** tool to `princess-pi-packages`, or **porting** an existing one to the
cross-harness bar (e.g. issues #9 `wtft`, #10 `serve`). Reference implementation: **`merge`**
(`bin/merge.mjs`, `extensions/merge.ts`, `docs/manifests/merge-cmd.json`), delivered in #8.

> 💡 Goal: **one logic implementation, three faces** — a plain CLI (Claude/any shell), a Pi
> `/command`, and (optionally) a live Pi TUI widget — all sharing one `--help` manifest.

---

## The five pieces

| Piece | Path | Role |
| --- | --- | --- |
| **CLI bin** | `bin/<name>.mjs` | Plain ESM JS, `#!/usr/bin/env node`. The zero-token CLI Claude runs. |
| **Root wrapper** | `./<name>` | `exec node "$(dirname "$0")/bin/<name>.mjs" "$@"` — so `!./<name>` works from the repo. |
| **Pi extension** | `extensions/<name>.ts` | `registerCommand` (+ optional widget). The typed twin. |
| **Shared logic** | `extensions/lib/<name>/*.ts` | Logic both faces import — keep it harness-agnostic (no `ctx.ui`, no `process.argv`). |
| **Manifest** | `docs/manifests/<name>-cmd.json` | Single source for `--help` (name, tagline, description, examples, usage). |

Register the CLI in `package.json` `bin`: `"<name>": "./bin/<name>.mjs"`.

---

## Rule 1 — The CLI bin is plain `.mjs`, never TypeScript

**Why (non-obvious, learned in #8 and #9):** the CLI is installed globally for Claude via
`npm install -g github:duppypro/princess-pi-packages`, which places the bin under `node_modules/`.

- ❌ `#!/usr/bin/env -S node --experimental-strip-types` → Node **refuses** to strip types under
  `node_modules/`: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Works from a clone, breaks once installed.
- ❌ `#!/usr/bin/env -S npx tsx` → forces a per-environment **network fetch** of `tsx`, and resolves
  `tsx` from an arbitrary cwd.
- ✅ `#!/usr/bin/env node` + plain ESM JavaScript → zero deps, no build step, runs anywhere incl. under
  `node_modules/`. Requires Node ≥ 18.

### The Bundling Approach (`esbuild`)
If a tool relies heavily on shared TypeScript libraries (`extensions/lib/`), manually porting it to `.mjs` is messy. Instead, use `esbuild` to compile and bundle the TypeScript dependencies directly into the `bin/tool.mjs` file:
```bash
npx esbuild bin/tool.ts --bundle --platform=node --format=esm --target=node18 --outfile=bin/tool.mjs
```
**🚨 Gotchas (Learned in #9):**
1. **Duplicate Imports:** `esbuild` may inline a shared `.ts` file that has its own `import * as fs from "node:fs"`. If `bin/tool.ts` also imports `fs`, Node will crash with `SyntaxError: Identifier 'fs' has already been declared`. You must write a script to strip duplicate core node module imports from the final `.mjs` file if you are manually concatenating them, or rely strictly on a pure `esbuild --bundle` output which handles deduplication automatically.
2. **Path Resolution:** If you use `--bundle`, any files spawned as child processes (like `run-live-server.js` in `/serve`) must **not** be bundled into the `.mjs` file, as they must remain discrete physical files on disk for `node:child_process` to target.
3. **NPM Testing (`npm link` vs `npm install -g`):**
   - When developing locally, `npm link` will symlink your repository's `bin/` folder to your global path.
   - However, your shell often caches the path to the old globally-installed binary. If you type `tool --help` and don't see your changes, you must run `hash -r` in bash to clear the path cache, or test using the explicit path `./bin/tool.mjs`.
   - **Never run `npm update` to pull changes from a Git URL.** NPM often fails to pull the latest `HEAD` commit from a Git URL during `npm update`. Always use `npm install -g github:duppypro/princess-pi-packages` to aggressively force NPM to fetch and overwrite the global symlink.

---

## Rule 2 — One manifest, rendered by both faces

`docs/manifests/<name>-cmd.json` holds `{ name, tagline, description, examples[], usage[] }`. Entries store
only trailing `args`/`flags` — **never** a hardcoded command name. Each renderer prepends its own
`invokedAs` (`/<name>` for the Pi extension, `<name>` for the CLI). `--help` order is fixed: **title →
examples (realistic, with mock params) → full flag enumeration**. See CLAUDE.md "Manifest-Driven `--help`".

---

## Rule 3 — Output channel is the only harness difference

Logic is identical across faces; only how it talks to the user differs:
- **CLI:** `console.log` / `console.error`, set `process.exitCode = 1` on failure.
- **Pi extension:** `ctx.ui.notify(msg, "info" | "error")`.
- **Failure path must be self-explanatory** so an LLM can fix-and-retry from the message alone
  (e.g. `merge`'s "not pushed → push first", "not a Step 5 commit → here's the suggested hash").
  This is what preserves the zero-token property even when things go wrong.

---

## Rule 4 (optional) — Pi TUI widget

If the tool benefits from a persistent live display (cost meters, server lists), add a widget in
`extensions/<name>.ts` driven by `system-clock.ts` tick events or turn-completion hooks (pattern:
`wtft.ts`). The widget is **Pi-only** — the CLI face is headless. Gate widget code so the shared logic
stays harness-agnostic and importable by the `.mjs` bin. (See `skills/learning-pi/` for the Pi widget/TUI API.)

---

## Install & invoke

| Harness | Install | Invoke |
| --- | --- | --- |
| **Pi** | `pi install git:github.com/duppypro/princess-pi-packages@main` | `/<name> …` (+ widget) |
| **Claude / shell** | `npm install -g github:duppypro/princess-pi-packages` (from `~`; `-g` ⇒ cwd-independent, pulls from GitHub main) | `!<name> …` or a single Bash call |

---

## Test like `merge`

Write a self-contained acceptance harness in `tests/<name>.sandbox.sh` (model: `tests/merge-fallback.sandbox.sh`):
build a throwaway fixture (e.g. a bare git "remote" + clone under `/tmp`), drive the **real bin**
(`node bin/<name>.mjs …`), and assert success **and** error paths (each must exit non-zero with the
expected message and leave no bad state). Make `fresh()` idempotent — clean **all** scratch dirs between
cases (the #8 harness leaked `work2` and gave a false failure). After publishing to `main`, re-run from the
**installed global copy** from an unrelated cwd — that is the only check that catches the `node_modules`
type-strip class of bug.

---

## Definition of done (the cross-harness bar)
1. `npm install -g …` then `<name> --help` works from an unrelated repo cwd.
2. `/<name>` works in Pi (and its widget, if any).
3. `--help` is identical across both, from the one manifest.
4. `tests/<name>.sandbox.sh` passes; success path spends zero LLM reasoning turns; failure path is
   self-explanatory.
