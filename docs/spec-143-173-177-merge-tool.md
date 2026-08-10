# Spec 143/173/177 — The merge tool learns the worktree era

**Issues:** #143, #173, #177
**Branch:** `143-173-177-merge-tool`
**State:** Code Approved

---

## 1. Why these three together

All three live in `bin/merge.ts` + `extensions/lib/merge/core.ts`, and two of them are the same
mistake at different ages: the tool was written for a single-checkout repo that did not track build
artifacts, and both of those assumptions have since stopped holding.

| Issue | What it assumes that is no longer true |
|---|---|
| #143 | `git checkout main` in the current directory always works — true only when no other worktree holds `main` |
| #177 | whatever a branch committed as built output is still correct after that branch is merged with others |
| #173 | (unrelated) `--version` is documented in the manifest, so it must be implemented |

#173 is the odd one out and is included only because it is four lines in the same file.

---

## 2. #173 — a documented flag that was never implemented

`docs/manifests/merge-cmd.json:31` already declares it:

```json
{ "flags": "--version", "desc": "Display this tool's version." }
```

`bin/merge.ts` short-circuits `-h`/`--help` (line 17) and `--why` (line 30), then falls through to
`runMerge()` for everything else. `runMerge`'s first real action is
`git rev-parse --abbrev-ref HEAD`, so outside a git repo:

```
$ node_modules/.bin/merge --version
🔄 Running merge validation checks...
fatal: not a git repository (or any of the parent directories): .git
```

This is the **exact inverse of #160**, and worth naming as a pair. #160 was a working feature the
manifest never mentioned; this is a manifest promise with no feature behind it. Both are the
manifest and the code disagreeing, and both are invisible to anyone who only reads one of them —
which is the argument for `tests/wtft-spec-alignment.test.ts`-style gates that read the manifest and
check the code against it, rather than treating the manifest as prose.

**Fix:** a `--version` branch alongside `-h`/`--why`, reading `name` + `version` from the manifest,
exactly as `bin/serve.ts:31` (`handleVersion`) and `bin/yada.ts:47` (`printVersion`) already do.
Three CLIs, one shape.

---

## 3. #143 — cleanup cannot work in the layout the repo now standardises on

> **All line numbers in this section cite `main` @ `ad91cdc`, i.e. the code as it was
> before this branch.** They are the evidence for the diagnosis, not a map of the current
> file — the fixes below moved every one of them.

`cleanupBranch` (`core.ts:45`) ended with, unconditionally:

```ts
execSync("git checkout main", { cwd, stdio: "ignore" });   // core.ts:89
```

Git refuses to check out a branch already checked out in another worktree. In the standard layout —
main clone at `~/git-projects/<repo>`, feature work at `~/git-projects/worktrees/<repo>/<branch>` —
that command can **never** succeed. Three distinct defects fall out, and they need three distinct
fixes:

### 3.1 Layout-blind (the reported symptom)

`runMerge` already locates a dedicated main worktree (`core.ts:192-203`, `mainCwd` /
`haveMainWorktree`) and uses it to do the merge — then throws that knowledge away before calling
`cleanupBranch`, which re-derives nothing and assumes single-checkout.

**Fix:** pass `mainCwd` down. When a main worktree exists, detach the current worktree instead of
switching it: `git checkout --detach main` is legal even while `main` is checked out elsewhere,
because a detached HEAD does not claim the branch. The branch is then unclaimed by any worktree and
`git branch -d` succeeds.

### 3.2 Partial cleanup state (the defect that outlives the symptom)

The remote branch was deleted at `core.ts:81`, *before* the local step that failed at `:89`. A failure
there leaves remote-gone / local-present — precisely the state the branch-cleanup standard warns
about, where `git branch -d` later reports "not merged to upstream" because the upstream it would
compare against no longer exists.

**Fix:** invert the order. Detach, delete local, and only then delete remote. Every step before the
remote deletion is local and reversible; once the local branch is gone the remote deletion cannot
strand anything. A failure now leaves remote-present / local-gone, which is inert and re-runnable.

