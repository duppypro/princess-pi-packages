# Development Workflow Spec — TDD + PR Merge

> **Source of truth:** `princess-pi-packages/docs/dev-workflow-spec.md`
> **Research origin:** `btw/research/dev-workflow-spec.md` (archived pointer)

## Why this exists

The old 5-step workflow had four problems the new workflow fixes:

| Old problem | New solution |
|---|---|
| **Human gate between Spec and Code** slowed iteration. Spec couldn't evolve from code feedback without stopping for approval. | Spec Approved is the first commit. Spec Draft is optional. Spec evolves alongside code — no gate. |
| **Commit-message regex gate** (`Code.*Spec.*Approved`, no `not`) was fragile — a hotfix commit that didn't match the pattern blocked merge. | No regex gate. The process guarantees readiness, not the commit wording. |
| **Local merge to main** required the LLM to check out main, merge, rebuild, push — error-prone and token-heavy. | PR-based merge. LLM creates a PR. Human merges it. |
| **Merge-checklist skill** was a post-hoc checklist the LLM ran before saying "ready." Checks were doubled — once in scripts, once in the skill. | Checks are built into scripts. No separate checklist. |
| **No post-merge cleanup** left stale branches and worktrees after merging. | `pr-cleanup` handles 3-step hygiene. |

## Flow diagram

```
Spec Approved ──────────────────────────────────────────────────┐
  (first commit; Spec Draft optional — only for large/open       │
   specs that need human clarification before coding)             │
       │                                                          │
  Write RED tests — Code Draft = tests that fail                 │
  (load the tdd skill; one vertical slice at a time)              │
       │                                                          │
  Write code → all GREEN — Code Approved                         │
       │                                                          │
  Spec Reconciliation — always run spec-reconcile skill ←────────┘
  (Code and Spec Approved commit)
       │
  pr-open
       │
  Human runs pr-merge or pr-reject → pr-cleanup
```

## Label definitions

Labels are commit markers, not gates. Commit as often as needed.

| Label | What it means | Commit message example |
|---|---|---|
| **Spec Approved** | Spec is clear enough to begin TDD. First commit on every issue. | `feat(wtft): Spec Approved — add --verbose flag (#42)` |
| **Code Draft** | RED tests written. Tests fail — feature doesn't exist yet. | `test: Code Draft — RED: verbose output test (#42)` |
| **Code Approved** | All tests GREEN. Automated tests pass. Code is solid. | `feat: Code Approved — --verbose implemented, tests GREEN (#42)` |
| **Code and Spec Approved** | Spec-reconcile pass complete. All docs match code. No code changes after this. | `docs: Code and Spec Approved — spec-reconcile (#42)` |

**After Code and Spec Approved:**
- Update issue body with final resolution
- Close issue, add `attention-needed` label
- `pr-open` — creates PR (ensures pushed, pre-checks, gh pr create)

## Spec Gate

A spec is clear enough to start TDD only when there is a defined test, evaluation
function, set of log outputs, or expected system state to check it against. "I think
this is right" is not a spec gate; "this test goes green" is.

## Branch naming & worktrees

Branch naming (`<issue#>-<slug>`) and the never-edit-on-`main` rule are Hard Gates —
they live in this repo's `CLAUDE.md`, not here, because they can be violated in an
agent's very first tool call, before it has read anything else. This section covers the
mechanics once a branch exists.

All worktrees for a repo `~/git-projects/<repo>` live at
`~/git-projects/worktrees/<repo>/<branch-name>/` — **never inside the clone**. In-tree
worktrees caused a real cascade: a dirty `git status` needing `.gitignore`/`info/exclude`
patches, search tools blind to worktree files, dotted paths breaking session tooling.
One central `worktrees/` parent also gives a single sweep point for stale-workspace
audits.

**How (Claude Code):** `EnterWorktree` without a path hard-codes creation under
`.claude/worktrees/` — never let it create. Instead: (1) from the main clone,
`git worktree add ~/git-projects/worktrees/<repo>/<branch> -b <branch>`; (2)
`EnterWorktree { path: ... }` to switch the session in; (3) `ExitWorktree` cannot remove
a path-entered worktree — exit with `action: "keep"`. Teardown is a separate step
(below), not something `ExitWorktree` does for you.

