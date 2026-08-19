---
name: cross-harness-tool
description: How to add a tool to princess-pi-packages so it runs under every harness. Shell-first — the tool is a CLI, and a Pi extension exists only where the harness supplies something a shell cannot (a live TUI widget, session state). Use when adding a new tool, porting one, or deciding whether a tool needs a second face.
---

# Skill: Add a Tool (shell-first, second face only if earned)

> **Where this file lives.** The copy in
> `princess-pi-packages/skills/cross-harness-tool/SKILL.md` is the **source of truth**.
> `~/.claude/skills/cross-harness-tool/SKILL.md` and `~/.pi/agent/skills/cross-harness-tool/SKILL.md`
> are **downstream deploy copies** — edit the repo copy, then run `bin/install-workflow-tools`
> (`--check` reports drift without writing). Never the reverse: the dotfile has no history to lose.

Use this when adding a **new** tool to `princess-pi-packages`, or **porting** an existing one.

**Reference implementation: `serve`.** `bin/serve.ts` → `bin/serve.mjs` is the whole tool;
`extensions/serve.ts` is the live active-server widget and nothing else;
`docs/manifests/serve-cmd.json` is the one `--help` source both read. It is the reference
*because* it is split — it shows where the line falls.

---

## Step 0 — the only question that decides the shape

> **Does this tool need something only the harness can give?**

