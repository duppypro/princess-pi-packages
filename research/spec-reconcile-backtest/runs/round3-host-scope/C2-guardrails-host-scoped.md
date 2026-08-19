Read everything. Findings below — no fixes applied.

---

# Artifact inventory

| Path | Status |
|---|---|
| `./host/git-projects-CLAUDE.md` | **Exists** — audited (§C) |
| `./host/claude-CLAUDE.md` | **DOES NOT EXIST** — the `~/.claude` global rules were not staged in this corpus. Its guardrail claims are unaudited and unaudit*able* here. |
| `./host/claude-settings.json` | **DOES NOT EXIST** — no `~/.claude/settings.json` was staged. `docs/dev-workflow-spec.md:521` says *"`settings.json` wires each by path, so whatever sits there is what runs"* — that wiring, and the `PreToolUse` matcher for `block-dangerous-git.sh`, is unverifiable in this corpus. |

## Project glossary

`CONTEXT.md` has exactly two glossary sections — `## Language — Serve` (line 5) and `## Language — WTFT` (line 164). **There is no section for the git guardrails**, and every `_Avoid_` entry in the file is explicitly scoped to `serve` or `wtft` internals. I am inventing no terminology and reporting no `_Avoid_` violations: the tool's user-facing strings (`BLOCKED: …`, `hard-resets on main/master.`, `gh pr merge is human-only …`) contain no term the glossary governs for this tool. **Finding G0 below is that the glossary has no section for this tool at all.**

---

# C. `host/git-projects-CLAUDE.md` (host-scoped, in no changeset)

**C1.** — "…intercept: `git push`, `git reset --hard`, `git clean -f`/`-fd`, `git branch -D`, `git checkout .`, `git restore .`." (`host/git-projects-CLAUDE.md:40`) — **`git push` is not intercepted.** `hooks/block-dangerous-git.sh:505-538` blocks only when the *destination* refspec is main/master, or a bare push resolves to main/master. Measured: `git push` on `42-feat` → exit 0; `git push origin 42-feat` → exit 0.

**C2.** — same sentence, `git reset --hard` — **not intercepted.** `hooks/block-dangerous-git.sh:739-749` blocks only when `effective_branch` is main/master. Measured: `git reset --hard HEAD~1` on `42-feat` → exit 0.

**C3.** — same sentence, `git branch -D` — **not intercepted.** `hooks/block-dangerous-git.sh:771-777` blocks only when a positional deletion target `is_main_ref`. Measured: `git branch -D 42-feat` → exit 0; `git branch -D some-other` → exit 0.

**C4.** — same sentence — **silent on `git worktree remove --force`/`-f`**, which is blocked unconditionally on every branch at `hooks/block-dangerous-git.sh:851-865`. Measured: exit 2. A reader of this list concludes it is allowed.

**C5.** — same sentence — **silent on `git push --all` / `--branches` / `--mirror`**, blocked unconditionally on any branch at `hooks/block-dangerous-git.sh:486-487`. Measured from `42-feat`: exit 2.

**C6.** — same sentence — **silent on `git push origin :`** (matching refspec), blocked unconditionally at `hooks/block-dangerous-git.sh:519-524`. Measured from `42-feat`: exit 2.

**C7.** — "Agents are blocked from executing dangerous git commands across all harnesses." (`host/git-projects-CLAUDE.md:40`) — **silent on `gh`.** `hooks/block-dangerous-git.sh:875-882` and `extensions/lib/git-guardrails-core.ts:877-881` block `gh pr merge` in every form. `gh` is not a git command; this bullet's scope sentence excludes the block it also carries.

**C8.** — "(`--ff-only`, `--abort`, and `checkout -b`/`switch -c` stay allowed)" (`host/git-projects-CLAUDE.md:40`) — **`--ff-only` is honoured for `merge` and `pull` only.** `hooks/block-dangerous-git.sh:820-822` gates the exemption on `[ "$cmd" = "merge" ] || [ "$cmd" = "pull" ]`. Measured on main: `git rebase --ff-only origin/main` → exit 2; `git commit --ff-only` → exit 2.

**C9.** — same parenthetical, `--abort` — **honoured for `merge`/`rebase`/`cherry-pick`/`am` only.** `hooks/block-dangerous-git.sh:815-816` restricts it via `case "$cmd" in merge|rebase|cherry-pick|am)`. Measured on main: `git commit --abort` → exit 2; `git pull --abort` → exit 2.

