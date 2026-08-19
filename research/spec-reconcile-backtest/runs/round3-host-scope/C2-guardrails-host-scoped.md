---

# Audit — `hooks/block-dangerous-git.sh` and its documenting artifacts

## Host-scoped artifacts: which exist

| Path | Status |
|---|---|
| `./host/git-projects-CLAUDE.md` | **exists** — audited below |
| `./host/claude-CLAUDE.md` | **DOES NOT EXIST** — the `~/.claude` global rules are not staged in this corpus, so none of their claims about this hook could be checked |
| `./host/claude-settings.json` | **DOES NOT EXIST** — and this is the load-bearing absence: `docs/dev-workflow-spec.md:521` states "`settings.json` wires each by path, so whatever sits there is what runs, merged or not." The file that decides whether this hook runs at all, and under which matcher, is absent from the corpus. No claim in it could be verified — including whether `block-dangerous-git.sh` is wired to `Bash` at all |

## How I verified

Behaviour was **measured**, not read: the repo copy of the hook was spawned with hook-shaped JSON against a throwaway repo (`/tmp/gtest`) on `main` and on `42-feat`; the TS twin was called directly via `checkGitCommand()`. **All 24 cross-checked cases matched between the two harnesses** — every divergence below is documentation-vs-code, not `.sh`-vs-`.ts`.

---

## A. `host/git-projects-CLAUDE.md`

**A1.** `:24` "intercept: `git push`" — `hooks/block-dangerous-git.sh:477` blocks by *destination*. Measured: `git push origin 42-feat` from `main` → exit 0. Push is not intercepted; only pushes resolving to `main`/`master` are.

**A2.** `:24` "`git reset --hard`" — `hooks/block-dangerous-git.sh:739-749` blocks only when `effective_branch` is main/master. Measured: `git reset --hard HEAD~1` on `42-feat` → exit 0.

**A3.** `:24` "`git branch -D`" — `hooks/block-dangerous-git.sh:771-777` blocks only when a positional deletion target *is* main/master. Measured: `git branch -D some-other` → exit 0.

**A4.** `:24` is silent on **`gh pr merge`** — `hooks/block-dangerous-git.sh:875-882` blocks it in every form. The single most consequential block this hook performs is absent from the host rule that describes the hook.

**A5.** `:24` is silent on **`git worktree remove --force`/`-f`** — `hooks/block-dangerous-git.sh:851-865` blocks it on any branch.

**A6.** `:24` is silent on **`--all` / `--branches` / `--mirror` / `:`** — `hooks/block-dangerous-git.sh:486-487` and `:523` block these outright regardless of current branch. Measured from `42-feat`: `git push --all` → exit 2.

**A7.** `:24` "(`--ff-only` … stay allowed)" — `hooks/block-dangerous-git.sh:820-822` honours `--ff-only` for `merge` and `pull` **only**. Measured on `main`: `git rebase --ff-only origin/main` → exit 2.

**A8.** `:24` "`--abort` … stay allowed" — `hooks/block-dangerous-git.sh:815-816` honours `--abort` only for `merge|rebase|cherry-pick|am`. Measured on `main`: `git pull --abort` → exit 2. `--quit`, also honoured at `:816`, is never mentioned.

**A9.** `:24` is silent on the **UNKNOWN-cwd block** — `hooks/block-dangerous-git.sh:824-826` blocks every commit-like command when an earlier `cd` in the line was unresolvable, *irrespective of branch*. Measured: `cd "$UNSET_VAR" && git commit -m x` → exit 2 with a distinct message. A reader of `:24` cannot predict this refusal.

**A10.** `:24` "a Pi bash-spawn-hook extension (`princess-pi-packages/extensions/git-guardrails.ts`) intercept" — `extensions/git-guardrails.ts:126` only calls out; the decision logic is `extensions/lib/git-guardrails-core.ts:797`. `docs/dev-workflow-spec.md:362-364` states this correctly ("one file deeper than the issue number alone suggests"); the host rule does not.

**A11.** `:24` is silent on the same extension's **Edit/Write `tool_call` gate** (`extensions/git-guardrails.ts:116-122`) and **session-start main warning** (`extensions/git-guardrails.ts:85-102`). It names the file as a bash-spawn-hook only.

