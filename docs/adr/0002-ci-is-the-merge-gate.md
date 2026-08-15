# ADR 0002 — CI is the merge gate; a documented control without a checker is a wish

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** Duppy, Princess-Pi
- **Context repo:** duppypro/princess-pi-packages
- **Issues:** #228 (the unenforced PR gate), #256 (green-because-empty), #279/#280 (the `pr-threads` gate got a caller)

## Context

The workflow's stated gate is the pull request. Until now, nothing ran at it.

`docs/dev-workflow-spec.md` describes a flow that ends in *"Code Approved — tests GREEN"*
followed by a merge. That phrase was a claim the authoring agent made about itself, and
the merge acted on the claim with nothing verifying it. There was no CI in any of the 19
repos under `~/git-projects`, and the two documents that asserted a server-side control —
the spec's *"PR merge blocked by ruleset"* section and `bin/pr-threads`'s header — named
`required_review_thread_resolution` while that setting was `false`. The spec went on to
teach `--admin` as the remedy for a block that could not occur.

Two of #228's three findings have since expired, and it is worth recording why, because it
changes what this ADR has to decide:

| #228's finding (2026-08-11) | State at decision time (2026-08-15) |
|---|---|
| `pr-threads` has zero callers | **expired** — `pr-merge` gates on it (`859177e`, #258), and #279/#280 gave that gate hermetic test coverage |
| the ruleset bits are off | **mostly expired** — `protect-default-branch-owner-only` is `active` with `required_review_thread_resolution: true` |
| no repo has CI | **still true** — 19 repos, zero `.github/workflows` |

So the remaining gap is narrow and specific: **the ruleset has no `required_status_checks`
rule, because there was no status check to require.**

There is a second, subtler reason this could not simply be switched on. Twelve of this
repo's suites read host state — `~/.claude`, the dotfiles-doctor clone, the status-line
logs. On a runner, which has none of it, they passed *having checked nothing* and reported
green. Turning CI on before #256 would have bought a badge that meant less than it looked
like it meant. #256 made those skips visible and countable; this ADR spends that.

## Decision

**Make the gate real, and let it be honest about its own coverage.**

1. `.github/workflows/test.yml` runs `bun install --frozen-lockfile`, `bun run typecheck`,
   and `bun run test` on every `pull_request` and every push to `main`.
2. That check becomes **required** via `required_status_checks` on ruleset `18684693`.
3. `tests/ruleset-claims.test.ts` asserts every documented control against the **live**
   ruleset, in both directions: the setting must match the claim, and the file must still
   make the claim. This is the only kind of test that could have caught the drift that
   opened #228, and it is the standing answer to *"what stops this happening again?"*
4. A skipped check reports itself (`##SKIP##`, #256). CI green means *"everything that can
   run without a host passed"* — never *"everything passed"*. The run says which is which.

The governing rule, stated once so it can be applied to the next control: **a documented
control without a checker is a wish, and every reader pays to believe it.** Before writing
that the workflow enforces something, name how a violation would be *counted*.

## What this commits us to

Actions minutes are free on a public repo, so the cost objection in #228's body does not
apply here — but it will apply to any private repo that adopts this, and to the private
half of the #229 split. The bill is not the constraint; **the suite's runtime is**. `bun run
test` is serial by design (daemons, ports, shared `/tmp` fixtures) and takes ~2 minutes.
Every PR now waits for it. A suite that grows to fifteen minutes will get bypassed, and a
bypassed gate is the state this ADR exists to end — so suite runtime is now a gate-health
metric, not just a developer annoyance.

It also commits us to fixing host-coupling rather than tolerating it. Wiring this up
immediately found two real defects that had been invisible because every run happened on
one machine:

- `tests/serve-117-list.test.ts` hardcoded `/home/princess-pi/` in a fixture while asserting
  that the code shortens `$HOME` to `~` — it passed for exactly one username.
- `git-checkpoint` did a bare `git push`, which succeeds on a branch with no upstream *only*
  because this developer has `push.autoSetupRemote=true` set globally. On a fresh clone it
  failed. The script's behaviour was a property of the host, not of the script.

Neither is exotic. Both were found by running the existing suite under an empty `$HOME`,
which is the cheapest CI rehearsal available and should precede any future CI adoption.

## Roads not taken

**Keep it advisory, tell the truth.** Delete the ruleset paragraph and the `pr-threads`
header claim, state plainly that the gate is the human reading the PR, and wire `pr-threads`
in as a warning. This was the honest option while the ruleset bits were off — but they are
on now, and `pr-merge` already refuses on unresolved threads. The gap closed underneath
this option, and taking it would mean *removing* controls that work.

**Drop the PR step.** For a one-human team a PR per change is arguably ceremony. It is also
the only place a human currently pauses, and squash-per-PR is what makes the history
readable. Discarding it to save a click trades a durable artifact for a moment.

**Require an approving review** (`required_approving_review_count: 1`). Deliberately not
taken: PRs here are authored under Duppy's own account, and GitHub does not let an author
approve their own PR. Requiring one approval would deadlock every PR on a solo repo. The
review gate stays human judgment, enforced by `pr-merge` being human-only.

**Pin CI to `bun-version: latest`.** An unpinned runtime turns an upstream release into a
mystery red on an unrelated PR. Pinned to `1.3.14`, bumped deliberately.

## Follow-ups this does not close

- `required_approving_review_count: 0`, `require_last_push_approval: false`, and
  `dismiss_stale_reviews_on_push: false` are all still permissive, and the bypass actor is
  `RepositoryRole: always`. An owner who can always bypass is the same fail-open shape #210
  removed from `pr-cleanup`. Each is a separate decision; none is made here.
- 17 of 19 repos still have no ruleset at all, so *"never merge locally"* remains prose-only
  nearly everywhere (#228 step 5).
- Rulesets do not follow a repo split (#229). Whatever is decided here has to be re-applied
  by hand to the repos that come out of it.
