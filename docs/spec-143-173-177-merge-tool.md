# Spec 143/173/177 — The merge tool learns the worktree era

**Issues:** #143, #173, #177
**Branch:** `143-173-177-merge-tool`
**State:** Spec Draft

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

`cleanupBranch` (`core.ts:45`) ends with, unconditionally:

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

The remote branch is deleted at `core.ts:81`, *before* the local step that fails at `:89`. A failure
there leaves remote-gone / local-present — precisely the state the branch-cleanup standard warns
about, where `git branch -d` later reports "not merged to upstream" because the upstream it would
compare against no longer exists.

**Fix:** invert the order. Detach, delete local, and only then delete remote. Every step before the
remote deletion is local and reversible; once the local branch is gone the remote deletion cannot
strand anything. A failure now leaves remote-present / local-gone, which is inert and re-runnable.

### 3.3 "❌ Merge Aborted" after a successful merge

`bin/merge.ts:67` prints that banner for *any* throw out of `runMerge`, and `cleanupBranch`'s
`execSync` at `:89` is not guarded. So a cleanup failure — after the merge landed and was pushed —
reports as if the merge failed. That is the most expensive defect of the three: it tells the user to
undo work that actually succeeded.

**Fix:** cleanup is best-effort by construction. Wrap the `cleanupBranch` call so nothing inside it
can propagate, and report failures as *cleanup* failures naming what did succeed.

### 3.4 `-D` → `-d`

`core.ts:91` force-deletes. With the ancestor check at `:61` already proving the branch is in
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