**A12.** `:24` "To perform these operations, the human must run them manually." — `hooks/block-dangerous-git.sh:39-40` reads `.tool_input.command` only. Measured: `git-checkpoint 'msg'` → exit 0, `herdr worktree remove --force wt` → exit 0. Any operation behind an opaque script name is not intercepted. `docs/dev-workflow-spec.md:485-494` documents this as permanent and load-bearing; the host rule presents the block as total.

**A13.** `:24` "Agents are blocked from executing dangerous git commands **across all harnesses**" — both implementations hook only a *shell spawn*. `docs/dev-workflow-spec.md:1416` records that Pi's in-process `/merge` slash command bypassed the guard entirely for exactly this reason. Any future in-process git path is unguarded; "across all harnesses" overstates the seam.

**A14.** `:24` "`git clean -f`/`-fd`" — `hooks/block-dangerous-git.sh:838-840` blocks `--force` and *any* short cluster containing `f` (`-xf`, `-ffd`, `-df`). The two-form enumeration reads as exhaustive and is not.

**A15.** `:24` lists the commit-on-main set as `commit, merge, rebase, cherry-pick, am, pull` — `hooks/block-dangerous-git.sh:803` matches exactly that set, so **`git revert` is allowed on `main`**. Measured: `git revert HEAD` on `main` → exit 0. The stated rationale "`main` advances only through PRs" is not enforced against `revert`, and no artifact says so.

**A16.** `:8` "**Worktree Teardown (merging IS the authorization):** … do not ask again for a confirmation the merge already gave" — `hooks/block-dangerous-git.sh:6-7` cites this very section as authority for the opposite: "teardown is meant to be confirm-first per `~/git-projects/CLAUDE.md` § Worktree Teardown." The source misquotes the host doc it names. (`docs/dev-workflow-spec.md:477-481` gets the reconciliation right; the hook header does not.)

**A17.** `:8` describes the teardown sequence and is silent that `git worktree remove --force` is **hard-blocked** — `hooks/block-dangerous-git.sh:859`. An agent following `:8` and hitting a dirty tree has no way to know `--force` is refused rather than merely discouraged.

**A18.** `:26` Workflow Scripts lists "`git-checkpoint`, `git-overview`, `pr-open`, `pr-merge`, `pr-reject`, `pr-cleanup`, `pr-threads`, and `install-workflow-tools`" — **`wt-new` is absent**, yet `hooks/block-dangerous-git.sh:829` and `:831` instruct the agent to "run `'wt-new <issue#>-<slug>'`". The hook's own remedy names a tool the host script inventory does not list.

**A19.** `:25` — the guidance block `<!--ax:guidance__e948791bc8fe2078-->...<!--/ax:guidance__e948791bc8fe2078-->` has a literal `...` body. Whatever rule it carried about this hook is not present in the staged artifact and could not be checked.

---

## B. `docs/dev-workflow-spec.md`

**B1.** `:337` "only `ExitWorktree` moves it back — **nothing hooks `git worktree remove`**" — `hooks/block-dangerous-git.sh:851-865` does hook `git worktree remove`, refusing the `--force` form. The sentence is true about transcript relocation and false as written about the command.

**B2.** `:368-369` "Allowed on `main`: … **every** `--abort`/`--quit`" — `hooks/block-dangerous-git.sh:815-816` scopes them to `merge|rebase|cherry-pick|am`. Measured: `git pull --abort` → exit 2, `git commit --quit` → exit 2.

**B3.** `:368` "Allowed on `main`: `pull --ff-only`, `merge --ff-only`" — correct, but silent that `rebase --ff-only` is refused (`hooks/block-dangerous-git.sh:820`, which gates `ffonly` on `merge`/`pull`). Measured → exit 2.

**B4.** `:366-367` names the blocked set without noting `revert` is excluded — `hooks/block-dangerous-git.sh:803`. Same gap as A15, at the document that is meant to be exhaustive about it.

**B5.** `:389-392` "`$( … )` / `bash -c` bodies, pipeline elements and backgrounded jobs are child shells and ***nothing* they set carries back — not even a branch switch**" — **contradicted for `$( … )`.** Measured on `main`: `echo $(git checkout -b 999-z) && git commit -m x` → **exit 0** in both harnesses. `hooks/block-dangerous-git.sh:600` splits on bare `(`/`)`, so the substitution body is *also* walked as an ordinary sub-command; `:280` writes the lift into the un-scoped `LIFTS`, and the `)` handler at `:932-937` restores cwd and vars but deliberately not lifts (`:65-66`). Only the *earlier*-ordering is pinned, by fixture `block-substitution-lift-does-not-apply-earlier` (`tests/fixtures/git-guardrails-cases.json`), whose own `why` repeats the false universal: "nothing from a child shell carries back".

