# Tool Conventions

This repo ships **two classes of tool**, and almost nothing on this page is true of both.
Everything below says which class it governs. Saying it once, at the top, is the fix for
what #365 found: this page asserted of "every tool" a three-part architecture that **no
shipped shell script has**, and mandated a `--why` flag that 11 of 12 had never had.

| Class | What it is | Where it lives | Flags it ships |
|---|---|---|---|
| **Workflow scripts** | Extensionless bash, hand-edited, no build step | `bin/<name>` → copied to `~/bin` by `install-workflow-tools` | `-h`/`--help`, `--version`, and its own flags. **No `--why` required** |
| **Manifest-backed commands** | `serve`, `wtft`, `yada` | `bin/<name>.ts` → built to `bin/<name>.mjs`; `docs/manifests/<name>-cmd.json` | `--help` **and `--why`**, both rendered from the manifest |

Since #226 the harness surface is **shell-first**, so the workflow-script row is the *main*
line and the manifest row is the smaller, specialised one. This page used to describe the
opposite.

Both classes are checked mechanically by `tests/tool-flag-contract.test.ts`: every flag a
tool implements must appear in a readable artifact, and every flag this page requires must
be implemented by the tools it names. A claim here that no tool satisfies fails the suite
rather than sitting true-looking and false for months.

## Workflow scripts (the shell family)

Twelve scripts, listed with one row each in
[`docs/dev-workflow-spec.md`](../dev-workflow-spec.md#scripts) — that table is their
reference, and it already answers "why would I run this" once per script.

- **`-h`/`--help`** prints usage, exit `0` (#310).
- **`--version`** prints the resolved absolute path of the running copy (`readlink -f "$0"`),
  exit `0` (#178). No semver or commit stamp: these are not built. The path is the point —
  `install-workflow-tools` deploys them to `~/bin`, so a bare `pr-merge` in a feature worktree
  runs whatever was last installed there, and `--version` is how you tell which tree answered.
- **Unknown flags, unexpected positionals, and flag-shaped option values are refused**, naming
  the offending argument — exit `2`, except `install-workflow-tools`' `64` (#362, #366, #367).
- **No `--why`.** It was designed around manifests, #226 retired the manifest-backed command
  surface it was built for, and a second copy of the spec table's answer is a drift generator.
  A script MAY carry an inline `--why` where it genuinely earns one — `repo-gate` does — and
  then it is documented like any other flag.

These reach `$PATH` by **copy**, via `install-workflow-tools`. They are not in `package.json`'s
`bin` map and no `bun link` symlink points at them, so editing `bin/git-overview` in a worktree
changes nothing about the `git-overview` on your `$PATH` until you re-run the installer —
`--version` is the check for exactly this.

## Manifest-backed commands (`serve`, `wtft`, `yada`)

These have the multi-part shape this page once claimed was universal: a TypeScript source in
`bin/`, a built `.mjs`, a manifest in `docs/manifests/`, and — where the tool renders a TUI
widget or reads session state — a Pi extension in `extensions/`. Per #226's shell-first
decision, an extension is justified **only** by that harness-state need, never by wanting a
second command surface.

### Manifest-driven `--help`

Every command backed by a manifest renders `--help` in this fixed order:

1. **Title + tagline + description** (`name`, `tagline`, `description`)
2. **Examples first** — realistic invocations with mock parameters (`examples[].args` + `desc`)
3. **Full flag enumeration last** (`usage[].flags` + `desc`)

Manifest entries store only trailing arguments/flags — the renderer prepends the invocation name
(e.g. `!serve` from Pi, `serve` on the CLI), so the same manifest works under both forms.

### Manifest-driven `--why`

**Every manifest-backed command supports `--why`**, which answers "Why would I run this?" using
user scenarios from the manifest, and names it in its own `--help` (`usage[]`):

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

## Porting a tool

`skills/cross-harness-tool/SKILL.md` is **superseded** — it teaches the both-faces recipe #226
reversed, and its reference implementation (`merge`) no longer exists. Its rewrite is tracked in
#230. Until then, the decision it should have led with is the one above: *does this tool need
harness state?* If no, it is a workflow script and needs no second face.