**Merging a branch's PRs IS the authorization to remove its worktree.** Worktrees are
1:1 with branches. Once every PR raised from a branch is merged, tear the worktree down
without asking again — the confirmation was a question the merge had already answered.
The reasoning is that the agent only proposes teardown when it believes the branch is
finished, and the merge is the human ratifying exactly that belief; prompting again adds
a round-trip and no information.

The gate is **branch completion, not issue completion.** A branch may span several
issues, and issue state is the wrong signal: dotfiles-doctor's `4-first-snapshot` was
complete and merged while its issue #4 still had steps 3–7 outstanding. Umbrella issues
(per-host work, standing "Project status" issues) never close by design, and gating on
them would pin worktrees open forever.

**Still needs an explicit yes:** a branch whose PR was *rejected* or closed unmerged, or
one that never had a PR at all. That is where real work loss lives, and `pr-cleanup`
already fails closed on both — with no merged PR it refuses unless the tip is already an
ancestor of `origin/main`.

Sequence:

0. Get every live session **out** of the worktree first — `ExitWorktree { action: "keep" }`.
   This is a **safety precondition, not a permission question**, and it survives the
   relaxation above unchanged: removing a worktree with a session inside strands that
   session's transcript regardless of who authorized the removal.
1. Confirm `git -C <worktree> status --short` is clean — nothing uncommitted is lost.
2. Confirm the worktree's branch is an ancestor of `origin/main` (its work is merged).
3. `git worktree remove <path>` from the main clone.
4. Delete the now-unreferenced local branch (`git branch -d`).