**B6.** `:454` measured table row `git rebase --onto origin/main origin/218-base … → exit 0 allowed` — measured today from the same main-clone cwd the block's `:465` note declares: **exit 2**, `hooks/block-dangerous-git.sh:803`. The row predates #301 and was never re-measured.

**B7.** `:449-465` — the table mixes two measurement contexts. `:465` labels only "the #301 lines" as measured with the main clone as cwd; rows `:453`, `:454`, `:457`, `:458` carry no cwd at all, and `:454`'s verdict flips with it. A reader cannot tell which rows are branch-sensitive.

**B8.** `:372` "**What the hook cannot see it fails safe on**" — fail-closed holds for the UNKNOWN-cwd sentinel (`hooks/block-dangerous-git.sh:78`), and **fails open** for an unresolvable branch: `:104` swallows every git error to an empty string, and `is_main_ref ""` returns 1. Measured: `git commit -m x` with cwd `/tmp` (not a repo) → exit 0. A missing or broken `git`, or a corrupt repo, allows everything.

**B9.** `:506` "**`gh pr merge` in any form is human-only**, regardless of flags" — accurate for `gh pr merge` (`hooks/block-dangerous-git.sh:878`), but silent that the check is a literal two-token match. Measured: `gh api --method PUT repos/o/r/pulls/5/merge` → exit 0, `gh pr close 5` → exit 0. The merge-to-main gate has an unmentioned `gh api` path.

**B10.** `:527-529` "`--check` asks three questions per hook … is it **executable**" — the *source* copy is not: `hooks/block-dangerous-git.sh` is mode `-rw-rw-r--` while its two siblings are `-rwxrwxr-x`. `bin/install-workflow-tools:337` chmods on deploy so the host is armed; flagged as a source-side inconsistency with the file's own `#!/usr/bin/env bash` at `:1`, not as a doc contradiction.

**B11.** The spec never states which shells are recursed into. `hooks/block-dangerous-git.sh:549` covers `bash sh zsh dash ksh` only — `fish`, `csh`, `tcsh`, `busybox sh -c` are opaque words and fall through at `:692`.

---

## C. `CLAUDE.md` (project)

**C1.** `:7` "**Never edit on `main`.**" — silent that raw *git* on `main` is also hard-blocked (`hooks/block-dangerous-git.sh:803`). The gate an agent hits first is `commits on main/master` from a Bash call, not an Edit refusal, and this file never names it.

**C2.** `:30-31` "guardrail hooks (`hooks/`) → `~/.claude/hooks/`" — accurate, but silent that the Pi side needs no deploy step (`docs/dev-workflow-spec.md:543-547`). A reader concludes both harnesses require the sync.

**C3.** `:46` "`pr-merge … ` (**human-only**)" — the technical block is on `gh pr merge` (`hooks/block-dangerous-git.sh:878`); `pr-merge` itself is an opaque script name the hook cannot see. Measured: `git-checkpoint 'msg'` → exit 0 by the same mechanism. `pr-merge`'s "human-only" is convention, and the parenthetical does not distinguish it from `gh pr merge`'s enforcement.

**C4.** `CLAUDE.md` has **no row or section for the guardrail hooks themselves** — the "Shipped scripts" table covers `bin/`, and `hooks/` appears only as a deploy destination. Nothing in the file states what is blocked.

---

## D. `README.md`

**D1.** The "📦 What's Included" table (`:27-35`) has **no row for `git-guardrails.ts`** — the extension is registered at `extensions/git-guardrails.ts:76` and replaces the Bash tool wholesale at `:135`. A reader of the inventory concludes the package does not gate git.

**D2.** `:20` "`merge` is the reference cross-harness tool" contradicts `:87-89` in the same file: "**The `merge` CLI this section used to describe is gone.** `bin/merge` was replaced by `pr-open` in #201, and the Pi `/merge` command was deleted in #226." Adjacent to this tool because `docs/dev-workflow-spec.md:1416` records that `/merge`'s deletion is what closed the in-process bypass of this very hook.

---

## E. `CONTEXT.md` (glossary)

**E1.** **The glossary has no section for this tool.** `CONTEXT.md` contains exactly two language sections — `## Language — Serve` (`:5`) and `## Language — WTFT` (`:164`). There is no `Language — Git guardrails`, no entry for *block*, *gate*, *lift*, *line-state*, *effective cwd*, *guarded word*, or *benign prefix*, all of which are load-bearing terms in this source. I am inventing no terminology to fill it.

