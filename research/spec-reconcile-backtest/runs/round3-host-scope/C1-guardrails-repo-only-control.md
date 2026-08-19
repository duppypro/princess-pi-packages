Read the authority in full, ran it against real repos, and ran the TS twin against the same cases. Findings below in artifact order; no triage, no ranking, nothing fixed.

**Verification method:** scratch clone on `main` + a real linked worktree on `42-feature` (`git worktree add`), hook fed hook-shaped JSON on stdin, exit code + stderr captured; `checkGitCommand()` called directly on the same inputs via `bun`.

---

## A. `hooks/block-dangerous-git.sh` — its own banners and docstrings, in file order

**A1.** `:4` "Always block: … `clean -f/-fd`" — `:838-841` blocks `--force` and *any* short cluster containing `f`. Measured: `-f`, `-fd`, `-df`, `-x -f`, `--force` all exit 2. Two spellings named out of an open set.

**A2.** `:4` "Always block: `checkout .`, `restore .`" — `:786-790` scans every token including past `--`, so `git checkout -- .` and `git restore --staged .` also block (measured exit 2); neither is named. Conversely `git checkout -f main`, which also discards uncommitted work, is **allowed** (measured exit 0) and the "discard work" class never says so.

**A3.** `:11` "`branch -D main/master`" — `:756-777` sets `deleting`/`forcing` from `-D`, `-d`, `-f`, `--delete`, `--force` and clustered forms, and tests *every* positional. Measured: `git branch -df main` and `git branch --delete --force master` both exit 2.

**A4.** `:13` "Allowed there: … every `--abort`/`--quit`" — `:815-816` `case "$cmd" in merge|rebase|cherry-pick|am) return 0` restricts the exemption to four sub-commands. The file's own body comment at `:806-807` states the restriction; the banner contradicts it.

**A5.** `:13-14` and `:16-17` "`checkout -b` / `switch -c` … lift the gate" — `:260` also accepts `-B`, `--orphan`; `:262` also accepts `-C`, `--create`, `--force-create`, `--orphan`. Two of nine lifting spellings are named.

**A6.** `:3` "Block dangerous **git** commands" and the whole `:9-14` block list — silent on the `gh` gate. `:659` stops the prefix walk on `gh` and `:875-882` blocks `gh pr merge`. The file's title claim covers half of what it does.

**A7.** `:35-36` "Cross-harness twin: `extensions/git-guardrails.ts` — keep logic in sync" — the logic twin is `extensions/lib/git-guardrails-core.ts`; `extensions/git-guardrails.ts:126` only calls `checkGitCommand()`, and `tests/git-guardrails-parity.test.ts:21` imports the core, never the extension.

**A8.** `:46-47` "`LIFT_*` record a branch switch earlier in the same line" — no `LIFT_*` variable exists. `:59` declares `LIFTS`. Stale name, repeated at `:199`.

**A9.** `:198-199` "A branch switch inside it DID happen on disk, so `LIFT_*` is left as the child set it." — `:203` does the opposite: `LIFTS="$saved_lifts"` discards it. The TS twin documents the reversal (`extensions/lib/git-guardrails-core.ts:801-808`); this comment was never updated. Measured: `bash -c "git checkout -b ev2" && git commit -m x` on main → exit 2.

**A10.** `:84-85` "A relative `-C` is what git would see from the TOOL-CALL cwd — resolve it there" — `:92-93` resolves against `$HOOK_CWD`, the *effective* cwd that `cd`/`pushd` move at `:243`. The tool-call cwd is `ORIG_CWD` (`:48`) and is not used here.

**A11.** `:110-127` — the line-state banner sits on `repo_key` (`:131`) but documents `apply_cd` (`:210`) and `apply_lift` (`:252`), 80–120 lines below. The TS twin puts the identical text on `interface LineState` (`extensions/lib/git-guardrails-core.ts:68-100`).

**A12.** `:121-122` "a plain `checkout main` / `switch main` marks it as on main (so `git checkout main && git commit` is blocked from a feature branch)" — **false in every real repo.** `:277` `if [ "$force" = 0 ] && ref_exists "$cpath" "$gitdir" "refs/heads/$target"; then return 0` fires before `LIFTS` is written at `:280`, and `main` always exists. Measured from a feature worktree: `git checkout main && git commit -m x` → **exit 0, allowed**; `git switch main && git commit -m x` → **exit 0**. The `ref_exists` guard was written for `checkout -b <existing>` and silently kills the lowering path too.

