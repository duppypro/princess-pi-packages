# Tool Conventions

## Cross-Harness Architecture

Every tool targets **both Pi and Claude Code** — one implementation, two invocation paths:

- **Pi extension** (`.ts` in `extensions/`): loaded by Pi's `registerCommand`, renders TUI widgets
- **CLI bin** (`.mjs` in `bin/`): standalone, invoked from any shell including Claude Code's `!` prefix
- **Shared manifest** (`docs/manifests/*-cmd.json`): drives `--help` and `--why` for both

To build or port a tool to this standard, follow `skills/cross-harness-tool/SKILL.md`.

## Manifest-Driven `--help`

Every command backed by a manifest renders `--help` in this fixed order:

1. **Title + tagline + description** (`name`, `tagline`, `description`)
2. **Examples first** — realistic invocations with mock parameters (`examples[].args` + `desc`)
3. **Full flag enumeration last** (`usage[].flags` + `desc`)

Manifest entries store only trailing arguments/flags — the renderer prepends the invocation name (e.g. `!serve` from Pi, `serve` on the CLI), so the same manifest works under both forms.

## Manifest-Driven `--why`

Every tool must support `--why`, which answers "Why would I run this?" using user scenarios from the manifest:

1. Renders from the manifest's `why` array (same strategy as `--help`)
2. Answers with concrete scenarios: user problem → exact command(s) → expected result
3. Enumerates use cases thoroughly but not exhaustively
4. Includes at least one anti-use-case (where the tool doesn't help)
5. Closes with: `Run <tool> --help for the full flag reference.`

Manifest `why` entries have four fields — three required, one optional:

- `scenario` — the user's context/problem
- `commands` — one or more invocations to address it (tool name omitted; renderer prepends)
- `result` — what the end state looks like
- `demo` *(optional)* — an array of literal output lines printed under `result`, ANSI escapes
  included, written as `\u001b[…m` in the JSON. Rendered by the shared help renderer
  (`extensions/lib/manifest-help.ts`), skipped when absent or empty. Paste real output rather
  than inventing it: a demo is the one part of `--why` a reader will compare against what
  their terminal actually printed.

For tools without manifests, `--why` is rendered inline.

**`--why` must appear in every tool's `--help` output.** For manifest-driven tools, add it to `usage[]`. For inline tools, add a line in `printHelp()`.