**E2.** The only near-collision with an `_Avoid_` entry is **`slug`**, used in the user-facing block message `run 'wt-new <issue#>-<slug>'` (`hooks/block-dangerous-git.sh:829`, `:831`; `extensions/git-guardrails.ts:95`). `CONTEXT.md:28` lists `Slug` under `_Avoid_` for **Sub-domain**, but the ruling at `CONTEXT.md:126-129` already narrows it — "A generated URL-safe string used for a filename, directory, article path segment or id **may still be called a slug**… A tenant at the edge → sub-domain. Anything else → slug is fine." A branch-name segment is "anything else". **Not a finding** — recorded so the check is visible rather than skipped.

---

## F. Source docstrings and banner comments, in file order

Every comment block in `hooks/block-dangerous-git.sh` was walked against the symbol below it. Blocks not listed here (`:83-89` `branch_of`, `:110-130` line-state/`repo_key`, `:182-184` `record_assignment`, `:206-209` `apply_cd`, `:247-251` `apply_lift`, `:284-285` `ref_exists`, `:300-309` `strip_heredocs`, `:361-367` `extract_and_check_substitutions`, `:542-543` `GIT_WRAPPERS`, `:546-548` `SHELL_RUNNERS`, `:551-554` `wrapper_arg_opts`, `:611-612` `tokenize`, `:640-652` `skip_benign_prefix`, `:697-700` `check_git_subcommand`, `:779-783` checkout/restore, `:796-802` commit-like, `:844-850` worktree, `:870-874` `check_gh_command`, `:890` `check_one_sub`, `:908-916` `check_command_string`) sit above the right symbol and match its behaviour as measured.

**F1.** `:9-11` "**Block on main/master only:** push whose DESTINATION ref is main/master … branch -D main/master" — these two are *target*-based, not branch-based, and fire from any branch. Measured from `42-feat`: `git push origin main` → exit 2, `git branch -D main` → exit 2 (`hooks/block-dangerous-git.sh:535`, `:773`). The heading misfiles them.

**F2.** `:12-13` "Allowed there: --ff-only (pull/merge), **every** --abort/--quit" — `hooks/block-dangerous-git.sh:816` restricts them to `merge|rebase|cherry-pick|am`. Same defect as B2, in the file that is the authority. Duplicated verbatim at `extensions/git-guardrails.ts:11`.

**F3.** `:35-36` "Cross-harness twin: `extensions/git-guardrails.ts` — **keep logic in sync**" — that file holds no decision logic; `extensions/lib/git-guardrails-core.ts:797` does, and `extensions/lib/git-guardrails-core.ts:6-8` names the relationship correctly. The header sends a maintainer to the wrong file.

**F4.** `:46-47` "**LIFT_*** record a branch switch earlier in the same line" — no such variable. The array is `LIFTS`, declared `hooks/block-dangerous-git.sh:59`. Stale name from an earlier design, repeated at `:199`.