**C10.** — same parenthetical — **silent on `--quit`**, which the code accepts alongside `--abort` for the same four sub-commands (`hooks/block-dangerous-git.sh:815`). Measured on main: `git cherry-pick --quit` → exit 0.

**C11.** — same parenthetical, "`checkout -b`/`switch -c`" — **incomplete.** `hooks/block-dangerous-git.sh:260,262` also accept `-B`, `--orphan` (checkout) and `-C`, `--create`, `--force-create`, `--orphan` (switch) as gate-lifting forms.

**C12.** — same parenthetical — **silent on the fail-closed exception**: `checkout -b <existing-branch>` does **not** lift the gate (`hooks/block-dangerous-git.sh:277-279` — `ref_exists` short-circuits unless `-B`/`-C`/`--force-create`). A reader following this line will write `git checkout -b <existing> && git commit` and be blocked.

**C13.** — "Since princess-pi-packages#301 they also refuse `git commit`, `merge`, `rebase`, `cherry-pick`, `am`, and `pull` while the affected repo is on `main`/`master`" (`host/git-projects-CLAUDE.md:40`) — **incomplete: the refusal also fires when the effective cwd is UNKNOWN, on any branch.** `hooks/block-dangerous-git.sh:824-826` blocks with a dedicated message when `effective_branch` returns `//unknown`. Measured from a repo on main: `cd "$WT" && git commit -m x` → exit 2 with `commits with an UNKNOWN effective cwd …`.

**C14.** — "`main` advances only through PRs" (`host/git-projects-CLAUDE.md:40`) — **`git revert` is not in the blocked set.** `hooks/block-dangerous-git.sh:803` lists `commit|merge|rebase|cherry-pick|am|pull`; `revert` is absent. Measured on main: `git revert HEAD` → exit 0, and it creates a commit on main.

**C15.** — "To perform these operations, the human must run them manually." (`host/git-projects-CLAUDE.md:40`) — **incomplete for the always-blocked class.** `git clean -f`, `git checkout .`, `git restore .`, `git worktree remove --force`, `git push --all/--mirror` are refused regardless of branch (`hooks/block-dangerous-git.sh:784-790, 834-843, 851-865, 486-487`); "these operations" reads as the main-scoped list the sentence follows.

**C16.** — "…and a Pi bash-spawn-hook extension (`princess-pi-packages/extensions/git-guardrails.ts`)" (`host/git-projects-CLAUDE.md:40`) — **silent on the second seam in that same file.** `extensions/git-guardrails.ts:116-122` registers a `tool_call` handler that blocks `edit`/`write` on main via `checkEditOnMain` — not a bash-spawn hook, and not a git command.

**C17.** — "`git branch -d` may refuse a branch whose remote was already deleted even though it's merged; re-confirm the ancestor check, then `-D`." (`host/git-projects-CLAUDE.md:22`) — **contradicts line 40 of the same file**, which lists `git branch -D` as intercepted. The code sides with line 22: `hooks/block-dangerous-git.sh:771-777` blocks only main/master targets.

**C18.** — "**Unchanged safety precondition (not a permission question):** get every live session out first … or `git worktree remove` strands that session's transcript" (`host/git-projects-CLAUDE.md:24`) — **silent that the hook now enforces half of this.** `hooks/block-dangerous-git.sh:851-865` refuses the `--force` form outright; the plain form is left to git's dirty-tree refusal.

**C19.** — "**Merging every PR raised from a branch is implicit permission to remove that branch's worktree** — do not ask again for a confirmation the merge already gave." (`host/git-projects-CLAUDE.md:24`) — **the source's banner cites this same section as saying the opposite.** `hooks/block-dangerous-git.sh:6-8` reads *"teardown is meant to be confirm-first per `~/git-projects/CLAUDE.md` § Worktree Teardown"*. That section is confirm-**last**: merging is the authorization. (See G2.)

**C20.** — "fall back to raw git commands only when a script doesn't cover the exact workflow (interactive rebase, cherry-pick, submodule operations)" (`host/git-projects-CLAUDE.md:42`) — **two of the three named fallbacks are blocked on main.** `hooks/block-dangerous-git.sh:803` blocks `rebase` and `cherry-pick` when the affected repo is on main/master; `git rebase -i` from the main clone → exit 2.

---

