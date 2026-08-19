# ADR 0004 — Workflow tools are shell-first; an extension needs a reason from the harness

- **Status:** Accepted
- **Date:** 2026-08-11 (decided), recorded 2026-08-18
- **Deciders:** Duppy, Princess-Pi
- **Context repo:** duppypro/princess-pi-packages
- **Issues:** #226 (this decision), #201 (`bin/merge` → `pr-open`), #230 (the doc drift this
  decision leaves behind), #345 (skills deploy to both harnesses, which is why a stale recipe
  is loadable)

> Recorded seven days after it was made. The decision was applied first — `extensions/merge.ts`
> and its manifest and rendered doc were deleted, and `skills/cross-harness-tool` got a
> SUPERSEDED banner — but nothing wrote down *why*, so the reasoning lived only in an issue
> thread. That gap is the thing this file exists to close.

## Context

Two harnesses run the tools in this repo: Pi (a `/command` + TUI extension runtime) and Claude
Code (a shell). The house recipe, `skills/cross-harness-tool`, told us to give every tool
**one logic implementation, three faces** — a CLI, a Pi `/command`, and optionally a widget.

That recipe produced a working example and then a failure, and the failure is the whole reason
this ADR exists.

**What the two faces actually cost.** `bin/merge` was deleted in #201 and replaced by
`pr-open`, which never merges locally. `extensions/merge.ts` survived the delete, deliberately —
`build.ts` carried a comment saying the Pi `/merge` command was unaffected. So for months, the
Pi harness shipped a `/merge` that ran `git checkout main` → merge → `git push` →
`git push origin --delete <branch>`: the exact operation `~/git-projects/CLAUDE.md` forbids in
bold, callable from a live session.

**Why nothing caught it.** `extensions/git-guardrails.ts` is a **bash-spawn hook**. It inspects a
command string on its way to a shell. A slash-command handler calls `child_process` in-process
and spawns no shell, so `/merge`'s push to `main` passed no gate in either direction. The
guardrail was not weak; it was **looking at the only surface that had commands to look at.**

**The recipe pointed at a corpse.** `skills/cross-harness-tool` named `merge` as its reference
implementation — `bin/merge.mjs`, gone since #201. The skill deploys to both harnesses (#345),
so an agent could load a retired recipe citing a deleted file and follow it in good faith.

Duplication is what let this happen. Two faces meant two places to change, and the one nobody
was watching kept doing what it had always done while the other moved on.

## Decision

**1. The fork is not "slash command or shell". It is: does this tool need harness state?**

A tool that only manipulates git, files, and the network needs nothing the harness provides. Its
Pi face is pure duplication. A tool that renders a live TUI widget, or reads session state,
genuinely cannot be a shell script.

| Tool | Needs harness state? | Face |
|---|---|---|
| `pr-open`, `pr-merge`, `pr-reject`, `pr-cleanup`, `pr-threads` | no — git + `gh` only | shell only (`!pr-open`) |
| `git-checkpoint`, `git-overview`, `wt-new`, `repo-gate` | no | shell only |
| `merge` | no | **retired** — `extensions/merge.ts` deleted |
| `serve` | the **widget** does; the command does not | widget-only extension; the command is `!serve` |
| `wtft` | widget + live daemon follow | genuine extension |

**2. Workflow tools get no Pi `/command` face.** They are invoked as `!pr-open`, `!serve`. One
implementation, one `--help`, one set of docs, one manifest.

**3. Where an extension survives, it keeps only what needs the harness.** `serve`'s extension
retains the widget lifecycle and the widget-state controls (`--hide` / `--show` / `--emoji`,
which write session state through `ctx`). Every other `/serve` route — start, kill, list,
publish/unpublish — is deleted and answered with a pointer to `!serve`.

**4. No thin shims.** A `/command` that only shells out to the same binary was on the table and
set aside: a shim layer grows logic, and a shim that has grown logic is exactly the divergence
this ADR is closing. If the shell face is good enough to shim, it is good enough to type.

**5. Structural, not procedural, enforcement.** `tests/pi-merge-retired.test.ts` asserts that
**no extension executes a mutating git command in-process**, with a known-bad probe so the
detector cannot go blind. That is what makes shell-first mean something: every git-touching
invocation now reaches bash, where the hook can see it.

## Consequences

**Bought.** The divergence class is closed by construction rather than by a parity suite —
and a parity suite is precisely what did not exist for `merge`. Every git mutation an agent can
reach passes the bash guardrail. A tool has one `--help` that cannot disagree with itself. Pi
sessions get their context back: a registered command's description costs tokens in *every*
session, while `!cmd` costs nothing until invoked — the same "zero-token CLI" argument the
cross-harness skill already made for the Claude side.

**Paid.** `/` autocomplete and slash-command discoverability are gone for workflow tools; `!` is
slightly worse to type. A Pi user who typed `/serve ./docs` now types `!serve ./docs`. Discovery
moves to `CLAUDE.md`'s shipped-scripts table and each tool's `--help`.

**Left behind.** Docs written against the old recipe still describe three faces and a `merge`
that no longer exists — `skills/cross-harness-tool`, `docs/adding-a-harness.md`,
`docs/EXT_SERVE.html`. #230 owns that sweep. Until it lands, the SUPERSEDED banner on
`cross-harness-tool` is what stops an agent from following a retired decision.

## Roads not taken

- **Keep both faces, enforce parity.** Keeps discoverability; costs a parity suite per tool.
  Set aside because the absence of exactly that suite is what caused this — adding the missing
  test is a fix for one instance, not for the class.
- **Delete the Pi extension surface entirely.** `wtft`'s widget and `serve`'s widget are real
  value that a shell script cannot deliver. The "needs harness state" test exists to keep them.
- **Add a second guardrail for the extension surface.** Doubles the enforcement surface to
  preserve the duplication that made it necessary.