**F5.** `:197-199` (`check_child_string`) "A branch switch inside it DID happen on disk, so **LIFT_\* is left as the child set it**" — the very next line, `hooks/block-dangerous-git.sh:203`, does `LIFTS="$saved_lifts"`. The docstring states the opposite of its own three-line body. (The TS twin's equivalent, `extensions/lib/git-guardrails-core.ts:801-808`, describes the restore correctly.)

**F6.** `:161-162` (`expand_word`) "returns 1 when anything is left unresolved — command substitution, an unknown variable, **a glob**" — there is no glob branch. `hooks/block-dangerous-git.sh:165` rejects `` ` `` and `$(`; `:178` rejects a residual `$`. A glob passes through as a literal. Measured: `cd /tmp/gte* && git commit -m x` → the word survives `expand_word`, fails the `[ -d ]` test at `:243`, and the cwd simply stays put. The TS docstring at `extensions/lib/git-guardrails-core.ts:114-120` correctly omits the glob claim.

**F7.** `:472-475` — the banner above `check_push` carries a walk-level sentence: "One blocked sub-command blocks the whole command line (fail-safe)." That property belongs to `check_command_string` (`hooks/block-dangerous-git.sh:917`), not to `check_push`, which returns 0 or calls `block`. The TS twin files the same sentence in its right home, `extensions/lib/git-guardrails-core.ts:822`.

**F8.** `:570-576` — the banner above `split_subcommands` describes *two* functions: "Tokens keep quoted content but drop the quote chars" is `tokenize`'s contract (`hooks/block-dangerous-git.sh:613`, which has its own one-line comment at `:611`). Mirrored at `extensions/lib/git-guardrails-core.ts:371-377` above `splitOutsideQuotes`.

**F9.** `:884-889` — **a banner sitting above the wrong symbol.** "Full check of one command string: strip heredocs, inspect command substitutions, quote-aware split … This is the recursion point for nested command strings" describes `check_command_string`, which is 28 lines later at `hooks/block-dangerous-git.sh:917` and already carries its own banner at `:908-916`. The block sits directly above `check_one_sub` (`:891`), whose real one-line docstring (`:890`) is trapped beneath it. It is also the only such block in the file with no `# ---` fence, so it visually merges with the line it displaced.

**F10.** `:846-850` (and `extensions/lib/git-guardrails-core.ts:774-780`) "**Scoped to the `remove` subcommand only**" — `hooks/block-dangerous-git.sh:853-855` sets `wt_removing=1` if the token `remove` appears **anywhere** in the argument list, not as the subcommand. Measured: `git worktree lock remove --force` → exit 2 in both harnesses. Fail-safe direction, but not what the comment claims.

**F11.** `:4` "Always block: … clean **-f/-fd**" — `hooks/block-dangerous-git.sh:838-840` also blocks `--force` and any short cluster containing `f`. The enumeration reads as the complete accepted set.

**F12.** `extensions/git-guardrails.ts:6` "Always block: `checkout .`, `restore .`, `clean -f` (discard work, any branch)" — **omits `worktree remove --force`**, which the shell twin's header lists at `hooks/block-dangerous-git.sh:4` and which this extension's own core enforces at `extensions/lib/git-guardrails-core.ts:781-787`. Measured through the TS path → block. The two harness headers disagree about the shared always-block set.

**F13.** `extensions/lib/git-guardrails-core.ts:801-808` "NOTHING it sets comes back — not cwd, not vars, and **not lifts either**" — contradicted for `$( … )` by measurement (see B5). The docstring's stated cost, "`bash -c 'git checkout -b x' && git commit` false-blocks", *is* accurate: measured → exit 2. The `bash -c` path recurses through `skipBenignPrefix` (`:569`) and never touches the parent's `lifts`; the `$( … )` path is additionally split at `:406` and does.

**F14.** `tests/git-guardrails-parity.test.ts:6` "`extensions/git-guardrails.ts` → `checkGitCommand()` called directly" — the import at `tests/git-guardrails-parity.test.ts:21` is `from "../extensions/lib/git-guardrails-core"`. The test header names a file it does not exercise; `extensions/git-guardrails.ts` is never loaded by this suite.

**F15.** `tests/fixtures/git-guardrails-cases.json`, case `block-substitution-lift-does-not-apply-earlier`, field `why`: "a lift inside one must not reach a commit that ran BEFORE it — **nothing from a child shell carries back**". The clause after the dash is broader than what the case pins, and is false in the other ordering (B5). The fixture is the parity gate, so this wording is what future maintainers will treat as the contract.

---

## Not findings — checked and confirmed accurate

`docs/dev-workflow-spec.md:359` three tracked hooks (`hooks/` holds exactly three) · `:110` `git push -u origin <branch>` allowed · `:257-258` `herdr worktree remove --force` walks past the hook (measured → exit 0) · `:378-379` plain `checkout <existing>` does not lift (measured → exit 2) · `:387-388` `checkout -b <existing>` does not lift, `-B`/`-C`/`--force-create` do (measured: `git checkout -b 42-feat && git commit` → exit 2; `git switch --orphan fresh && git commit` → exit 0) · `:392-394` conditional state reverted at `;` (measured → exit 2) · `:396` detached HEAD untouched (measured → exit 0) · `:453` force-push to a named feature branch allowed from `main` (measured → exit 0) · `:457-458` worktree remove force/plain split (measured → exit 2 / exit 0) · `:485-494` the opaque-script gap is real and open (measured) · `:511-513` all three `gh pr merge` forms blocked (measured) · `hooks/block-dangerous-git.sh:30-34` deploy claim (`bin/install-workflow-tools:236` lists it in `HOOKS`; `tests/hooks-deploy-drift.test.ts` exists) · the four referenced test artifacts all exist.