Not "should it have a slash command". A tool that manipulates git, files, processes, or the
network needs nothing a shell lacks, and a second face for it is pure duplication — which is
what let the Pi `/merge` command keep merging locally for months after the `merge` CLI was replaced
(**[ADR 0004](../../docs/adr/0004-workflow-tools-are-shell-first.md)**, issue #226). Duplication
is not a style question here; it is the failure mode.

| Answer | Shape |
| --- | --- |
| **No** — git, files, network, processes | **Shell only.** `bin/<name>.ts` → `.mjs`. Invoked `!<name>` from Pi and Claude alike. No extension. |
| **Yes** — a persistent TUI widget, session state, turn-completion events | Shell CLI **plus** an extension that owns *only* the harness-bound part. |

Worked answers: `pr-open`/`pr-threads`/`git-checkpoint` → shell only. `serve` → the command is
shell, the widget is an extension. `wtft` → widget and live daemon follow, so a genuine extension.

Two consequences worth knowing before you choose:

- **A registered command costs tokens in every session**, whether or not it is used — its
  description is in the prompt. `!<name>` costs nothing until invoked. This is the same
  zero-token argument that made the CLI face the primary one in the first place.
- **Only bash is guarded.** `extensions/git-guardrails.ts` is a bash-spawn hook: it inspects a
  command string on its way to a shell. An extension calling `child_process` in-process spawns no
  shell and passes no gate. `tests/pi-merge-retired.test.ts` asserts no extension mutates git
  in-process — if your extension needs to, the answer is that it should be a shell script.

---

## The pieces

| Piece | Path | Role |
| --- | --- | --- |
| **CLI bin** | `bin/<name>.ts` → built to `bin/<name>.mjs` | The tool. Plain ESM output, `#!/usr/bin/env node`. |
| **Shared logic** | `extensions/lib/<name>/*.ts` | Harness-agnostic — no `ctx.ui`, no `process.argv`. Imported by both faces when there are two. |
| **Manifest** | `docs/manifests/<name>-cmd.json` | Single source for `--help` and `--why` (name, tagline, description, examples, usage). |
| **Pi extension** *(only if Step 0 said yes)* | `extensions/<name>.ts` | The widget and the state that drives it. Not a second copy of the command. |

Register the CLI in `package.json` `bin`: `"<name>": "./bin/<name>.mjs"`.

---

## Rule 1 — The shipped bin is plain `.mjs`, never TypeScript

**Why (non-obvious, learned in #8 and #9):** the CLI is installed globally via
`npm install -g github:duppypro/princess-pi-packages`, which places the bin under `node_modules/`.

- ❌ `#!/usr/bin/env -S node --experimental-strip-types` → Node **refuses** to strip types under
  `node_modules/`: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Works from a clone, breaks once installed.
- ❌ `#!/usr/bin/env -S npx tsx` → forces a per-environment **network fetch** of `tsx`, and resolves
  `tsx` from an arbitrary cwd.
- ✅ `#!/usr/bin/env node` + plain ESM JavaScript → zero deps, no build step at install, runs anywhere
  including under `node_modules/`. Requires Node ≥ 18.

The published package must run on **stock node**, never bun — bun is our internal toolchain only
(`~/git-projects/CLAUDE.md` § Node Toolchain Standard). Write the source in TypeScript and let
`bun run build` bundle it; `tests/pack-and-smoke.test.ts` proves the registry channel with bun
excluded from `PATH`.

### The bundling approach (`esbuild`, via `build.ts`)

`bun run build` bundles a bin's `extensions/lib/` dependencies into `bin/<name>.mjs` — but **only
for the bins named in `build.ts`'s `TARGETS` array.** The build discovers nothing. Add your entry
there (with an `external` list for any file that must stay a discrete file on disk) or `bun run
build` succeeds, says nothing about your tool, and leaves `bin/<name>.mjs` absent — so the command
you registered in `package.json` `bin` cannot run at all. Caught by macroscopeapp on PR #375
against the previous wording, which claimed the build compiles *each* `bin/*.ts`.

**🚨 Gotchas (learned in #9 and #10):**

1. **The compilation ghost.** Edit a shared library and the Pi extension picks it up on `/reload`;
   the `.mjs` binary **does not**. Run `bun run build` before you commit, or the package ships stale
   logic. `tests/build-stamp.test.ts` is the backstop.
2. **Path resolution.** Files spawned as child processes (e.g. `run-live-server.js` for `serve`)
   must **not** be bundled — `node:child_process` needs them as discrete files on disk.
3. **Testing the CLI globally.** `bun link` symlinks the repo's `bin/` into your global path, but
   your **interactive** shell caches the old path: run `rehash` (zsh) / `hash -r` (bash), or invoke
   `./bin/<name>.mjs` explicitly. Agent tool-calls get a fresh shell each time and need neither.
   **Never `npm update` from a Git URL** — it often fails to pull the latest `HEAD`. Re-run
   `npm install -g github:duppypro/princess-pi-packages` to force the overwrite.

---

## Rule 2 — One manifest, and every face renders it

`docs/manifests/<name>-cmd.json` holds `{ name, tagline, description, examples[], usage[] }`. Entries
store only trailing `args`/`flags` — **never** a hardcoded command name. Each renderer prepends its own
`invokedAs`: `<name>` for the shell, `!<name>` when the docs address a Pi session. `--help` order is
fixed: **title → examples (realistic, with mock params) → full flag enumeration**. The renderer is
`extensions/lib/manifest-help.ts` (it was `lib/merge/help.ts` until #226 — never merge-specific, which
is why it outlived the tool it was named after). Details:
[tool conventions](../../docs/agents/tool-conventions.md).

---

## Rule 3 — Output channel is the only harness difference

Where two faces exist, the logic is identical and only the talking differs:

- **CLI:** `console.log` / `console.error`, `process.exitCode = 1` on failure.
- **Pi extension:** `ctx.ui.notify(msg, "info" | "warning" | "error")`.
- **The failure path must be self-explanatory**, so an agent can fix-and-retry from the message
  alone — `pr-open`'s "branch has diverged from origin, pull first", `serve`'s "port in use, here is
  the pid". That is what preserves the zero-token property when things go wrong.
- **Machine-readable mode is required, not optional** — `--json` with a versioned `schema` key, or a
  documented exit-code table. See `skills/prose-as-api/` and the Agent-First Output standard.

---

## Rule 4 — The Pi widget: the one thing that earns an extension

A persistent live display (cost meters, server lists) is what a shell cannot do. Drive it from
`system-clock.ts` tick events or turn-completion hooks — pattern: `extensions/wtft.ts`, or
`extensions/serve.ts` for the minimal version. Keep the shared logic harness-agnostic so the `.mjs`
bin can still import it.

An extension that has a widget may also own the flags that **change widget state**
(`--hide`/`--show`/`--emoji` write session config through `ctx`). It may not own the flags that do
the tool's actual work. `extensions/serve.ts` refuses those with the `!serve` spelling rather than
ignoring them: a surface that accepts a directory and silently does nothing lets the user believe a
server started.

---

## Install & invoke

| Harness | Install | Invoke |
| --- | --- | --- |
| **Pi** | `pi install git:github.com/duppypro/princess-pi-packages@main` | `!<name> …` (`/<name>` only for a widget's own controls) |
| **Claude / shell** | `npm install -g github:duppypro/princess-pi-packages` (from `~`; `-g` ⇒ cwd-independent) | `!<name> …` or a single Bash call |

---

## Test it

Drive the **real bin** against a throwaway fixture — a bare git "remote" plus a clone under a temp
dir for anything git-shaped, a stub `gh` first on `PATH` for anything GitHub-shaped. Models to copy:
`tests/pr-merge-gate.test.ts` (sandbox + stubbed `gh` + stubbed `pr-threads`) and
`tests/pr-threads-json.test.ts` (real binary, faked GraphQL pages). Assert the success path **and**
every error path: each must exit non-zero with the expected message and leave no bad state. Make the
fixture builder idempotent — clean **all** scratch dirs between cases; a leaked one gives a false
failure.

Register the suite by filename only — `tests/run.ts` discovers it. Never run bare `bun test` over
`tests/`; use `bun run test [filter]`, which runs each suite in its own process.

---

## Definition of done

1. **Step 0 is answered in writing** — in the PR body or an ADR. "It has no extension" is a
   decision, and the next reader needs the reason.
2. `npm install -g …`, then `<name> --help` works from an unrelated cwd.
3. `--help` and `--why` render from the one manifest, and a `--json` (or exit-code table) exists for
   agent callers.
4. If an extension exists: it does the harness-bound thing and nothing else, and
   `tests/pi-merge-retired.test.ts` still passes (no in-process git mutation).
5. The suite passes, the success path spends zero LLM reasoning turns, and every failure message
   names the next command.