# D. `docs/dev-workflow-spec.md`

**D1.** — "`tests/git-guardrails-parity.test.ts` still exercises `block-dangerous-git.sh` only" (`docs/dev-workflow-spec.md:539`) — **false.** `tests/git-guardrails-parity.test.ts:20` imports `checkGitCommand` from `../extensions/lib/git-guardrails-core` and `:25` spawns `SH_HOOK`; its own header (`:4-9`) says *"Runs every case … against BOTH implementations."*

**D2.** — "`$( … )` / `bash -c` bodies, pipeline elements and backgrounded jobs are child shells and *nothing* they set carries back — not even a branch switch" (`docs/dev-workflow-spec.md:389-392`) — **false for `$( )` in the forward direction.** `hooks/block-dangerous-git.sh:600` makes `(` and `)` standalone split markers, so a substitution body is walked a *second* time as an ordinary sub-command inside a `(` scope; `:931-937` pops cwd and vars at `)` but deliberately not `LIFTS` (`:65-66`). Measured on main: `echo $(git checkout -b 888-a) && git commit -m x` → **exit 0 (allowed)**; the TS twin returns `null` for the same line. The backtick form still blocks. The fixture pins only the reverse direction (`block-substitution-lift-does-not-apply-earlier`, `tests/fixtures/git-guardrails-cases.json`).

**D3.** — "`git rebase --onto origin/main origin/218-base …        → exit 0  allowed`" (`docs/dev-workflow-spec.md:454`) — **conditional, and the line carries no qualifier** while its neighbours do. `hooks/block-dangerous-git.sh:803` puts `rebase` in the commit-like set. Measured from a repo on main: exit 2, `rebases on main/master; main advances only through PRs (#301)…`.

**D4.** — "Allowed on `main`: `pull --ff-only`, `merge --ff-only`, every `--abort`/`--quit`" (`docs/dev-workflow-spec.md:368-369`) — **"every" over-claims.** `hooks/block-dangerous-git.sh:815-816` honours `--abort`/`--quit` only for `merge|rebase|cherry-pick|am`. Measured on main: `git commit --abort` → exit 2; `git pull --abort` → exit 2.

**D5.** — "`block-dangerous-git.sh` is **destination-aware, not a flat block list**" (`docs/dev-workflow-spec.md:449`) — **partially false.** `hooks/block-dangerous-git.sh:486-487` is a flat block: `--all`, `--branches`, `--mirror` return before any destination or branch is resolved. Measured from `42-feat`: `git push --all origin` → exit 2.

**D6.** — the measured table (`docs/dev-workflow-spec.md:452-464`) — **omits every always-blocked class except `worktree remove --force`.** No line covers `git checkout .` (`:784-790`), `git restore .` (same), `git clean -f` (`:834-843`), `git push --all/--branches/--mirror` (`:486-487`), `git push origin :` (`:519-524`), `git push origin HEAD` from main (`:525-532`), `git branch -D main` (`:771-777`), or `git reset --hard` on main (`:739-749`). All eight measured exit 2.

**D7.** — "only `ExitWorktree` moves it back — nothing hooks `git worktree remove`" (`docs/dev-workflow-spec.md:337`) — **contradicted by this repo's own hook.** `hooks/block-dangerous-git.sh:851-865` hooks `git worktree remove` and refuses the `--force`/`-f` form. (`docs/dev-workflow-spec.md:473` states the opposite 136 lines later.)

**D8.** — "Intent (Duppy, 2026-08-16): no work advances on `main` except through a PR" (`docs/dev-workflow-spec.md:370`) — **`git revert` advances main and is allowed.** `hooks/block-dangerous-git.sh:803` omits `revert` from the commit-like set. Measured on main: `git revert HEAD` → exit 0.

**D9.** — "an unresolved `cd` operand (or `~user`) makes the effective cwd **unknown** … and unknown is protected" (`docs/dev-workflow-spec.md:383-386`) — **incomplete: the resulting refusal is a distinct message, not the main/master one, and it fires even when every repo on the line is on a feature branch.** `hooks/block-dangerous-git.sh:824-826` emits `${cmd}s with an UNKNOWN effective cwd — an earlier cd in this line could not be resolved (\$VAR from another call, ~user); use a literal path or run the cd on its own line.` No artifact quotes that string.