### 3.3 "❌ Merge Aborted" after a successful merge

`bin/merge.ts:67` printed that banner for *any* throw out of `runMerge`, and `cleanupBranch`'s
`execSync` at `:89` was not guarded. So a cleanup failure — after the merge landed and was pushed —
reports as if the merge failed. That is the most expensive defect of the three: it tells the user to
undo work that actually succeeded.

**Fix:** cleanup is best-effort by construction. Wrap the `cleanupBranch` call so nothing inside it
can propagate, and report failures as *cleanup* failures naming what did succeed.

### 3.4 `-D` → `-d`

`core.ts:91` force-deleted. With the ancestor check at `:61` already proving the branch is in
`origin/main`, and with the detach at 3.1 putting HEAD on a commit that contains it, `-d` succeeds
on exactly the branches that should be deletable and refuses on the ones that should not. Force is
doing no work here except hiding the case where the ancestor check was wrong.

---

## 4. #177 — the merged tree's build output belongs to no branch

This repo tracks generated `bin/*.mjs` deliberately (`.gitignore:17` — required for
`npm install -g` from a git URL). Two branches touching different bundled sources each commit a
correct bin *for their own tree*; the merge of the two bundles to something neither committed. `main`
then has a stale bin and a clean `git status`.

Measured on the seven-branch merge of 2026-08-10: exactly one file (`bin/wtft.mjs`), and #159's new
gates caught it — correctly refusing to run rather than emitting a false result. The gate makes the
problem visible; nothing closes it.

