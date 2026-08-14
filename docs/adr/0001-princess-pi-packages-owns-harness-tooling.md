# ADR 0001 — princess-pi-packages owns harness and dev-workflow tooling; dotfiles-doctor owns host config and prose

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** Duppy, Princess-Pi
- **Context repo:** duppypro/princess-pi-packages
- **Issues:** #227 (guidelines/tool install), #217 (hooks install target), dotfiles-doctor#18 (the divergence that forced this)

## Context

Two repos both write to `$HOME`, and both claimed the same files.

- **dotfiles-doctor** aggregates host config into stow packages (`bash`, `tmux`, `git`,
  `claude`, `princess-pi`, `tools`, `herdr`), distributes it across machines, and is
  designed as the *only* writer to `$HOME`. Its `claude` package shipped
  `.claude/hooks/block-edit-on-main.sh`, `.claude/hooks/preedit-reread-check.py` and
  `.claude/statusline-command.sh`, and captured the first two via `SNAPSHOT_EXTRA`.
- **princess-pi-packages** owns the dev workflow those hooks enforce, ships the scripts the
  workflow names, holds the behavioural test harness (`hooks-deploy-drift`,
  `git-guardrails-parity` and the fixture table in `tests/fixtures/git-guardrails-cases.json`),
  and deploys via `bin/install-workflow-tools`.

This was not a hypothetical overlap. Measured 2026-08-14 (dotfiles-doctor#18):
`block-edit-on-main.sh` existed in three places and the two repo copies had drifted in
**opposite** directions — dotfiles-doctor had the `.git/`-internals exemption (its #15) and
lacked the symlink canonicalization (our #267); princess-pi-packages had the reverse. The
live host matched princess-pi-packages, so **dotfiles-doctor's own shipped fix was not
running on the machine it shipped to**, and nobody noticed for a day. Each installer
silently reverted the other's work depending on which ran last, and neither could detect
it: `install-workflow-tools --check` reports "in sync" truthfully, because it only knows
about its own copy.

Merging the bytes would have fixed the symptom and left the mechanism intact.

## Decision

**princess-pi-packages owns the hooks and every tool used by Princess-Pi's enhancements to
agent harnesses and the dev workflow. dotfiles-doctor owns host configuration and prose.**

The dividing line is **executable tooling vs. configuration and prose**, not directory:

| Artifact | Owner | Note |
|---|---|---|
| `~/.claude/hooks/*` | princess-pi-packages | already here; has the behavioural tests |
| `~/bin/*` workflow scripts | princess-pi-packages | already here |
| `~/.claude/skills/*` | princess-pi-packages | already here, per repo CLAUDE.md |
| `~/.claude/statusline-command.sh` | princess-pi-packages | **moves** — harness enhancement |
| `~/.claude/subagent-statusline.sh` | princess-pi-packages | **moves** — harness enhancement (see Consequences) |
| `bash/`, `tmux/`, `git/`, `herdr/` config | dotfiles-doctor | unchanged |
| `~/.claude/CLAUDE.md`, `~/git-projects/CLAUDE.md`, `duppy-voice-card.md` | dotfiles-doctor | prose, not tooling — see Open boundary |

An artifact has exactly one owning repo. The owner holds the source, the tests, and the
installer. The non-owner ships nothing to that path and captures nothing from it.

## Consequences

1. **dotfiles-doctor drops three hook paths** from its `claude` package and its
   `SNAPSHOT_EXTRA` list, plus the two statusline scripts. Tracked as dotfiles-doctor#18;
   that repo records its own ADR for the removal — this one cannot decide for it.
2. **The hook copies must be reconciled before the drop, not after.** princess-pi-packages'
   copy is currently missing dotfiles-doctor's `.git/`-internals exemption (#15). Dropping
   dotfiles-doctor's copy first would make that fix unrecoverable from a running host.
   Order: reconcile → verify both fixes present → drop.
3. **dotfiles-doctor#17 is answered differently than filed.** It proposed adding
   `subagent-statusline.sh` to dotfiles-doctor's `SNAPSHOT_EXTRA`. Under this ADR the
   script is a harness enhancement, so it is tracked *here* and deployed by
   `install-workflow-tools` instead. The finding stands (the file is live, referenced from
   `settings.json:102`, and tracked nowhere); only its destination changes.
4. **`$HOME` now has two writers.** This is the real cost, and it is accepted deliberately:
   dotfiles-doctor's single-writer invariant is traded for single-*ownership* per artifact.
   The invariant that replaces it is narrower and testable — no path is written by both
   installers — and a drift check should assert it rather than trusting convention.
5. **A fresh host needs both repos** to reach a working state. Previously dotfiles-doctor
   alone was nominally sufficient (in practice it was not, which is what #217 and #227
   record).

## Open boundary — flagged for review, not decided here

The rule says *tools*. `~/git-projects/CLAUDE.md` is a dev-workflow artifact but it is
prose, so this ADR leaves it with dotfiles-doctor. That reading means **#227's step 5 (the
content rewrite carrying #225 gap 3) belongs to dotfiles-doctor, not here** — which is a
defensible split (prose in one place, tooling in another) and also the opposite of what
#227's title implies. The alternative reading is that the *dev-workflow guidelines*
specifically follow the workflow tooling here, leaving dotfiles-doctor only the
machine-level prose.

Left open on purpose: it does not block the tooling decision above, and getting it wrong
in either direction is cheap to reverse while the guidelines still have no installer at all.

## Roads not taken

- **Keep both copies, add a cross-repo parity test.** Cheapest to reach, and it makes drift
  *visible* rather than impossible. It does not remove the last-installer-wins race — it
  only reports it after the fact, on a host where one of the two fixes is already missing.
- **dotfiles-doctor stays the sole `$HOME` writer; princess-pi-packages ships fragments it
  consumes.** Preserves the single-writer invariant, which is a genuinely good property.
  Rejected because it puts the tests and the deployment in different repos: the repo that
  can prove a hook behaves correctly would not be the repo that decides what lands on the
  host, and the assembly step becomes a third thing to keep in sync.
- **Move everything to dotfiles-doctor.** Consolidates `$HOME` cleanly, and strands the
  behavioural test harness — 218 checks across `hooks-deploy-drift` and
  `git-guardrails-parity` — away from the artifacts it gates.

## Verification

- One command answers "which repo owns this path", and no path is claimed by two installers.
- The live `~/.claude/hooks/block-edit-on-main.sh` carries **both** the `.git/`-internals
  exemption and the symlink canonicalization, whichever installer ran last.
- Running both installers in either order converges on the same bytes.
- A staleness gate fails when a deployed copy drifts from its owning repo (the shape #217
  and #227 both ask for).