**D10.** — "`checkout -b <existing>` / `switch -c <existing>` do not lift (git refuses and leaves you on `main` — `-B`/`-C`/`--force-create` do)" (`docs/dev-workflow-spec.md:387-388`) — **incomplete: `--orphan` is named as a lifting form at `:376` but is absent from the force list**, so `checkout --orphan <existing>` also fails to lift. `hooks/block-dangerous-git.sh:274-276` puts only `-B|-C|--force-create` in `force`.

**D11.** — "`--check` asks three questions per hook, not one: is the file **there**, is it **executable**, and does it **match**." (`docs/dev-workflow-spec.md:527-528`) — **silent that the repo *source* copy is not executable.** `hooks/block-dangerous-git.sh` is mode `0664`; `hooks/block-edit-on-main.sh` and `hooks/preedit-reread-check.py` are `0775`. `bin/install-workflow-tools:337` (`chmod +x "$tmp"`) masks it at deploy time, so no check fails — but the asymmetry is undocumented and the file carries a `#!/usr/bin/env bash` shebang it cannot honour in-tree.

**D12.** — "**`gh pr merge` in any form is human-only**, regardless of flags" (`docs/dev-workflow-spec.md:506`) — **incomplete: the block is branch-independent and PR-target-independent.** `hooks/block-dangerous-git.sh:878` tests only `T[s+1] == "pr" && T[s+2] == "merge"`. Measured from `42-feat`: exit 2. The surrounding prose scopes the guardrails to "the merge-to-main gate"; merging a PR that targets a non-main base is refused identically.

**D13.** — "Three tracked `PreToolUse` hooks live in `hooks/`" + the bullet list (`docs/dev-workflow-spec.md:359-365`) — **the `block-dangerous-git.sh` bullet never states what it blocks unconditionally.** It says only "blocks dangerous git/gh commands. Destination-aware, not a flat block list (measured below)" and defers to a table that omits that class entirely (see D6).

---

# E. `CLAUDE.md` (project)

**E1.** — "Run `bin/install-workflow-tools` to sync this host: scripts → `~/bin/`, guardrail hooks (`hooks/`) → `~/.claude/hooks/`" (`CLAUDE.md:30-31`) — **the only mention of the guardrails in this file, and it names no hook and no behaviour.** The Shipped-scripts table (`CLAUDE.md:38-52`) has a row for all twelve scripts and **zero rows for any hook**. A reader of `CLAUDE.md` alone cannot learn that `git commit` on main exits 2 (`hooks/block-dangerous-git.sh:827-832`).

**E2.** — "**Never edit on `main`.** Always use `<issue#>-<slug>` branches" (`CLAUDE.md:7`) — **stated as convention; it is a technical block, and it covers far more than editing.** `hooks/block-dangerous-git.sh:803-832` refuses `commit`/`merge`/`rebase`/`cherry-pick`/`am`/`pull` on main; `extensions/git-guardrails.ts:116-122` refuses `edit`/`write`. Nothing in `CLAUDE.md` says a violation is refused rather than merely discouraged.

**E3.** — "**Never edit generated `.mjs` files.**" hard gate (`CLAUDE.md:8-10`) — **silent that `hooks/*.sh` is the third handwritten-source class with a deploy step.** `hooks/block-dangerous-git.sh:30-34` warns that editing the repo copy without deploying "leaves the host ungated"; the Hard Gates section carries no equivalent.

---

# F. `README.md`

**F1.** — the "📦 What's Included" table (`README.md:27-35`) — **`git-guardrails.ts` has no row.** `extensions/git-guardrails.ts` is the only extension in `extensions/` that can refuse a tool call, and the README's sole inventory omits it. A reader concludes the package ships no git guardrails.

**F2.** — same table — **`hooks/` is absent from the README entirely.** `grep -i hook README.md` matches only `wtft.ts`'s "hooks into turn-completion events" (`README.md:29`). Nothing points at `hooks/block-dangerous-git.sh` or `bin/install-workflow-tools`'s hook channel (`bin/install-workflow-tools:235-238, 360-361`).

**F3.** — "`merge` is the reference cross-harness tool" (`README.md:20`) — **`merge` does not exist.** `./merge:4` execs `bin/merge.mjs`, which is not present in the tree; `README.md:87-89` says so eleven lines later; `docs/dev-workflow-spec.md:1416` records that the Pi `/merge` command was deleted *specifically because* "it ran `git checkout main` → merge → `git push` **in-process**, so the bash-spawn guardrail never saw it."