**Direction chosen (#177's direction 2, per Duppy):** `merge` regenerates and commits.

**Placement matters more than it looks.** The rebuild runs after the merge and **before the push**,
so one push carries both the merge and its build output. Building after the push would need a second
push and would leave a window where `origin/main` is stale.

**Genericity.** `merge` is a general tool that happens to ship here. It runs a build only when the
repo actually has one: a `package.json` with a `build` script, and `bun` resolvable. Absent either,
it says so and continues — a repo with no build has nothing to regenerate, which is not an error.
If the build produces no diff, there is no commit; the common case costs one build and nothing else.

**`--no-build`** opts out for the case where the caller knows better.

**On build failure: do not push.** The merge commit exists locally, so nothing is lost, and pushing
a tree that does not build is worse than a manual recovery. The error names the merge commit and the
worktree it lives in.

### Roads not taken

**Auto-rollback on build failure.** Tempting symmetry with the existing `git merge --abort` path
(`core.ts:241`), but that path aborts a merge *in progress*; undoing a completed merge means
`reset --hard`, which discards a real commit to recover from what is usually a fixable build error.
Leaving the commit in place and refusing to push preserves both options.

**Amending the build into the merge commit.** Produces a tidier history, at the cost of a merge
commit whose content was never what `git merge` produced. A separate `build:` commit keeps "what the
merge did" and "what the build did" independently auditable, which matters because #172 shows build
output can change for reasons that have nothing to do with the source.

**Making `merge` run the tests too.** The natural next thought, and out of scope: tests are slow,
sometimes need a daemon or a port, and a merge tool that runs them becomes a CI system. The build is
different in kind — it is regenerating a *tracked artifact* that the merge itself invalidated.

---

## 5. Verification criteria

Driven by a new sandbox suite (`tests/merge-worktree-cleanup.test.ts`) that builds a real bare
"remote" plus a main clone plus a linked worktree in a tmpdir and drives the actual built
`bin/merge.mjs` — the same shape as the existing `tests/merge-fallback.sandbox.sh`, but as a
`*.test.ts` so `bun run test` runs it.

| # | Criterion |
|---|---|
| V1 | `merge --version` prints `merge <version>` and exits 0 **outside any git repo** |
| V2 | `merge --version` does not print the "Running merge validation checks" banner |
| V3 | The version printed matches `docs/manifests/merge-cmd.json`'s `version` field |
| V4 | `merge --cleanup` from a **linked worktree** completes: merge pushed, local branch deleted, remote branch deleted, exit 0 |
| V5 | After V4 the current worktree is on a detached HEAD at `main`'s commit, and `main` is still checked out in the main clone |
| V6 | Single-checkout layout still cleans up as before (no regression) — branch deleted, back on `main` |
| V7 | When local deletion fails, the **remote branch still exists** (ordering: nothing is deleted remotely until local succeeded) |
| V8 | A cleanup failure never prints "Merge Aborted", exits 0, and states the merge succeeded |
| V9 | After merging two branches that touch different bundled sources, `main` has **no** stale build output — a fresh build produces no diff |
| V10 | The rebuild lands as its own commit, and it is pushed in the same push as the merge |
| V11 | When the build produces no delta, **no** build commit is created |
| V12 | A repo with no `build` script merges normally and reports that it skipped the build |
| V13 | `--no-build` skips the rebuild even where one would have run |
| V14 | A failing build blocks the push and names the merge commit; `origin/main` is unchanged |
| V15 | `bun run test` fully green; `bun run typecheck` exits 0 |

V7, V8 and V14 are the ones that need a deliberately broken fixture rather than a happy path — they
are the criteria that distinguish "the tool works" from "the tool fails honestly", which is the
whole subject of #143.

---

## 6. What implementing it changed in the spec

**A fourth defect in the #143 family, introduced by the #177 fix.** The in-place merge path wraps
any throw from its merge block in *"In-place merge into 'main' failed and was rolled back"*
(`core.ts:243`). A build failure thrown from inside that block would inherit that message — and it
would be false twice: the merge succeeded, and nothing was rolled back. That is the identical lie
#143.3 exists to remove, and the #177 fix would have reintroduced it in the same commit that
deletes it.

Fixed with a tagged `BuildFailureError`: the in-place path re-throws it untouched, and `bin/merge.ts`
prints `❌ Merge not pushed:` rather than `❌ Merge Aborted:` for it. The distinction is the whole
point — one banner tells you to undo work, the other tells you the work is safe and only the push
was withheld.

Worth stating as a general rule the two issues jointly establish: **a failure banner must name what
actually failed.** `merge` now has three (`Merge Aborted`, `Merge not pushed`, `cleanup failed —
the merge succeeded`) because it has three genuinely different outcomes, and collapsing them was
the defect.

**`--cleanup`'s manifest description was wrong for the worktree layout.** It promised "switch to
main after a successful merge", which is what #143 proves cannot happen there. Updated to state both
behaviours, since the flag now does one thing in a single checkout and another in a worktree.

**Cleanup no longer removes the worktree, and says so.** After detaching, the worktree still exists.
The engineering standard gates `git worktree remove` as a manual step — a worktree may be an
assigned scope for a parallel agent session — so cleanup prints the command rather than running it.
This is deliberately *not* the "guided teardown" #143 floats as a bigger alternative.

## 7. Verification note

V7 and V14 need failures git will not produce on request. V7 injects a `git` shim earlier on `PATH`
that fails only on `branch -d`; V14 commits a `build.js` that exits non-zero. Both exercise real
control flow rather than asserting on source text — the ordering fix in #143.2 is only meaningful if
something actually fails at the right moment, and a test that read the source for statement order
would pass against code that never ran.

---

## 8. Result

`bun run test` → **52 suites, 52 passed, 0 failed**. `bun run typecheck` → exit 0.
`tests/merge-worktree-cleanup.test.ts` → **46 checks, all passing**, covering V1–V14.

### The fixture that proved the tool correct by proving the bug absent

Worth recording, because it nearly shipped as a passing test of nothing.

The first #177 fixture built its artifact as a plain concatenation of the sources. Two branches each
edited a different source; the merge was expected to leave a stale bundle. It did not — and the test
failed with `Build output already current — no rebuild commit needed`.

That result was correct. A concatenation is a **pure line-wise function of its inputs**, so git's
3-way merge reconstructs exactly what a fresh build would produce. There is no staleness to fix, and
a fixture built that way can only ever demonstrate that the rebuild step is unnecessary.

What makes real bundles go stale is the part that is *not* line-wise: derived globals — module
counts, tables of contents, ordering, identifier numbering. The corrected fixture adds a
`// modules: N` header. Two branches that each ADD a source both change it `2 → 3` and write the
byte-identical line, so git merges it **silently**, while the truth after the merge is `4`. Stale
artifact, clean `git status`, no conflict. That is #177 exactly, and V9 now asserts the header reads
`4` where an unrebuilt merge would leave `3`.

The general lesson, and the reason this is in the spec rather than a code comment: **a fixture that
cannot exhibit the bug will pass against a tool that does nothing.** The first version would have
gone green the moment the rebuild step was deleted.

### Ordering is asserted, not assumed

V10 originally checked only that the rebuild *appeared* in the output. It now asserts the rebuild is
reported at a lower index than the push line, because "rebuild before push" is the whole design
claim — a rebuild after the push would need a second push and would leave a window where
`origin/main` is stale. Presence and order are different assertions and only one of them is the spec.

### Corrections found by running it

- **V4** compared `feature-x` against `origin/main` *after* `--cleanup` deleted that branch, so the
  ref no longer resolved. The hash is now captured before cleanup — an obvious hazard in hindsight,
  and only visible once the cleanup actually worked.
- **V8** asserted the merge-success wording against the outer best-effort handler, but the injected
  failure lands in the inner local-delete path, which reported the failure without ever saying the
  merge was fine. Fixed in the **code**, not the test: that path now prints
  `✅ The merge itself succeeded and was pushed — nothing needs undoing.` A user who sees a cleanup
  warning should never have to infer that their merge survived.

---

## 9. Step 5 reconciliation

Audited by file-level blast radius — whole files this branch touched, not only the symbols it
edited. Three drifts in `docs/EXT_MERGE.html`, and **two of them predate this branch entirely**,
which is the argument for the scope rule.

| Artifact | Claim | Contradicted by | Test-covered? | Action |
|---|---|---|---|---|
| `EXT_MERGE.html:42` | `bin/merge.mjs` is handwritten plain JS and "needs no `tsx` and no build step" | `bin/merge.mjs` opens `⚠️ GENERATED by build.ts from bin/merge.ts — DO NOT EDIT`; `build.ts:145` builds it | yes — `build-staleness-gate` | fixed: states it is generated, and that `bin/merge.ts` is the source |
| `EXT_MERGE.html` Step 5 Validation | validates against `/^Code and Spec Approved(\s*\([^)]*\))?\s*:/` — the phrase must lead | `isStep5ApprovedMessage` (`core.ts`) is a word rule with free word order, since #100 | yes — `merge-step5-wording` (18 cases) | fixed: documents the word rule, notes what it replaced |
| `EXT_MERGE.html` execution sections | no mention of the post-merge rebuild or worktree-aware cleanup | this branch | yes — `merge-worktree-cleanup` | fixed: two new sections |
| `merge-cmd.json` `--cleanup` | "switch to main after a successful merge" | #143 proves that cannot happen in a worktree layout | yes — V5 | fixed at Code Draft |
| `spec-143-173-177` §3 line numbers | present tense against a file the branch rewrote | the current `core.ts` | n/a | fixed: scoped to `main` @ `ad91cdc`, past tense |

The first two are pre-existing drift of exactly the kind #163's backtest was built to find: a doc
sentence that was true when written and silently stopped being true. Neither is reachable from the
diff of this branch — only from auditing the whole file the branch touches.

`EXT_MERGE.html`'s Step-5 regex is the more dangerous of the two. It documents a **stricter** rule
than the code enforces, so a reader would conclude that a legitimate Step 5 subject (`Specs and code
approved, ship it`) must be rewritten to lead with the phrase. #100 removed that requirement
precisely because it rejected good commits over word order, and the doc has been reinstating it in
readers' heads ever since.

No production code changed in this pass.