**Why step 0 is step 0, not an afterthought** (princess-pi-packages#158): entering a
worktree *moves* the session transcript into that worktree's project directory, and only
`ExitWorktree` moves it back — nothing hooks `git worktree remove`. Remove the worktree
while a session is still inside it and that session's transcript is stranded under a
directory that no longer exists; session-discovery tooling then finds nothing, because
both its lookup paths (physical location, last-recorded cwd) point at a path that's
gone. The session becomes invisible until someone exits the worktree — impossible from a
directory that doesn't exist. Symptom: a session you're *currently in* doesn't show up
in the session picker. Recovery is `ExitWorktree { action: "keep" }`.

`pr-cleanup` currently has a known gap here (#221) — it can remove the worktree its own
session is inside, stranding the transcript the same way. Fixed there, not duplicated
here.

## Git guardrails

A `PreToolUse` hook (`~/.claude/hooks/block-dangerous-git.sh`, plus a Pi equivalent)
intercepts dangerous git commands. It is **destination-aware, not a flat block list** —
measured against the hook (2026-08-11):

```
git push --force-with-lease origin 42-my-feature   → exit 0  allowed
git rebase --onto origin/main origin/218-base …    → exit 0  allowed
git push --force-with-lease                        → exit 2  blocked (from a repo on main)
git push origin main                               → exit 2  blocked
```

It blocks by *destination*: a force-push to a named feature branch is allowed, and this
workflow depends on it (`git-checkpoint`, `pr-open`, the rebase recipes below). **Always
name the refspec explicitly** — `git push --force-with-lease origin <branch>`, never the
bare form, since the bare form's safety depends on which branch you happen to be
standing on. (Wording coordinated with #225, which owns the guardrail's canonical
description; if that issue changes the hook's behavior, this section may need a
re-measure.)

**`gh pr merge` in any form is human-only**, regardless of flags. Measured: both
`gh pr merge <N> --squash` and `gh pr merge <N> --squash --admin` are currently allowed
for an agent to run directly — enforcement for this specific command arrives only once
#217 deploys. Until then, the rule holds by convention, not by a technical block: an
agent runs `pr-open` and stops; a human runs `pr-merge`/`pr-reject`.

## Trigger words

- **"ready to merge?"** → run `pr-open` to create the PR.
- **After the human says "done" / "merged"** → verify PR state, then run `pr-cleanup`
  from the feature worktree.

## Scripts

| Script | What it does |
|---|---|
| `pr-open` | Discovers branch from cwd → ensures pushed → pre-checks → `gh pr create` |
| `pr-merge [<branch>]` | Discovers PR from `<branch>`, default current branch → `gh pr merge --squash` (human command) |
| `pr-reject [-b <branch>] [reason]` | Discovers PR from `<branch>`, default current branch → `gh pr close` (human command) |
| `pr-cleanup` | Discovers branch + worktree from cwd → deletes branch, remote, worktree |
| `pr-threads <pr#> [owner/repo]` | Unresolved review-conversation count. Exit 0 = none; exit 1 lists each thread's file and URL. Scriptable merge gate — `gh pr view` has no unresolved-conversation field, that state exists only in GraphQL. |
| `git-checkpoint "msg"` | `git add -A && git commit -m "msg 👑π🐱" && git push` |
| `git-overview` | Branch + `git status --short` + diff stat + recent commits in one call |
| `install-workflow-tools` | Copies every script above from this repo's `bin/` to `~/bin/`. Not itself installed by itself — run from a clone. Reports (does not delete) any stale copy of a retired tool it finds on `PATH` (#235). |

This table is the installer's contract: every script it copies must have a row here, and
every row that's an installable script must be in `install-workflow-tools`' `SCRIPTS`
array. A row here with nothing to install (like this one) is the exception, not a
pattern to repeat.

**Why the branch is positional on `pr-merge` but a flag on `pr-reject`:** `pr-merge`
takes no other argument, so a bare word can only be a branch. `pr-reject` also takes a
free-text reason, and the two cannot be told apart positionally — `pr-reject fix-thing`
is genuinely ambiguous. The old script resolved that ambiguity by silently treating
every first argument as the reason while its own error message advertised
`pr-reject <branch> [reason]`, so naming a branch closed the *current* branch's PR
with the branch name as the comment (#209).

**Both refuse to guess between PRs.** `gh pr list --head` matches by branch *name*
across every fork, so a fork branch called `fix` is an equal candidate to yours. Both
scripts now keep only head branches in your own repo, and abort listing the candidates
if more than one survives rather than taking `.[0]`. A failed `gh pr list` is reported
as a failure, never as "no PR found".

### `pr-cleanup` fails closed, by design

Every gate aborts when it cannot **prove** its precondition. It never treats a failed
command as evidence that deletion is safe. In practice that means `pr-cleanup` will
refuse, and tell you why, when:

| Situation | Why it refuses |
|---|---|
| The worktree has uncommitted or untracked changes | `git worktree remove` refusing IS the safeguard. There is no `--force` retry — a merged PR says nothing about local-only edits. Commit, stash, or force it by hand once you are sure. |
| Your branch tip isn't the commit the PR merged | Proves a PR with this branch *name* merged, but not that *these commits* did. Catches a reused branch name, and commits pushed after the merge. |
| `git fetch`, `git ls-remote` or `gh pr list` fails | An unreachable or unauthenticated remote is not proof of anything. |
| There is no merged PR, the branch is absent from origin, **and** its tip isn't in the primary branch | Absence from origin is not authorization. That is exactly the state of a branch never pushed, or one whose remote ref was deleted *without* merging — its commits exist nowhere else. |
| `origin/<branch>` has moved since the PR merged | Someone pushed after the merge. Your local tip still matches the PR, so nothing local hints at it — those commits live only on the remote. The delete also carries a `--force-with-lease` pinned to the merged sha, so a commit landing mid-run is rejected rather than swept up. |
| `git push --delete` fails and the ref is still on origin | Includes protected-ref rejections. It exits non-zero instead of printing `✅ Cleanup complete`. |
| `git branch -D` fails while the branch still exists | A ref lock or a permissions problem — reported as a failure, never as "already gone". |

Two things that look like bugs and are not:

- **The merge check is the PR's `headRefOid`, not `git merge-base --is-ancestor`.**
  We squash-merge, so a branch tip is *never* an ancestor of its own squash commit.
  An ancestry test would refuse every legitimate cleanup.
- **The local delete is `git branch -D`, not `-d`.** For the same reason: git never
  considers a squash-merged branch merged, so `-d` would refuse every time. The PR gate
  above is the stronger proof — it pins the tip to the exact merged commit.

**Note:** `git-snap` and `git-ship` have been replaced by `git-checkpoint`. The old
names are deprecated — `git-checkpoint` does add + commit + push in one step.
There is never a reason to commit without pushing in the new workflow.

## Issue cadence & branch cleanup

**Comment about as often as you commit.** Keep the issue updated with status progress,
not just code dumps. Every active repo maintains a standing "Project status & human
action items" issue so human and agent don't lose track of the big picture between
sessions.

**Branch cleanup beyond `pr-cleanup`.** Once an issue is closed *and* its work is merged
into `main`, delete all its branches — local and remote — as routine cleanup. Verify
**per-repo, never across repos**: issue numbers collide across repositories, so branch
↔ issue is read from the `<issue#>-<slug>` name of the branch in *that repo*, checked
against *that repo's* closed issues and `origin/main`. Don't delete a branch for another
issue just because it happens to be merged. `git branch -d` may refuse a branch whose
remote was already deleted even though it's merged to `main` — re-confirm the ancestor
check (`git merge-base --is-ancestor <branch> origin/main`), then `-D`.

Deploy/protected branches beyond `main`/`master` aren't a declared concept in the
tooling yet (#222, open) — the guard above assumes the only branch you must never delete
work from is `main`.

## Commit floor for research and debug scripts

Any experiment, prototype, or diagnostic script in `research/` or `debug/` must reach
**at least one git commit before it is deleted, consolidated, or rewritten**. An
experiment that never reached a commit is gone for good; one that did can always be
resurrected from history, and the result it produced stays reproducible. This doesn't
forbid later cleanup — pruning and reorganizing past experiments is expected. It only
sets the floor: commit first, tidy later. Prune only when explicitly asked.

## Happy path — small feature

Issue #42: "wtft: add --verbose flag for extra debug output"

### Commit 1: Spec Approved
```
feat(wtft): Spec Approved — add --verbose flag (#42)

docs/spec-42-verbose-flag.md:
  --verbose        Print extra debug output (default: short)
                   Values: short | full
                   With --verbose=full, includes stack traces.
```

### Commit 2: Code Draft (RED)
```
test: Code Draft — RED: --verbose test expects extra output (#42)

tests/wtft-verbose.test.ts:
  - Test: --verbose (no value) produces extra lines
  - Test: --verbose=full produces stack traces
  - Test: without --verbose, output is unchanged

All 3 tests FAIL — --verbose doesn't exist yet.
```

### Commit 3: Code Approved (GREEN)
```
feat: Code Approved — --verbose flag implemented, tests GREEN (#42)

extensions/wtft.ts:
  + --verbose flag parsing (short | full)
  + conditional debug output

All 3 tests PASS.
```

### Commit 4: Code and Spec Approved
```
docs: Code and Spec Approved — spec-reconcile (#42)

docs/EXT_WTFT.html:        updated --help output with --verbose
docs/manifests/wtft-cmd.json: added --verbose entry
Issue #42 body:            updated with resolution, closed
```

### Ship + merge
```
$ git-checkpoint "docs: Code and Spec Approved (#42)"
$ pr-open
https://github.com/duppypro/princess-pi-packages/pull/43

Duppy: reviews → runs pr-merge → tells agent "done"

Agent: pr-cleanup          # run from the feature worktree
```

**`pr-cleanup` is the merge path only.** Deleting a branch is how work gets lost, so it
deletes nothing until it can prove the commits survive elsewhere — a merged PR whose
head is this exact branch tip, or failing that, a tip already contained in
`origin/main`. A closed-without-merging PR is neither.

After `pr-reject` there is nothing to clean up automatically, because the commits are
still the only copy of that work. Either:

- **revise** — keep the branch and worktree, push again, and the PR path resumes; or
- **abandon** — tear the worktree down by hand, which is a deliberate act gated on
  confirming `git -C <worktree> status --short` is clean.

## When things go wrong

### Spec changes during coding

You write code and realise the spec was wrong or incomplete. **Do not stop.**

1. Update the spec doc to match what the code *should* do
2. Continue coding to the corrected spec
3. Note the drift in an issue comment: "Spec §3: --verbose defaults to 'short', not 'full' — found during impl"
4. Spec-reconcile at the end catches any remaining drift

**No human gate needed.** The spec evolves alongside the code. The Code and Spec
Approved commit is where everything gets reconciled — not before.

### Tests reveal a design flaw

The RED test you wrote passes but the API feels wrong. **Pivot.**

1. Update the spec with the better design
2. Rewrite the RED test to match
3. Force-push the amended commits (feature branch — rewriting is fine)
4. Continue

### Scope creep — discovered the issue is bigger

Mid-implementation, you realise this needs 3 more features to be useful.

1. Comment on the issue: "Discovered --verbose needs --output-format to be useful"
2. File a **follow-up issue**: "#43: add --output-format flag"
3. Keep **this** PR scoped to --verbose only
4. Link the follow-up in the issue body

**Never expand scope on a branch once code is committed.** File a follow-up.

### Merge conflict with main

```
$ pr-open
MERGE_BLOCKED: gh pr create failed.
detail: Pull request has conflicts.
```

Fix:
1. `git fetch origin && git rebase origin/main`
2. Resolve conflicts
3. `git push --force-with-lease origin <branch>` — name the refspec; see
   [Git guardrails](#git-guardrails) for why the bare form is the wrong habit to build
4. Re-run `pr-open`

### A stacked PR conflicts after its parent merges

GitHub reports conflicts on a PR you never touched, right after a *different* PR merged.

**Why.** We squash-merge. A squash discards the branch's commits and writes one new
commit with a new sha. Any branch built on top of that branch still carries the
originals, and git has no idea they are the same work — it sees unmerged commits whose
changes collide with content already in `main`. Every stacked PR breaks at once.

Seen live: #212 merged, and #213 / #214 / #215 / #216 all went red simultaneously.

`pr-open` warns about this *before* you open the PR — it names any unmerged branch your
branch is built on and prints the rebase you will eventually need. It does not block:
stacking is sometimes right. It was right during #207, when `main` was red and a fresh
worktree could not even `bun install`.

**Fix — parent already merged.** Replay only your own commits onto the new `main`:

```
git fetch origin
git rebase --onto origin/main <old-base> <your-branch>
git push --force-with-lease origin <your-branch>
```

`<old-base>` is the parent's tip *as your branch knew it* — the **newest** of the
parent's commits, not the oldest, and not `origin/main`. `git rebase --onto` replays
everything *after* `<old-base>`, so naming the oldest one leaves the rest of the
parent's commits in the range, to be replayed onto a `main` that already contains their
squashed equivalent — which is the repeated-conflict mess this recipe exists to avoid.

`git log --oneline origin/main..<your-branch>` lists the parent's commits still riding
along; the newest of those is the old parent tip.

**Fix — parent still open.** Stay stacked, but re-point at the parent's rewritten tip:

```
git rebase --onto <parent-branch> <old-parent-tip> <your-branch>
```

**The trap.** If your branch *merged* the parent rather than branching from it, do
**not** use the fork point as `<old-base>`. Rebase replays everything in
`<old-base>..HEAD`, which then includes the parent's own commits — onto a base that
already contains them. You resolve the same conflict over and over, and the merge
resolution is discarded anyway, since rebase drops merge commits. Use the **old parent
tip** as the base so only your own commits replay, and expect to resolve any genuine
overlap exactly once.

**Re-run the tests after any rebase.** A rebase replays patches against different
content; clean application is not proof the result still works.

### Human rejects PR with changes requested

1. Read the feedback on the PR
2. Make changes on the same branch
3. Commit + push (PR auto-updates)
4. Re-run spec-reconcile if docs changed
5. Tell Duppy "ready for re-review"

### PR merge blocked by ruleset ("protected ref")

The repository ruleset requires review threads to be resolved before merging.

1. Resolve all review conversation threads (click "Resolve conversation" on each)
2. **This is a human step.** `gh pr merge` is human-only in every form — see
   [Git guardrails](#git-guardrails) — including `--admin`, which bypasses the ruleset
   block if you have admin permissions.
3. The `--admin` flag is temporary — the ruleset is doing its job; fix the root
   cause (unresolved threads) rather than relying on bypass

## What was removed

| Removed | Why |
|---|---|
| Commit-message regex gate (`isStep5ApprovedMessage`) | Fragile — legitimate commits failed over word order. Process guarantees readiness, not wording. |
| `merge-checklist` skill | Post-hoc checklist. The same checks now live in `pr-open` itself. |
| `pre-merge-checklist` skill | Redundant with `merge-checklist`. |
| `bin/merge` CLI (#201) | Replaced by `pr-open`. The Pi `/merge` slash command (`extensions/merge.ts`) is a separate thing and still exists. |
| `bin/post-merge-cleanup` (#207) | Replaced by `pr-cleanup`, which discovers branch and worktree from cwd instead of taking them as arguments. |
| Local merge to main (`merge --cleanup`) | Replaced by PR merge. LLM runs `pr-open`, human runs `pr-merge`. |
| Human gate between Spec Approved and Code Draft | Spec iterates alongside code. Gate moved to PR review. |