**F4.** — "This puts **`serve`**, **`wtft`**, **`yada`** … on your `$PATH`" (`README.md:65`) — **silent on the guardrail channel.** The block-quote at `README.md:81-85` lists eleven workflow scripts installed to `~/bin` and never mentions that the same script also installs three `PreToolUse` hooks to `~/.claude/hooks/` (`bin/install-workflow-tools:347, 360-361`).

---

# G. Source docstring & banner sweep — `hooks/block-dangerous-git.sh`, in file order

Every comment block accounted for. Blocks I checked and found accurate are marked ✅.

**G0.** — `CONTEXT.md` has no `Language —` section for the git guardrails. Every user-facing string this tool emits (`hooks/block-dangerous-git.sh:71, 487, 510, 523, 531, 536, 745, 774, 788, 825, 829, 831, 838, 859, 879`) is ungoverned vocabulary. Stated as fact, not a proposal.

**G1.** — `:4` "Always block: checkout ., restore ., clean -f/-fd, worktree remove --force/-f" — **incomplete.** Omits `push --all/--branches/--mirror` (`:486-487`), `push origin :` (`:519-524`), and `gh pr merge` (`:878-879`) — all four are branch-independent blocks in this same file.

**G2.** — `:6-8` "teardown is meant to be confirm-first per `~/git-projects/CLAUDE.md` § Worktree Teardown" — **misquotes the cited document.** `host/git-projects-CLAUDE.md:24` reads "**Merging every PR raised from a branch is implicit permission to remove that branch's worktree** — do not ask again". `docs/dev-workflow-spec.md:477-481` agrees with the host file, not with this banner.

**G3.** — `:9-14` "Block on main/master only: …" — **`gh pr merge` is missing from both halves of the banner's taxonomy.** `:878-879` blocks it on every branch; the banner's two-bucket summary never mentions `gh` at all, though the file's title is "Block dangerous git commands".

**G4.** — `:13` "Allowed there: --ff-only (pull/merge), every --abort/--quit" — **"every" is wrong.** `:815-816` limits `--abort`/`--quit` to `merge|rebase|cherry-pick|am`; `git commit --abort` and `git pull --abort` measure exit 2.

**G5.** — `:9-14` — **silent on `revert`.** `:803` omits it, so the banner's "main advances only through PRs" claim (`:12`) has an unlisted hole.

**G6.** — `:19-26` "Why token parsing (#74)" — ✅ accurate; matches `:579-635`.

**G7.** — `:28-34` install/deploy banner — ✅ accurate; `bin/install-workflow-tools:235-238` lists the file and `tests/hooks-deploy-drift.test.ts:27` tracks it.

**G8.** — `:35-36` "Cross-harness twin: extensions/git-guardrails.ts — … tests/git-guardrails-parity.test.ts runs the same fixture against both." — ✅ **accurate, and it is `docs/dev-workflow-spec.md:539` that is wrong** (see D1). Recording it here because the two artifacts disagree and the source is right.

**G9.** — `:45-47` "LIFT_* record a branch switch earlier in the same line" — **stale symbol name.** There is no `LIFT_*` variable; the state lives in `LIFTS` (`:59`). Same stale name recurs at `:199`.

**G10.** — `:49-56` `UNKNOWN_CWD` — ✅ accurate.

**G11.** — `:57-59` `LIFTS` — ✅ accurate.

**G12.** — `:60-63` `LINE_VARS` — ✅ accurate.

**G13.** — `:64-66` "Lifts are not scoped: a branch switch inside a group happened on disk." — ✅ accurately describes `:931-937`. **This is the design decision that makes D2 fail open**, because `$( )` bodies are re-entered as `(`-scoped sub-commands at `:600`.

**G14.** — `:83-89` `branch_of` docstring — ✅ accurate.

**G15.** — `:110-127` the 18-line "Line-state (#301)" block — **sits above the wrong symbol.** It describes `cd`/`pushd` cwd movement and lift semantics, then is immediately followed by `:128-130` (the `realpath -sm` note) and `repo_key()` at `:131`. `repo_key` does neither: it computes a `<dir>|<gitdir>` key. The block belongs above `effective_branch` (`:144`) or `apply_cd` (`:210`); only `:128-130` documents `repo_key`.

**G16.** — `:143` `effective_branch` — ✅ accurate.