**A13.** `:128-130` "`realpath -sm`: … so the key matches the TS twin's `path.resolve()` byte for byte" — asserts a guarantee no test pins. It holds on the cases I measured (`realpath -sm //unknown` → `/unknown`, `resolve("//unknown")` → `/unknown`; `//unknown/x` → `/unknown/x` both), but the claim is unpinned.

**A14.** `:161-162` "returns 1 when anything is left unresolved — command substitution, an unknown variable, **a glob**" — `:165` checks only `` ` `` and `$(`, `:178` only a residual `$`. There is no glob or brace check anywhere in `expand_word`. Measured from a feature branch: `cd /tmp/ggt/rep* && git commit -m x` → **exit 0, allowed**, while real bash lands in `/tmp/ggt/repo` on `main` and commits there. Same for `rep?` and `{repo}`. This is a fail-open the docstring claims is closed.

**A15.** `:206-207` "Returns 0 (and updates `HOOK_CWD`) when it consumed the sub-command" — three paths return 0 without updating it: `:215` (`pushd -n`), `:221` (`cd a b`), `:243` (target not a directory).

**A16.** `:249-250` "a plain positional lowers it when it names main/master" — same dead path as A12. `:270-272` explains the `ref_exists` gate only for the `-b <existing>` case and never says it also kills the lowering case it sits directly above.

**A17.** `:473-474` "inspect each git sub-command's tokens. One blocked sub-command blocks the whole command line (fail-safe)." — banner sits on `check_push` (`:477`); both sentences describe the walk in `check_command_string` (`:917-962`). The TS twin dropped the mis-scoped sentence (`extensions/lib/git-guardrails-core.ts:273-275`).

**A18.** `:542-543` "Wrapper binaries that pass execution straight through to **git**" — the table is consumed by `skip_benign_prefix` (`:685-686`), which guards `git` **and** `gh` (`:659`); the file says so itself at `:648-651`.

**A19.** `:570-576` — quote-aware-lexing banner sits on `split_subcommands` (`:579`), but its second half ("Tokens keep quoted content but drop the quote chars, so `git push origin "main"` is seen as pushing main") describes `tokenize` (`:613`), two functions later.

**A20.** `:578` "Split at unquoted `&&`, `||`, `;`, `|`, `&`, and newlines" — `:600` also splits on `(` and `)`. And `:602` emits the literal marker `&&` for `||` as well, so the walk's `case` at `:943` never sees a `||` marker; there is no `"||"` arm.

**A21.** `:637` "Index of the real command word in TOKENS, set by `skip_benign_prefix`." — `:659` sets `PREFIX_START` only when the word is `git` or `gh`; on any other command the walk returns 1 and the global keeps the *previous* sub-command's value.

**A22.** `:884-889` "Full check of one command string: strip heredocs, inspect command substitutions, quote-aware split…" — this is the **only unmatched `# ---` banner in the file** (every other pairs: 2/37, 110/127, 300/303, 361/367, 472/475, 570/576, 640/652, 697/700, 870/874), and it sits on `check_one_sub` (`:891`) while describing `check_command_string` (`:917`). `:890`'s one-liner is `check_one_sub`'s real docstring, orphaned beneath the wrong banner.

**A23.** `:871-872` "Check for dangerous gh (GitHub CLI) command**s**" — `:878` checks exactly one shape.

**A24.** File mode is `0644` in-repo while `hooks/block-edit-on-main.sh` and `hooks/preedit-reread-check.py` are `0755`, despite the `#!/usr/bin/env bash` at `:1`. `bin/install-workflow-tools:337` chmods at deploy so the host copy is armed; `./hooks/block-dangerous-git.sh` from the clone is not runnable.

---

## B. `extensions/git-guardrails.ts`

**B1.** `:6` "Always block: checkout ., restore ., clean -f (discard work, any branch)" — omits `worktree remove --force`/`-f`, which `extensions/lib/git-guardrails-core.ts:781-787` implements and `hooks/block-dangerous-git.sh:4` names. Measured: `git worktree remove --force x` → block on both.

**B2.** `:4` "Blocks dangerous **git** commands via Pi's bash-spawn-hook" — silent on `gh pr merge`, reached through the same `checkGitCommand()` call at `:126` → `extensions/lib/git-guardrails-core.ts:877-881`.

**B3.** `:11` "every `--abort`/`--quit`" and `:12` "checkout -b / switch -c" — inherits A4 and A5 verbatim; same contradictions against `hooks/block-dangerous-git.sh:815-816` and `:260-262`.

**B4.** `:1-46` — the `/** … */` header is followed by `import type` at `:48` with no `@fileoverview` or `@module` tag, so TSDoc/TS attach it to the first import declaration, not the module. `extensions/lib/git-guardrails-core.ts:1-9` → `:11` has the identical problem.

**B5.** `:44` "Spec: `https://github.com/duppypro/princess-pi-packages/issues/74`" vs `README.md:50` `github.com/dproctor/princess-pi-packages` — two owners for one repo. Adjacent, not sourced from the hook.

---

## C. `extensions/lib/git-guardrails-core.ts`

**C1.** `:79-80` and `:616-617` "a plain positional lowers it when it names main/master" — `:640` `if (!force && refExists(...)) return;` returns before `:641` `st.lifts.set(...)`. Measured identical to the shell: `git checkout main && git commit -m x` → allow.

**C2.** `:114-120` `expandWord` docstring omits the "a glob" clause its shell twin carries at `hooks/block-dangerous-git.sh:161`. The two docstrings for the same function disagree, and `:122-127` implements neither.

**C3.** `:2` "Git Guardrails core decision logic (#70, #74, #301) — harness-independent" — silent on the `gh` gate at `:877` and on #208/#189, which the body itself cites at `:461-462`.

**C4.** `:577` "eval runs in the SAME shell: its cd and lifts persist — share the state" — accurate, and the **only** place in the entire artifact set where this is documented. Measured on the shell hook: `eval git checkout -b ev1 && git commit -m x` from `main` → exit 0; `bash -c "git checkout -b ev2" && git commit -m x` → exit 2. `hooks/block-dangerous-git.sh:680-684` has the same behaviour with no comment saying state is shared.

**C5.** `:337-338` "Wrapper binaries that pass execution straight through to git" — same single-consumer wording as A18, contradicted by `:463-466` `isGuardedWord`.

**C6.** `:803-807` "Cost: `bash -c 'git checkout -b x' && git commit` false-blocks" — verified accurate. Listed because `hooks/block-dangerous-git.sh:198-199` states the opposite for the same code path.

---

## D. `docs/dev-workflow-spec.md`

**D1.** `:454` "`git rebase --onto origin/main origin/218-base …        → exit 0  allowed`" — measured **exit 2** from a repo on `main`: `rebase` is in the commit-like set at `hooks/block-dangerous-git.sh:803`. The row carries no branch qualifier while the neighbouring push row at `:455` explicitly carries "(from a repo on main)", and the caption at `:465` says the #301 rows were measured with the main clone as cwd. It is allowed only from a feature branch (measured exit 0 there).

**D2.** `:465` "(#301 lines measured 2026-08-16 with the main clone as tool-call cwd — `debug/smoke-301-hook.sh`.)" — `debug/` contains `flash.mjs`, `parse_histogram.cjs`, `probe_colors.cjs`, `verify-daemon-parse.mjs`. The named script does not exist.

**D3.** `:506` "**`gh pr merge` in any form is human-only**, regardless of flags" and the `:511-513` table — `hooks/block-dangerous-git.sh:878` requires `pr` at exactly `PREFIX_START+1`. Measured: `gh -R duppypro/x pr merge` → **exit 0**, `gh --repo duppypro/x pr merge 5` → **exit 0**. Any `gh` global flag before the subcommand walks the gate. "Regardless of flags" holds only for flags *after* `merge`.

**D4.** `:378` "a plain `checkout main` / `switch main` marks it as on main (so `git checkout main && git commit` is blocked from a feature branch)" — measured allowed; see A12. `tests/fixtures/git-guardrails-cases.json` pins `block-checkout-main-then-commit-on-feature` as `"verdict": "block"` and passes only because its throwaway repo is created on `301-feat` with **no `main` ref**, so `hooks/block-dangerous-git.sh:277` `ref_exists` returns false. The test double masks the real-world verdict.

**D5.** `:380-386` "**Unknown never moves the model (PR #305 review):** … an unresolved `cd` operand (or `~user`) makes the effective cwd **unknown**" — a glob or brace operand is unresolved and does *not* make it unknown; `hooks/block-dangerous-git.sh:229-243` returns the literal and then fails the `-d` test, leaving the cwd on the feature branch. Measured fail-open; see A14.

**D6.** `:368-369` "Allowed on `main`: `pull --ff-only`, `merge --ff-only`, every `--abort`/`--quit`" — `hooks/block-dangerous-git.sh:815-816` limits the exemption to `merge|rebase|cherry-pick|am`.

**D7.** `:389-392` names the child-shell set as "`$( … )` / `bash -c` bodies, pipeline elements and backgrounded jobs" — `eval` is accepted, recursed at `hooks/block-dangerous-git.sh:680-684`, and deliberately **not** a child shell. The spec never mentions `eval` anywhere. An accepted input the reader would conclude is unsupported, with the opposite state semantics from its neighbour `bash -c`.

**D8.** `:337` "nothing hooks `git worktree remove`" — `hooks/block-dangerous-git.sh:851-864` hooks it and blocks `--force`/`-f`. The transcript-restoration sense is clear in context, but the literal claim is false since #225 gap 2, which this same document states at `:473`.

**D9.** `:361` "blocks dangerous git/gh commands" — never names which `gh` command; the reader must reach `:506`, 145 lines later, to learn it is exactly `pr merge`.

**D10.** `:539` "`tests/git-guardrails-parity.test.ts` still exercises `block-dangerous-git.sh` only" — that test also calls `checkGitCommand()` from the TS core (`tests/git-guardrails-parity.test.ts:21` and `:90`), and its own header at `:6-7` says it runs both implementations. The intended reading ("only, of the three hooks") is defensible; the sentence as written is not.

**D11.** `:449-464` — the measured table has no cwd/branch column, and only one of eleven rows carries a branch qualifier, while at least three change verdict with the cwd's branch. Measured from the feature worktree: `git rebase --onto …` → 0, `git commit -m x` → 0, `git push` → 0, `git push origin HEAD` → 0; all four differ from `main`.

**D12.** `:366-367` lists the blocked commit-like set as `commit`, `merge`, `rebase`, `cherry-pick`, `am`, `pull` — silent on `git revert`, which also creates a commit on `main` and is **allowed** (measured exit 0 from the main clone). This is a gap against the intent stated at `:370` ("no work advances on `main` except through a PR"). Same for `git stash` and `git rm -rf .` (both measured exit 0).

**D13.** `:376` "`checkout -b|-B|--orphan` / `switch -c|-C|--create|--force-create|--orphan`" — verified complete and exact against `hooks/block-dangerous-git.sh:260-262`. No finding; recorded because the two file banners (A5) are the incomplete ones and this is the only place the full set appears.

---

## E. `CLAUDE.md`

**E1.** `:5-7` "## ⛔ Hard Gates — **Never edit on `main`.**" — silent that `commit`, `merge`, `rebase`, `cherry-pick`, `am` and `pull` on `main` are *technically blocked* with exit 2 at `hooks/block-dangerous-git.sh:803-832`. An agent reading only this file learns the gate is a convention and discovers the commit block by being refused.

**E2.** `:44` "`pr-merge …` (**human-only**)" and `:45` "`pr-reject …` (**human-only**)" — silent that `gh pr merge` is hard-blocked at `hooks/block-dangerous-git.sh:875-882`, and that `pr-reject`'s `gh pr close` is **not** blocked (measured `gh pr close 5` → exit 0). Identical bolding for one enforced and one unenforced claim.

**E3.** `:30-32` "guardrail hooks (`hooks/`) → `~/.claude/hooks/`" — never names the three hooks or what they block. The Shipped-scripts table at `:38-52` lists 12 scripts and no hooks, so `block-dangerous-git.sh` appears nowhere by name in the file loaded every session.

**E4.** `:26` "## Conventions" is an empty heading — no body, immediately followed by `:28` "## Shipped scripts".

**E5.** `:7` "Always use `<issue#>-<slug>` branches (e.g. `73-server-tool-use-cost`)" — the hook enforces nothing about the branch *name*; `hooks/block-dangerous-git.sh:75-81` treats every name that is not `main`/`master`/`refs/heads/{main,master}` identically. Measured on a worktree branched as plain `foo`: `git commit -m x` → 0, `git push` → 0, exactly as on `42-feature`.

---

## F. `README.md`

**F1.** `:27-35` "## 📦 What's Included" lists six entries and omits `git-guardrails.ts` entirely — the extension that registers the bash tool every Pi session runs through (`extensions/git-guardrails.ts:124-140`) and the `tool_call` Edit/Write gate (`:116-122`). The README never mentions that this repo ships Claude Code `PreToolUse` hooks at all.

**F2.** `:3` "Once installed, these capabilities are automatically loaded into your `pi` environment" and `:53` "Pi will automatically load the extensions and skills" — silent that the Claude Code half is installed by neither `pi install` nor `npm install -g`; it needs `bin/install-workflow-tools` (`CLAUDE.md:30`, `docs/dev-workflow-spec.md:519-525`).

**F3.** `:81-85` "The git-workflow scripts are a separate channel … installed to `~/bin` by `bin/install-workflow-tools`" — names 11 scripts and omits the hooks and statusline scripts the same installer deploys (`bin/install-workflow-tools:235-236`, `:360-361`).

**F4.** `:50` `pi install https://github.com/dproctor/princess-pi-packages` and `:101` `pi remove git:github.com/dproctor/…` vs `:62` `npm install -g github:duppypro/princess-pi-packages` — two owners for one repo. Adjacent; the hook is silent on it.

**F5.** `:110-113` "## 🔄 Testing Your Installation" step 3 says "Test the search tool:" and then shows `/wtft`, not `search_web` from `:30`. No step verifies the guardrail is armed (`install-workflow-tools --check`, `docs/dev-workflow-spec.md:523-525`).

---

## G. `CONTEXT.md` — glossary

**G1.** **Stated plainly: `CONTEXT.md` has no glossary section for this tool.** It carries exactly two — `## Language — Serve` (`:5`) and `## Language — WTFT` (`:164`). No `_Avoid_` list governs any string `hooks/block-dangerous-git.sh` emits, so I am asserting no terminology violation and inventing no terms. `block`, `gate`, `branch`, `fork` and `remove` do appear on `_Avoid_` lists (`:100`, `:56`, `:271`, `:40`), but each is scoped to Serve's TUI/ingress vocabulary or WTFT's session vocabulary and does not reach the guardrail's messages.

**G2.** `:3` "Multi-tool repo for the Princess Pi coding agent: development server, cost tracking, **git workflow**, and CLI utilities" — names git workflow as one of four domains and then gives it no `Language —` section, while the other two named domains each get one.

---

## Checked and found accurate (so the absence isn't mistaken for silence)

- `:485-494` opaque-script gap — verified open: `xargs git push origin main` → exit 0; the fixture case `allow-opaque-script-invocation-hides-git-push` exists at `tests/fixtures/git-guardrails-cases.json:964`.
- `:395-396` "`--abort`/`--ff-only` count only as options, never as the argument of `-m`/`-F`/`--onto`" — `git commit -m --abort` on main → exit 2.
- `:392-395` chain revert — `false && git checkout -b zz1 ; git commit -m x` → exit 2; `git checkout -b zz2 && git commit -m x; git push` → exit 0.
- `:388-389` `( … )` scoping — `( cd <wt> && git commit )` → 0; `( cd <wt> ) ; git commit` → 2.
- `:382-383` `$NAME` from a literal `NAME=value` earlier in the line → resolves; `cd "$UNSET"` → UNKNOWN, exit 2.
- `:387-388` `checkout -b <existing>` does not lift, `-B`/`-C` do — all four measured as documented.
- `:396-397` detached HEAD is not `main` — `git branch --show-current` returns empty, `is_main_ref` false.
- `:467-471` destination-awareness, `:473-483` `worktree remove --force`, `:519-525` deploy targets, `:534-541` the #249 history — all consistent with `hooks/block-dangerous-git.sh` and `bin/install-workflow-tools`.
- Heredoc stripping, quoted refspecs, `--all`/`--mirror`/`--branches`, `:` matching refspec, `HEAD`/`@` resolution, `--repo`, `-C` chaining, `--git-dir`, and all 12 wrappers — measured, every one matches its comment.
