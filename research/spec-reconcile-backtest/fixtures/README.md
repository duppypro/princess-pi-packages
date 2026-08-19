# Backtest fixtures that no `git archive` can carry

`host/` holds documents reproduced from **outside every git repository**. They exist here
because that is exactly what makes them interesting: `spec-reconcile`'s diff scope cannot
reach a file that appears in no changeset (skill §1 *Reverse scope*, §2 *Tier 4*), so the
fixture for that failure mode cannot come from the corpus tree.

`run-backtest.sh` stages `host/` into a round's corpus as `./host/` when that round carries
a `STAGE_HOST` marker.

## Provenance

| File | Reproduced from | Frozen at | Why |
|---|---|---|---|
| `host/git-projects-CLAUDE.md` | `~/git-projects/CLAUDE.md`, "Git & GitHub Etiquette" subsection — **first 24 of its 26 lines**; the trailing *Model Routing for Spawned Agents* bullet is elided as unrelated to any tool this corpus audits | `2026-08-19T16:01:47Z`, from the host's own `.bak` snapshot | The state immediately **before** #381 corrected it. Scored as **F5** in `RUBRIC.md`. The Git Guardrails bullet — the F5 claim — is byte-for-byte |

**The provenance lives here, not in the fixture.** An earlier revision carried this note as
a banner comment inside the staged file, where the auditor read it — *"do not edit to make
an auditor pass"*, *"immediately BEFORE #381 corrected it"* — which announces that the file
contains exactly one planted false claim and dates it. A live `~/git-projects/CLAUDE.md`
carries no such hint, so the fixture must not either. Staged files are document bodies only.

**Do not edit a fixture to make an auditor pass.** A miss is a finding about the skill.