**G17.** — `:158-162` `expand_word` — ✅ accurate; matches `:163-180`.

**G18.** — `:182-184` `record_assignment` — ✅ accurate.

**G19.** — `:197-199` "A branch switch inside it DID happen on disk, so LIFT_* is left as the child set it." — **contradicted by the function it documents.** `:203` reads `LIFTS="$saved_lifts"` — the lift *is* restored, i.e. discarded. The TS twin's JSDoc (`extensions/lib/git-guardrails-core.ts:802-804`) says the opposite of this comment and matches this code.

**G20.** — `:206-209` `apply_cd` — ✅ accurate.

**G21.** — `:247-251` `apply_lift` — ✅ accurate.

**G22.** — `:270-272` "`checkout -b` / `switch -c` / `--orphan` FAIL when the branch already exists" — ✅ accurate; matches `:277-279`.

**G23.** — `:284-285` `ref_exists` — ✅ accurate.

**G24.** — `:300-309` `strip_heredocs` — ✅ accurate.

**G25.** — `:361-366` "Nested git commands inside substitutions must be inspected — `echo $(git push origin main)` would otherwise slip through because the main tokenizer sees "echo" as the command." — **the stated rationale is stale as of #301.** `:600` now splits on bare `(`/`)`, so the substitution body reaches the main walk as its own sub-command regardless; `extract_and_check_substitutions` is now a second, redundant inspection pass. The redundancy is harmless for *blocking* and is the direct cause of the lift leak in D2.

**G26.** — `:370-372` the `${#1}` NB — ✅ accurate and load-bearing.

**G27.** — `:472-474` "Push-target parsing (#74)" — ✅ accurate.

**G28.** — `:484-486` "push modes that inherently sweep in main/master … never safe, block outright" — ✅ accurate, and it is the artifacts (C5, D5) that omit it.

**G29.** — `:520-522` matching-refspec note — ✅ accurate.

**G30.** — `:526-528` `HEAD`/`@` resolution note — ✅ accurate.

**G31.** — `:542-543` `GIT_WRAPPERS` — ✅ accurate.

**G32.** — `:546-548` `SHELL_RUNNERS` — ✅ accurate.

**G33.** — `:551-554` `wrapper_arg_opts` — ✅ accurate.

**G34.** — `:570-576` "Quote-aware lexing" block — **half of it documents a different function.** It sits above `split_subcommands` (`:579`), but its last two sentences — "Tokens keep quoted content but drop the quote chars, so `git push origin "main"` is seen as pushing main" — describe `tokenize` (`:613`), which has its own one-line comment at `:611-612` saying the same thing.

**G35.** — `:592-598` split-marker note — ✅ accurate.

**G36.** — `:637-638` `PREFIX_START` — ✅ accurate.

**G37.** — `:640-652` `skip_benign_prefix` — ✅ accurate.

**G38.** — `:697-700` `check_git_subcommand` — ✅ accurate.

**G39.** — `:706-707` "-C `<path>` and --git-dir `<path>` (both select the affected repo)" — ✅ accurate.

**G40.** — `:750-755` `branch` -D note — ✅ accurate.

**G41.** — `:779-783` checkout/restore note — ✅ accurate.

**G42.** — `:796-802` commit-like note — **its own scope sentence omits `revert`** while asserting "main advances only through PRs". Same gap as G5, restated at the point of enforcement.

**G43.** — `:804-807` option-arguments note — ✅ accurate; verified `git commit -m "--abort"` → exit 2.

**G44.** — `:844-850` `worktree remove` note — ✅ accurate.

**G45.** — `:870-874` `check_gh_command` — **incomplete: "the merge-to-main gate" implies a target check the code does not make.** `:878` matches `pr merge` positionally and blocks regardless of the PR's base branch or the current branch.

**G46.** — `:884-889` "Full check of one command string: strip heredocs, inspect command substitutions, quote-aware split…" — **the docstring is above the wrong symbol.** It describes `check_command_string`, defined at `:917`; it physically sits above `check_one_sub` (`:891`), whose real one-line docstring (`:890`) has been appended to the bottom of it. `check_command_string` then gets a *second*, narrower comment block at `:908-916` covering only the control-flow walk. The `# ---` opened at `:884` is also never closed, unlike every other banner block in the file.

**G47.** — `:908-916` control-flow walk note — ✅ accurate.

---

# H. Source docstring sweep — `extensions/git-guardrails.ts`

**H1.** — `:1-46` file header — **TypeScript will not attach this as a module doc.** The `/** … */` block is immediately followed by `import type { ExtensionAPI }` at `:48` with no `@fileoverview`/`@module` tag and no intervening statement, so tsserver binds it as the JSDoc of that import declaration. Same construction in `extensions/lib/git-guardrails-core.ts:1-9` → `import { execSync }` at `:11`.

**H2.** — `:6` "Always block: checkout ., restore ., clean -f (discard work, any branch)" — **omits `worktree remove --force`**, which `extensions/lib/git-guardrails-core.ts:781-787` implements on this side too, and which `docs/dev-workflow-spec.md:547` says "reaches the Pi side automatically". Also omits `push --all/--branches/--mirror` (`git-guardrails-core.ts:281-284`) and `push origin :` (`:315-319`).

**H3.** — `:6-13` the whole two-bucket summary — **silent on `gh pr merge`**, which `extensions/lib/git-guardrails-core.ts:877-881` blocks on any branch through this same `checkGitCommand` entry point.

**H4.** — `:11` "Allowed there: --ff-only (pull/merge), every --abort/--quit" — **same over-claim as G4.** `extensions/lib/git-guardrails-core.ts:751` gates on `UNDOABLE.has(cmd)` = `merge|rebase|cherry-pick|am`. Verified: `checkGitCommand("git commit --abort", <main repo>)` returns a block reason.

**H5.** — `:6-13` — **silent on the UNKNOWN-cwd refusal** (`extensions/lib/git-guardrails-core.ts:756-758`), which blocks on any branch and emits its own message.

**H6.** — `:24-26` "tests/git-guardrails-parity.test.ts runs the same fixture (tests/fixtures/git-guardrails-cases.json) against both." — ✅ accurate; `tests/git-guardrails-parity.test.ts:20-25`.

**H7.** — `:28-39` Edit/Write gate paragraph — ✅ accurate; matches `:116-122`.

**H8.** — `:41-42` "Usage: `pi -e ./extensions/git-guardrails.ts`" — **contradicted as the deployed path.** `docs/dev-workflow-spec.md:543-546` says Pi loads it from the globally linked package and it "needs no deploy step". The header offers only the manual dev invocation.

**H9.** — `:44-45` "Spec: https://github.com/duppypro/princess-pi-packages/issues/74" — **owner disagrees with README.** `README.md:50` and `:101` use `dproctor/princess-pi-packages`; `README.md:62` uses `duppypro/princess-pi-packages`. One of the two is a dead link; the source header and the install command point at different accounts.

**H10.** — `:57` "// --- Ax feedback log (#124): record sessions that start on main ---" — ✅ accurate; matches `:58-72`.

**H11.** — `:79-84` session-start comment — ✅ accurate.

**H12.** — `:104-115` `tool_call` comment, incl. the `ctx.cwd` rationale — ✅ accurate.

**H13.** — `:94-97` the user-facing notify string — **it is the only place in the corpus that names the escape sequence**, and it is not quoted by `CLAUDE.md:7`, `host/git-projects-CLAUDE.md:40`, or `docs/dev-workflow-spec.md`. `change_working_directory` resolves (`extensions/cd-command.ts:303`), so the string is correct — but unpinned by any artifact.

**H14.** — `:125-132` `spawnHook` — **the block surfaces as a thrown `Error`, not exit 2.** `:128` throws `BLOCKED: '<cmd>' — <reason>`. Every measured table in `docs/dev-workflow-spec.md:452-464, 510-515` states outcomes as `exit 0`/`exit 2`, which is the Claude Code `PreToolUse` contract only. No artifact states the Pi-side failure shape.

---

# I. Source docstring sweep — `extensions/lib/git-guardrails-core.ts`

**I1.** — `:1-9` file header — see H1 (attaches to the `import` at `:11`).

**I2.** — `:8` "Keep the .sh in sync — the parity test runs one fixture against both." — ✅ accurate.

**I3.** — `:25-31` `UNKNOWN_CWD` — ✅ accurate.

**I4.** — `:44-51` `branchOf` — ✅ accurate.

**I5.** — `:68-85` the "Line-state (#301)" block — ✅ correctly placed here (above the `LineState` interface at `:86`), unlike its `.sh` counterpart (G15). Note it is a `//` block, so it is prose, not a JSDoc bound to `LineState`; the interface itself has no `/** */`.

**I6.** — `:89-99` the three field JSDocs on `LineState` — ✅ accurate.

**I7.** — `:114-120` `expandWord` — ✅ accurate.

**I8.** — `:131` `recordAssignment` — ✅ accurate.

**I9.** — `:142` `refExists` — ✅ accurate.

**I10.** — `:162` `effectiveBranch` — ✅ accurate.

**I11.** — `:171` `applyCd` — ✅ accurate.

**I12.** — `:202-207` heredoc block — ✅ accurate.

**I13.** — `:273-275` `checkPush` — ✅ accurate.

**I14.** — `:337-342` `GIT_WRAPPERS` — ✅ accurate.

**I15.** — `:371-377` "Quote-aware lexing" block — **same split-symbol defect as G34.** It sits above `splitOutsideQuotes` (`:380`) but its closing sentences describe `tokenize` (`:422`), which carries its own accurate one-liner at `:421`.

**I16.** — `:455-456` `isGitWord` — ✅ accurate.

**I17.** — `:461-462` `isGuardedWord` — ✅ accurate.

**I18.** — `:468-473` `checkSubstitutions` block — **states the same stale rationale as G25**: "`echo $(git push origin main)` runs the push, it isn't echo data". `splitOutsideQuotes` (`:406-408`) already exposes the body as its own sub-command, so this pass is a redundant second inspection.

**I19.** — `:530-536` `PrefixScan` — ✅ accurate.

**I20.** — `:541-552` `skipBenignPrefix` — ✅ accurate.

**I21.** — `:613-619` `applyLift` — ✅ accurate.

**I22.** — `:644-647` `checkGitSubcommand` — ✅ accurate.

**I23.** — `:734-740` commit-like comment — **omits `revert`** while asserting "main advances only through PRs" (same as G42). `COMMIT_LIKE` at `:601` is `commit, merge, rebase, cherry-pick, am, pull`.

**I24.** — `:774-780` `worktree remove` comment — ✅ accurate.

**I25.** — `:791-796` `checkGitCommand` — ✅ accurate.

**I26.** — `:801-808` `checkChild` — "NOTHING it sets comes back — not cwd, not vars, and **not lifts either**" — **false for `$( )` in the forward direction**, for the reason in D2: `splitOutsideQuotes:406-408` re-exposes the body to the main walk, and `:836-840` pops only `cwd` and `vars` at `)`. Measured: `checkGitCommand("echo $(git checkout -b 888-a) && git commit -m x", <main repo>)` → `null`.

**I27.** — `:805-807` "Cost: `bash -c 'git checkout -b x' && git commit` false-blocks; the child's own sub-commands still see the lift." — ✅ **accurate, verified both directions**: the `bash -c` form returns a block reason; `git checkout -b 556-q && bash -c 'git commit -m x'` returns `null`.

**I28.** — `:822-831` control-flow walk comment — ✅ accurate.

**I29.** — `:856` `checkOneSub` — ✅ accurate.

**I30.** — `:872-876` `checkGhSubcommand` — **same scope over-narrowing as G45**: "the merge-to-main gate" describes a base-branch check `:878` does not perform.

---

# How I verified

- Ran `hooks/block-dangerous-git.sh` directly with hook-shaped JSON on stdin against a throwaway repo (`/tmp/gg`) materialised on `main` and on `42-feat`, 45 command lines total; every exit code quoted above is measured, not inferred.
- Ran `checkGitCommand()` from `extensions/lib/git-guardrails-core.ts` under `bun` on the same lines to confirm which divergences are parity breaks (none of the findings above are — both harnesses agree, including on D2/I26) and which are documentation-only.
- Read `tests/git-guardrails-parity.test.ts:1-60` and enumerated all 191 fixture case ids in `tests/fixtures/git-guardrails-cases.json` to establish which behaviours are pinned; D2's forward direction is unpinned, and `block-substitution-lift-does-not-apply-earlier` pins only the reverse.
- Checked `bin/install-workflow-tools:235-238, 287-290, 329-361` for the hook manifest and the `chmod +x` that masks D11, and `tests/hooks-deploy-drift.test.ts:26-158` for the three `--check` questions.
- Grepped `CONTEXT.md` for every `_Avoid_` line and every `##` heading to establish that no glossary section governs this tool.
