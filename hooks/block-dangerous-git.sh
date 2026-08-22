#!/usr/bin/env bash
# ---
# Block dangerous git commands — branch-aware AND push-target-aware (#70, #74)
#   Always block: checkout ., restore ., clean -f/-fd, worktree remove --force/-f
#     (discard work, any branch — #225 gap 2: `worktree remove` alone was
#     entirely unguarded, and teardown is meant to be confirm-first per
#     ~/git-projects/CLAUDE.md § Worktree Teardown. Plain `remove` stays
#     allowed — git's own refusal on a dirty tree is the safeguard there.)
#   Block on main/master only: push whose DESTINATION ref is main/master,
#     bare push / reset --hard when the affected repo is on main/master,
#     branch -D main/master; and (#301, #391) commit / merge / rebase /
#     cherry-pick / am / pull / revert when the affected repo is on
#     main/master — main advances only
#     through PRs. Allowed there: --ff-only (pull/merge), --abort/--quit for the
#     sub-commands that have one (merge / rebase / cherry-pick / am / revert),
#     checkout -b / switch -c (the escape; can never deadlock).
#   Line-state (#301): the hook runs before the line does, so `cd`/`pushd`
#     move the effective cwd for later sub-commands and `checkout -b`/`switch -c`
#     lift the gate for the repo that switched — see repo_key/effective_branch.
#
# Why token parsing (#74): the old greedy regex `push\s+.*\b(main|master)\b`
# spanned the whole command line, so any co-occurrence of the words blocked
# (compound `&& gh pr create --base main`, branch names like `main-refactor`,
# heredocs merely mentioning both words). It ALSO under-blocked: the current
# branch was resolved from the hook cwd only, so `git -C <path> push` with
# <path> on main slipped through. Fix: strip heredoc bodies, split on shell
# separators, inspect each `git … push` sub-command's refspec tokens, and
# resolve the branch from `-C <path>` when present.
#
# Canonical source: princess-pi-packages/hooks/block-dangerous-git.sh
# Install target:  ~/.claude/hooks/block-dangerous-git.sh (Claude Code PreToolUse)
# Deployed by:     bin/install-workflow-tools — NOT by hand. `--check` reports a
#   deployed copy that differs, and tests/hooks-deploy-drift.test.ts fails the
#   suite on it. Editing here without deploying leaves the host ungated: the
#   copy above sat 56 lines behind this file for weeks (#249/#217), missing
#   check_gh_command entirely, while the parity test ran this copy and passed.
# Cross-harness twin: extensions/git-guardrails.ts — keep logic in sync;
# tests/git-guardrails-parity.test.ts runs the same fixture against both.
# ---

INPUT=$(cat)

# ---
# The tool call is JSON and `jq` is how this hook reads it — there is no fallback
# parser. #390: an empty COMMAND has two causes the code could not tell apart —
# there was no command (benign) and the parser never ran (every guardrail below
# is now absent) — and it reported the first, so a missing or broken `jq` removed
# the whole gate without one error a human would notice. Unknown state is
# protected state, the same rule applied to an unresolvable cd below. A genuinely
# empty .tool_input.command on a SUCCESSFUL parse still exits 0.
# ---
# `command -v` alone would NOT make the "not executable" half of this message
# true: it reports a PATH match without testing the execute bit. Measured on
# bash 5 with a mode-644 jq as the only jq on PATH — `command -v jq` exits 0 and
# prints the path, while invoking it exits 126. That case still failed closed at
# the JQ_STATUS check below, so nothing was ever bypassed, but it arrived under
# a different, vaguer message than the one written for it. `-x` is what makes
# the sentence true where it is printed.
JQ_BIN=$(command -v jq 2>/dev/null || true)
if [ -z "$JQ_BIN" ] || [ ! -x "$JQ_BIN" ]; then
  echo "BLOCKED: git guardrails cannot read the tool call — required dependency 'jq' is missing or not executable on PATH. Install jq (apt install jq / brew install jq); until then every git guardrail is unenforceable and this hook fails closed." >&2
  exit 2
fi
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
JQ_STATUS=$?
if [ "$JQ_STATUS" -ne 0 ]; then
  echo "BLOCKED: git guardrails cannot read the tool call — required dependency 'jq' exited $JQ_STATUS. An unparsed input is an UNKNOWN command, and unknown is protected: this hook fails closed rather than reporting 'nothing to check'." >&2
  exit 2
fi
if [ -z "$COMMAND" ]; then
  exit 0
fi
# Sentinel for "the effective cwd is UNKNOWN" (PR #305 round 4): a cd whose
# operand cannot be resolved here (`cd "$VAR"` set in an earlier tool call,
# `cd ~user`) may have moved the real shell into a main checkout, so the model
# does not stay put — it becomes unknown, and unknown is treated as protected by
# every branch-scoped check until a resolvable cd (or `cd -`/popd) restores it.
# A double-slash path is never a real directory, so it rides through the
# scope/snapshot plumbing as an ordinary cwd value. Defined BEFORE the cwd read
# below (#412 shape: the #390 fix checked the exit status of the .command read
# only — this is the fix for the .cwd read, the 2nd of the same 2 reads) so a
# jq that cannot run here can fail closed to the same sentinel, not "".
UNKNOWN_CWD="//unknown"
HOOK_CWD=$(echo "$INPUT" | jq -r '.tool_input.cwd // .cwd // ""')
JQ_STATUS=$?
if [ "$JQ_STATUS" -ne 0 ]; then
  # A genuinely-absent cwd on a SUCCESSFUL parse still resolves normally
  # (unchanged) — this only covers jq itself failing to run. An empty string
  # here is NOT equivalent to UNKNOWN_CWD: it falls through branch_of()'s
  # `[ -n "$dir" ]` check to a bare `git branch --show-current`, which reads
  # whatever directory the HOOK PROCESS happens to be in — not the tool
  # call's declared cwd — so branch-scoped checks could resolve against the
  # wrong repo entirely instead of failing closed.
  HOOK_CWD="$UNKNOWN_CWD"
fi
# Line-state (#301): HOOK_CWD is the EFFECTIVE cwd and moves with cd/pushd;
# ORIG_CWD is the tool-call cwd it resets to. LIFT_* record a branch switch
# earlier in the same line for the repo that switched (see effective_branch).
ORIG_CWD="$HOOK_CWD"
# LIFTS: newline-separated `<repo key>=<branch>` records, latest wins — one
# entry per repo, so a two-repo line does not clobber itself (PR #305 review).
LIFTS=$'\n'
# LINE_VARS: newline-separated literal `NAME=value` assignments seen earlier in
# the line, latest wins, so `cd "$WT"` / `checkout -b "$BRANCH"` can be resolved;
# anything unresolvable is unknown, and unknown never moves the cwd or lifts.
LINE_VARS=$'\n'
# Subshell scopes: `(` pushes cwd AND vars, `)` pops them — nothing set inside a
# group reaches the parent shell (PR #305 review, twice). Lifts are not scoped:
# a branch switch inside a group happened on disk.
CWD_STACK=()
VARS_STACK=()

block() {
  echo "BLOCKED: '$COMMAND' — $1" >&2
  exit 2
}

is_main_ref() {
  case "$1" in
    main|master|refs/heads/main|refs/heads/master) return 0 ;;
    //unknown) return 0 ;;   # unknown effective cwd is protected (fail-closed, PR #305 round 4)
  esac
  return 1
}

# Branch of the repo the sub-command acts on: -C path wins, else hook cwd (#74 under-block fix).
# A relative -C is what git would see from the TOOL-CALL cwd — resolve it there,
# never against this hook process's own cwd (they differ when the guard runs out-of-repo).
# --git-dir selects the affected repo just like -C (finding 17): HEAD is read
# from it, so it decides the branch. git resolves --git-dir relative to the
# directory the -C chain established. (--work-tree does NOT move HEAD, so it
# is skipped, not captured.)
branch_of() {
  local dir="$1" gitdir="$2"
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  if [ -n "$gitdir" ]; then
    if [ "${gitdir#/}" = "$gitdir" ] && [ -n "$dir" ]; then
      gitdir="$dir/$gitdir"
    fi
    GIT_DIR="$gitdir" git branch --show-current 2>/dev/null || true
    return
  fi
  if [ -n "$dir" ]; then
    git -C "$dir" branch --show-current 2>/dev/null || true
  else
    git branch --show-current 2>/dev/null || true
  fi
}

# ---
# Line-state (#301). The hook runs BEFORE the line executes, so every
# sub-command would otherwise be judged against the tool-call cwd and the
# branch that repo is on right now. Two things an earlier sub-command in the
# same line changes for the later ones:
#   cwd  — `cd`/`pushd <path>` moves the effective cwd; `cd -`/`popd`/bare
#          `pushd` reset it to the tool-call cwd; an unresolvable operand makes it
#          UNKNOWN, which every branch-scoped check treats as protected.
#   lift — `checkout -b|-B|--orphan` / `switch -c|-C|--create|--force-create|--orphan <name>` mark
#          the repo they ran in as being on <name> for the rest of the line
#          (so `git checkout -b 301-slug && git commit` is allowed on main);
#          a plain `checkout main` / `switch main` marks it as on main (so
#          `git checkout main && git commit` is blocked from a feature branch).
#          A plain `checkout <other>` does NOT lift: the positional may be a
#          path (file restore) and guessing fails open.
# The lift is keyed to the repo that switched (-C/--git-dir/cwd resolved), so
# `git -C other checkout -b x && git commit` still judges the cwd repo.
# ---
# The key is the repo's own IDENTITY, not the words used to name it (#421).
# `git --git-dir=.git checkout -b x && git commit` spells one repository two
# ways; keying on the spelling filed the lift under one key and looked it up
# under another, which failed BOTH directions — a false block when the miss
# re-read main, and a real bypass when a `--git-dir` switch TO main was invisible
# to the bare commit that followed.
#
# --absolute-git-dir, not --git-common-dir: a linked worktree gets its own
# `.git/worktrees/<name>` and must stay distinct, because a lift in a worktree
# is not a lift in the main clone.
#
# realpath -sm on the fallback: syntactic normalisation only (no symlink
# resolution), so the key matches the TS twin's path.resolve() byte for byte —
# a symlinked worktree must not lift the gate on one harness and not the other.
# The fallback is what a non-repo (or an unresolvable cwd) gets, and two
# spellings of a directory git cannot identify stay two keys.
#
# A resolution FAILURE is not silently absorbed (PR #424 review): repo_key
# returns 1 and its callers record `?degraded=` in the lift table. Without that,
# a transient failure — index.lock contention, a resource limit, git briefly
# unresolvable on PATH — hitting the store but not the lookup (or the reverse)
# put the two on different keys; the lookup missed, `branch_of` answered with the
# PRE-switch branch, and `git --git-dir=.git checkout main && git commit` sailed
# through. That is fail-OPEN, the one direction the fallback must never take.
repo_key() {
  local dir="$1" gitdir="$2" id
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  if [ -n "$gitdir" ] && [ "${gitdir#/}" = "$gitdir" ]; then
    gitdir="$dir/$gitdir"
  fi
  if [ -n "$gitdir" ]; then
    id=$(GIT_DIR="$gitdir" git -C "${dir:-.}" rev-parse --absolute-git-dir 2>/dev/null) || id=""
  else
    id=$(git -C "${dir:-.}" rev-parse --absolute-git-dir 2>/dev/null) || id=""
  fi
  if [ -n "$id" ]; then
    printf '%s' "$id"; return 0
  fi
  printf '%s|%s' "$(realpath -sm "$dir" 2>/dev/null || printf '%s' "$dir")" "${gitdir:+$(realpath -sm "$gitdir" 2>/dev/null || printf '%s' "$gitdir")}"
  return 1
}

# A line on which any identity resolution failed judges every later MISS as
# unknown — and unknown is protected. Recorded inside LIFTS itself so the
# existing save/restore of line-state carries it for free.
DEGRADED_KEY='?degraded'
mark_degraded() { case "$LIFTS" in *$'\n'"$DEGRADED_KEY="*) ;; *) LIFTS+="$DEGRADED_KEY="$'\n' ;; esac; }
lifts_degraded() { case "$LIFTS" in *$'\n'"$DEGRADED_KEY="*) return 0 ;; *) return 1 ;; esac; }

# Branch the sub-command acts on, honouring an earlier switch in the same line.
effective_branch() {
  local key rest
  # unknown cwd + a relative (or absent) -C target → the branch is unknowable
  if [ "$HOOK_CWD" = "$UNKNOWN_CWD" ] && { [ -z "$1" ] || [ "${1#/}" = "$1" ]; }; then
    printf '%s' "$UNKNOWN_CWD"; return
  fi
  # No lift on this line means no lookup can hit, so skip resolving the key —
  # it now costs a `git rev-parse` and the answer would be discarded (#421).
  if [ -n "${LIFTS#$'\n'}" ]; then
    if key=$(repo_key "$1" "$2"); then
      rest="${LIFTS##*$'\n'$key=}"      # ## → LAST record for this key
      if [ "$rest" != "$LIFTS" ]; then
        printf '%s' "${rest%%$'\n'*}"; return
      fi
    else
      mark_degraded
    fi
    # A miss on a degraded line may be a key mismatch rather than a different
    # repo, and that difference decides whether a lift is honoured — so the
    # branch is unknowable, not "whatever the repo is on right now".
    if lifts_degraded; then printf '%s' "$UNKNOWN_CWD"; return; fi
  fi
  branch_of "$1" "$2"
}

# Resolve $NAME / ${NAME} in a word from LINE_VARS, then the hook's own
# environment (HOME, PWD and other exported names are shared with the tool's
# shell). Prints the expanded word and returns 0; returns 1 when anything is
# left unresolved — command substitution, an unknown variable, a glob — so the
# caller can fail closed instead of trusting a literal '$WT'.
expand_word() {
  local w="$1" name val rest
  case "$w" in *'`'*|*'$('*) return 1 ;; esac
  while [[ "$w" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]]; do
    name="${BASH_REMATCH[1]}"
    rest="${LINE_VARS##*$'\n'$name=}"   # ## → LAST assignment wins (PR #305 review)
    if [ "$rest" != "$LINE_VARS" ]; then
      val="${rest%%$'\n'*}"
    elif [ -n "${!name+x}" ]; then
      val="${!name}"
    else
      return 1
    fi
    w="${w/"${BASH_REMATCH[0]}"/$val}"
  done
  case "$w" in *'$'*) return 1 ;; esac
  printf '%s' "$w"
}

# `NAME=value` (or `export NAME=value`) standing alone as a sub-command: remember
# the literal value for expand_word. Values that themselves expand are skipped —
# they would need the same resolution recursively, and unknown is the safe state.
record_assignment() {
  local w="${TOKENS[0]}" name val n=${#TOKENS[@]}
  # Only a STANDALONE assignment counts — `VAR=x git commit` is a command with
  # a prefix and must fall through to the checks below.
  if [ "$w" = "export" ]; then [ "$n" -eq 2 ] || return 1; w="${TOKENS[1]}"; else [ "$n" -eq 1 ] || return 1; fi
  [[ "$w" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || return 1
  name="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
  case "$val" in *'$'*|*'`'*) return 0 ;; esac
  LINE_VARS+="$name=$val"$'\n'
  return 0
}

# A child shell (`bash -c`, `$(…)`, backticks) sees the current cwd but its own
# cd never comes back — restore HOOK_CWD after the recursive check. A branch
# switch inside it DID happen on disk, so LIFT_* is left as the child set it.
check_child_string() {
  local saved_cwd="$HOOK_CWD" saved_vars="$LINE_VARS" saved_lifts="$LIFTS"
  check_command_string "$1"
  HOOK_CWD="$saved_cwd"; LINE_VARS="$saved_vars"; LIFTS="$saved_lifts"
}

# `cd`/`pushd`/`popd` as the FIRST word of a sub-command moves the effective
# cwd. Returns 0 (and updates HOOK_CWD) when it consumed the sub-command.
# The cwd only moves to a directory that EXISTS: a failing `cd /nope; git commit`
# leaves the real shell where it was, so the model must too (PR #305 review).
apply_cd() {
  local w="${TOKENS[0]##*/}" arg="" t npos=0
  case "$w" in cd|pushd|popd) ;; *) return 1 ;; esac
  for t in "${TOKENS[@]:1}"; do
    # `pushd -n <dir>` rotates the stack without changing directory (PR #305 round 3)
    if [ "$w" = "pushd" ] && [ "$t" = "-n" ]; then return 0; fi
    if [ "$t" = "-" ] || [ "${t#-}" = "$t" ]; then
      npos=$((npos + 1)); [ "$npos" -eq 1 ] && arg="$t"
    fi
  done
  # bash rejects `cd a b` ("too many arguments") — the real shell stays put (PR #305 round 4)
  [ "$npos" -gt 1 ] && return 0
  local target
  if [ "$w" = "popd" ] || [ "$arg" = "-" ] || { [ "$w" = "pushd" ] && [ -z "$arg" ]; }; then
    HOOK_CWD="$ORIG_CWD"   # previous directory is unknowable here — never guess
    return 0
  elif [ -z "$arg" ] || [ "$arg" = "~" ]; then
    target="$HOME"
  else
    if ! arg=$(expand_word "$arg"); then
      HOOK_CWD="$UNKNOWN_CWD"; return 0     # unresolvable → the cwd is UNKNOWN (protected)
    fi
    if [ "${arg#\~/}" != "$arg" ]; then
      target="$HOME/${arg#\~/}"
    elif [ "${arg#\~}" != "$arg" ]; then
      HOOK_CWD="$UNKNOWN_CWD"; return 0     # `~user` — not resolved here → unknown
    elif [ "${arg#/}" != "$arg" ]; then
      target="$arg"
    else
      [ "$HOOK_CWD" = "$UNKNOWN_CWD" ] && return 0   # relative from unknown stays unknown
      target="${HOOK_CWD:-.}/$arg"
    fi
  fi
  [ -d "$target" ] && HOOK_CWD="$target"   # a cd that would fail moves nothing
  return 0
}

# Record a branch switch for the rest of the line (#301 line-state).
#
# Two ways a sub-command moves the line onto another branch:
#   create — -b/-B, -c/-C/--create/--force-create, --orphan <name>.
#   switch — a LONE positional naming an existing branch (or main/master).
#
# #399: the switch case used to be recorded only when the ref did NOT exist, so
# `git checkout main` — the only way to reach main, and the most ordinary command
# an agent could type — never registered, and the #301 commit-like gate never
# fired. "Does the ref exist" answers whether git would SUCCEED, and that
# question belongs to the create case alone (`checkout -b <existing>` fails and
# leaves the repo where it was, PR #305 review). For a plain switch, an existing
# ref is precisely the evidence that it IS a branch switch rather than a pathspec.
#
# Still fail-closed where the answer is a guess: a RESTORE-FORM option means
# no switch (see restore_form below), more than one positional is the
# `git checkout <tree-ish> <path>…` restore form (which does not switch either),
# a name that is neither main/master nor an existing branch is a pathspec or a
# detached checkout, an unresolved $BRANCH is nothing at all, and a DIRTY
# worktree means git may refuse the switch outright (see worktree_dirty).
# main/master lifts whether or not the ref exists — if the switch fails, the line
# stays where it was, and treating the rest of it as protected is the safe
# direction.
# Does this `checkout`/`switch` carry an option that makes it a RESTORE or
# otherwise NO-SWITCH form? Every one of these leaves HEAD where it was, so the
# lone positional beside it is a tree-ish or a pathspec, never a branch to lift.
#
# #399 fallout: `--` was the only terminator, and `--pathspec-from-file` starts
# with `-`, so it was skipped by the positional count — `git checkout feature
# --pathspec-from-file=paths` left `feature` as the lone positional, lifted, and
# the `git commit` after it ran unguarded on main. Measured against git 2.43.0,
# each entry below with `feature` as its positional and HEAD on main:
#   --pathspec-from-file=<f> / --pathspec-from-file <f> → "Updated 1 path from
#     …", HEAD=main;  --pathspec-file-nul → "requires --pathspec-from-file"
#   -p / --patch → "No changes.", HEAD=main (restores hunks, never switches)
#   --ours / --theirs → "fatal: '--ours/--theirs' cannot be used with switching
#     branches";  --overlay / --no-overlay → the same fatal for '--[no]-overlay'
# The list is measured, not guessed, and stays that way: `--conflict=<style>`
# looks equally path-ish and DOES switch ("Switched to branch 'feature'"), so it
# is deliberately absent. Terminating on every unknown option would make that a
# false block — the #400 class of defect.
restore_form() {
  local t
  for t in "$@"; do
    case "$t" in
      --|-p|--patch|--pathspec-from-file|--pathspec-from-file=*|--pathspec-file-nul|--ours|--theirs|--overlay|--no-overlay)
        return 0 ;;
    esac
  done
  return 1
}

apply_lift() {
  local cmd="$1" cpath="$2" gitdir="$3" worktree="$4" lift_key; shift 4
  local -a rest=("$@")
  local t target="" created=0 i=0 n=${#rest[@]} npos=0 prev_resolved=0
  restore_form "${rest[@]}" && return 0   # no switch happens: nothing to lift
  # #419 review: `--detach`, and its `-d` short form, for BOTH sub-commands.
  # Detaching leaves HEAD on a COMMIT rather than a branch, so a commit made
  # after it cannot advance ANY local branch — least of all main. Measured
  # (git 2.43.0, repo on main): `checkout --detach main`, `checkout -d main`,
  # `switch --detach main`, `switch -d main` and a bare `checkout --detach`
  # all answer "HEAD is now at …" and leave `git branch --show-current` EMPTY.
  #
  # So the lift records the EMPTY branch name — exactly what git reports for a
  # detached worktree — instead of the target, which names the commit we
  # detached AT, not a branch we are on. Recording the target blocked the
  # following commit for a command that cannot reach main at all.
  #
  # Returning early here would NOT fix that: it leaves the line's earlier state
  # (on main) standing and the commit stays blocked. The lift has to be TO the
  # detached state, not absent — which is why the review's suggested `return 0`
  # is not the remedy applied.
  #
  # Every fail-closed test below still runs, because a detaching checkout is
  # refused by the same dirty worktree (measured: "error: Your local changes …
  # would be overwritten by checkout", HEAD unmoved) and by the same missing
  # ref. Detach changes only the VALUE recorded, never whether a lift happens.
  # Known remaining over-block, deliberate: `--detach <sha>` still records no
  # lift, because <sha> is no branch and resolving arbitrary commit-ish would
  # widen the allow set on a guess.
  local detach=0 t4
  for t4 in "${rest[@]}"; do
    case "$t4" in -d|--detach) detach=1; break ;; esac
  done
  for t in "${rest[@]}"; do case "$t" in -|@\{-*\}) npos=$((npos + 1)) ;; -*) ;; *) npos=$((npos + 1)) ;; esac; done
  while [ "$i" -lt "$n" ]; do
    t="${rest[$i]}"
    if [ "$cmd" = "checkout" ]; then
      case "$t" in -b|-B|--orphan) target="${rest[$((i + 1))]:-}"; created=1; break ;; esac
    else
      case "$t" in -c|-C|--create|--force-create|--orphan) target="${rest[$((i + 1))]:-}"; created=1; break ;; esac
    fi
    # `-` and `@{-N}` name the previous branch; `-` would otherwise be eaten
    # by the option test on the next line (#419 review).
    case "$t" in
      -|@\{-*\})
        [ "$npos" -ne 1 ] && return 0
        target=$(previous_branch "$cpath" "$gitdir" "$t") || return 0
        prev_resolved=1; break ;;
    esac
    case "$t" in -*) i=$((i + 1)); continue ;; esac
    [ "$npos" -ne 1 ] && return 0   # <tree-ish> <path>… restore: no switch
    target="$t"; break
  done
  if [ -z "$target" ]; then
    # A bare `git checkout --detach` / `git switch --detach` detaches at HEAD
    # and lands even on a dirty tree (measured) — the tree does not change.
    if [ "$detach" = 1 ] && [ "$created" = 0 ]; then
      lift_key=$(repo_key "$cpath" "$gitdir") || mark_degraded
      LIFTS+="$lift_key="$'\n'
    fi
    return 0
  fi
  if [ "$prev_resolved" = 0 ]; then
    target=$(expand_word "$target") || return 0   # '$BRANCH' unresolved → no lift (fail-closed)
  fi
  if [ "$created" = 1 ]; then
    # -B / -C / --force-create reset-or-create and always land; the plain create
    # forms fail on an existing name and leave the repo where it was.
    # (The create forms name the local branch outright, so no <remote>/... DWIM
    # applies here — `switch -c foo origin/main` creates `foo`.)
    local force=0 t2
    for t2 in "${rest[@]}"; do
      case "$t2" in -B|-C|--force-create) force=1 ;; esac
    done
    if [ "$force" = 0 ] && ref_exists "$cpath" "$gitdir" "refs/heads/$target"; then
      return 0
    fi
  else
    # #389: `<remote>/main` lands on a NEW LOCAL main — lift the LOCAL name.
    # Only when a tracking flag is present. Measured against git 2.43.0: the
    # DWIM that creates a local branch from a remote-named target requires one
    # of -t / --track / --track=<mode> / --no-track. WITHOUT one,
    # `git checkout origin/main` DETACHES - a commit there does not advance
    # main - and `git switch origin/main` is fatal. Neither lands on a branch,
    # so lifting them was a false block, the #400 class of defect.
    local dwim
    if has_track_flag "${rest[@]}" && dwim=$(dwim_main_branch "$cpath" "$gitdir" "$target"); then
      target="$dwim"
    elif ! is_main_ref "$target" && ! ref_exists "$cpath" "$gitdir" "refs/heads/$target"; then
      return 0   # not a branch: pathspec or detached checkout — no line-state change
    fi
    # #399 fallout: the lift is recorded OPTIMISTICALLY — the hook runs before
    # the command, so a switch git REFUSES leaves the gate believing the line
    # moved off main. Measured (git 2.43.0, repo on main, `feature` exists,
    # f.txt locally modified): `git checkout feature && git commit -m x` errors
    # "Your local changes … would be overwritten by checkout", HEAD stays on
    # main — and the commit lands there. So a lift to a NON-main target is
    # recorded only when the switch is reasonably certain to land: a clean tree,
    # or a force flag that overrides the refusal outright.
    #
    # Deliberately coarse, and it over-blocks: a dirty file that does not differ
    # between the two branches carries over and the switch succeeds, but the
    # hook cannot know that without diffing the target. The cost is one extra
    # command — run the checkout on its own line, then commit — and the
    # direction matches this file's rule that unknown state is protected state.
    #
    # main/master is untouched on purpose: it lifts either way, because if that
    # switch fails the line stays put and the rest is protected regardless.
    if ! is_main_ref "$target" && ! force_switch "$cmd" "${rest[@]}" \
       && worktree_dirty "$cpath" "$gitdir" "$worktree"; then
      return 0
    fi
  fi
  # Detached: the line is on no branch at all — record that, not the target.
  [ "$detach" = 1 ] && [ "$created" = 0 ] && target=""
  lift_key=$(repo_key "$cpath" "$gitdir") || mark_degraded
  LIFTS+="$lift_key=$target"$'\n'
  return 0
}

# Configured remotes of the repo the sub-command acts on. Same -C/--git-dir
# resolution as ref_exists.
git_remotes() {
  local dir="$1" gitdir="$2"
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  if [ -n "$gitdir" ]; then
    [ "${gitdir#/}" = "$gitdir" ] && gitdir="$dir/$gitdir"
    GIT_DIR="$gitdir" git remote 2>/dev/null || true
  else
    git -C "${dir:-.}" remote 2>/dev/null || true
  fi
}

# #389: a target that names a REMOTE ref does not create a branch by that name.
# `git switch -t origin/main`, `--track origin/main`, `--track=direct
# origin/main`, `--no-track origin/main` and `git checkout --track origin/main`
# all answer "Switched to a new branch 'main'" (measured, git 2.43.0): the branch
# git creates and lands you on is the LOCAL main. refs/heads/origin/main never
# exists, so the pre-#389 test found no branch, recorded no lift, and the #301
# on-main gate judged the following `git commit` against the feature branch -
# bypassed by the most idiomatic form there is.
#
# Prints the local branch name and returns 0 when <ref> is <remote>/main (or
# /master) AND <remote> is a CONFIGURED remote of the affected repo. Both halves
# carry weight:
#   - only a first segment that is a real remote is stripped, so a local branch
#     literally named `feature/main` keeps its name - `feature` is no remote;
#   - answering only for main/master keeps this TIGHTENING-ONLY: a
#     <remote>/<feature> target can never turn a standing block into an allow,
#     and main/master is the only question the gate asks.
# The neighbouring forms that do NOT create a local branch (`git checkout
# origin/main` -> detached HEAD, `git switch origin/main` -> fatal) lift too,
# The caller gates this on has_track_flag, so the neighbouring forms that do NOT
# create a local branch are left alone: `git checkout origin/main` gives a
# detached HEAD (a commit there does not advance main) and `git switch
# origin/main` is fatal (no switch at all). Lifting those was a false block of
# the #400 class. The split is exact, not a guess: a tracking flag is present in
# every measured form that creates a local branch and absent from every one that
# does not.
# Does this sub-command carry a tracking flag? That is what turns a
# `<remote>/<branch>` target into a NEW LOCAL branch instead of a detached HEAD
# (checkout) or a fatal error (switch) - verified against git 2.43.0.
# `--no-track` counts: the DWIM keys on the remote-named target, not on whether
# tracking is configured, so this set is flag-VALUE agnostic.
has_track_flag() {
  local t
  for t in "$@"; do
    case "$t" in -t|--track|--no-track|--track=*) return 0 ;; esac
  done
  return 1
}

dwim_main_branch() {
  local cpath="$1" gitdir="$2" ref="$3"
  local remote="${ref%%/*}" branch="${ref#*/}" remotes
  [ "$remote" = "$ref" ] && return 1   # no slash: not a <remote>/<branch> target
  [ -z "$remote" ] && return 1
  # Cheap test first - no subprocess for the overwhelmingly common target.
  is_main_ref "$branch" || return 1
  remotes=$(git_remotes "$cpath" "$gitdir")
  case $'\n'"$remotes"$'\n' in
    *$'\n'"$remote"$'\n'*) printf '%s' "$branch"; return 0 ;;
  esac
  return 1
}

# Does the repo the sub-command acts on have uncommitted changes to TRACKED
# files? Same -C/--git-dir resolution as ref_exists.
#
# Tracked-only (--untracked-files=no) because untracked files never block a
# checkout — measured git 2.43.0: a switch with only an untracked file present
# answers "Switched to branch 'feature'". Staged changes DO block it (same
# "would be overwritten" refusal), which is why this is `status --porcelain`
# rather than `diff --quiet`. A git that fails to answer at all reads as dirty:
# unknown state is protected state.
# #419 review: `-` is git's shorthand for `@{-1}`, the branch you were on
# before. `git checkout - && git commit -m x` from a feature branch whose
# previous branch was main lands you ON main and the commit advances it —
# measured, git 2.43.0. The token starts with `-`, so every option test in
# apply_lift skipped it, no lift was recorded, and the gate judged the commit
# against the feature branch the repo had not been on since the first word of
# the line. A pre-existing hole of the #301 class, not #399 fallout: before
# #399 a plain switch never lifted either, so this read `allow` just the same.
#
# Prints the branch `-` / `@{-N}` names, or nothing when it cannot be resolved
# (no reflog yet, or the previous position was a detached HEAD, in which case
# --abbrev-ref answers a sha or `HEAD` and no branch is named). Nothing means
# no lift, which is the fail-closed direction: if the switch cannot be
# resolved here it may not happen there either, and the line stays where the
# repo actually is.
previous_branch() {
  local dir="$1" gitdir="$2" ref="$3" out
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  [ "$ref" = "-" ] && ref="@{-1}"
  if [ -n "$gitdir" ]; then
    [ "${gitdir#/}" = "$gitdir" ] && gitdir="$dir/$gitdir"
    out=$(GIT_DIR="$gitdir" git rev-parse --abbrev-ref "$ref" 2>/dev/null) || return 1
  else
    out=$(git -C "${dir:-.}" rev-parse --abbrev-ref "$ref" 2>/dev/null) || return 1
  fi
  # a detached previous position resolves to a sha or to `HEAD`, never a branch
  case "$out" in ''|HEAD|*[!A-Za-z0-9._/-]*) return 1 ;; esac
  [ "$out" = "$ref" ] && return 1          # unresolved: rev-parse echoed it back
  printf '%s' "$out"
}

worktree_dirty() {
  local dir="$1" gitdir="$2" worktree="${3:-}" out
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  # #419 review: `--work-tree` selects the tree git will actually check out
  # into, and that is the tree whose local changes make git refuse. Measured
  # (git 2.43.0): with the cwd tree CLEAN and the --work-tree tree DIRTY,
  # `git --work-tree=<dirty> checkout feature` answers "error: Your local
  # changes … would be overwritten by checkout" and HEAD stays put — while a
  # dirtiness test that read the cwd saw a clean tree and lifted. Relative
  # paths resolve from the -C directory, exactly like --git-dir.
  if [ -n "$worktree" ]; then
    [ "${worktree#/}" = "$worktree" ] && worktree="${dir:-.}/$worktree"
  fi
  if [ -n "$gitdir" ]; then
    [ "${gitdir#/}" = "$gitdir" ] && gitdir="$dir/$gitdir"
    # Both assignment prefixes are LITERAL on purpose (#419 review round 4). An
    # expanded `${worktree:+GIT_WORK_TREE=...}` is not an assignment: bash
    # decides what is an assignment prefix at PARSE time, so the expanded word
    # became the command NAME, the probe failed, and the fail-closed path below
    # reported every tree — clean ones included — as dirty. Measured on a CLEAN
    # alternate tree: `git --git-dir=… --work-tree=… checkout feature && git
    # commit` was blocked while real git answered "Switched to branch
    # 'feature'". An over-block, not a bypass, but a false one.
    if [ -n "$worktree" ]; then
      out=$(GIT_DIR="$gitdir" GIT_WORK_TREE="$worktree" \
        git -C "$worktree" status --porcelain --untracked-files=no 2>/dev/null) || return 0
    else
      out=$(GIT_DIR="$gitdir" git status --porcelain --untracked-files=no 2>/dev/null) || return 0
    fi
  elif [ -n "$worktree" ]; then
    out=$(GIT_WORK_TREE="$worktree" git -C "${dir:-.}" status --porcelain --untracked-files=no 2>/dev/null) || return 0
  else
    out=$(git -C "${dir:-.}" status --porcelain --untracked-files=no 2>/dev/null) || return 0
  fi
  [ -n "$out" ]
}

# Does this sub-command carry a flag that overrides git's refusal to switch with
# local changes? Measured, git 2.43.0, dirty tree: `checkout -f`, `checkout
# --force`, `switch -f` and `switch --discard-changes` all answer "Switched to
# branch 'feature'". The set is PER-SUB-COMMAND, not shared: `git checkout
# --discard-changes feature` answers "error: unknown option `discard-changes`"
# and never switches, so accepting it there would reopen the hole it closes.
# `-m`/`--merge` is deliberately absent: it landed in every case measured here,
# but git documents the operation as failing when the three-way merge is not
# possible, so it is not certain to land — and the conservative side of that
# uncertainty is a lift not taken.
force_switch() {
  local cmd="$1" t; shift
  for t in "$@"; do
    case "$t" in
      -f|--force) return 0 ;;
      --discard-changes) if [ "$cmd" = "switch" ]; then return 0; fi ;;
    esac
  done
  return 1
}

# Does <ref> exist in the repo the sub-command acts on? Same -C/--git-dir
# resolution as branch_of.
ref_exists() {
  local dir="$1" gitdir="$2" ref="$3"
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  if [ -n "$gitdir" ]; then
    [ "${gitdir#/}" = "$gitdir" ] && gitdir="$dir/$gitdir"
    GIT_DIR="$gitdir" git show-ref --verify --quiet "$ref" 2>/dev/null
  else
    git -C "${dir:-.}" show-ref --verify --quiet "$ref" 2>/dev/null
  fi
}

# ---
# Drop heredoc bodies so quoted text like `<<EOF\ngit push origin main\nEOF`
# is never mistaken for a command (#74 false-positive class 3).
# ---
# Heredoc delimiters are general shell WORDs, not identifiers — numeric and
# dashed/dotted names are valid (#74 review finding 13b). And '<<EOF' inside
# quotes is data — the old blind regex entered body mode on it and stripped
# the real commands after, failing open (#74 review finding 13a). Char-scan
# with quote state (persisting across lines, as shell quotes do) and $(( ))
# tracking (a << there is a bit-shift, never a heredoc opener).
#
# #400: `$( ... )` starts a FRESH quoting context - the shell re-lexes inside it,
# so `--body "$(cat <<'EOF' ... EOF)"` really does open a heredoc even though an
# enclosing double quote is still open. The scan used to stay in double-quote
# state across the `$(`, never saw the opener, and left the whole body for the
# outer walk; one unpaired double quote in the prose then ended the --body
# string and the remaining lines were split into sub-commands. That is how a
# bug report ABOUT a git command gets blocked for quoting it.
#
# A QUOTED delimiter (<<'EOF' / <<"EOF") is inert by definition - no expansion,
# no substitution - so its body is dropped at any depth. An UNQUOTED <<EOF body
# still expands ($(git push ...) inside it executes), so its handling is
# deliberately UNCHANGED: it is stripped only where no enclosing quote was open,
# which is exactly the set of positions the old top-level-only scan reached.
# outerq counts those enclosing quotes.
strip_heredocs() {
  local line probe delim="" dashed=0 q="" arith=0
  local i n ch j w d qdelim dch outerq=0 qtop
  local -a qstack=()
  while IFS= read -r line; do
    if [ -n "$delim" ]; then
      # <<- : terminator may be tab-indented (#74 review finding 7)
      probe="$line"
      if [ "$dashed" -eq 1 ]; then
        probe="${probe#"${probe%%[!$'\t']*}"}"
      fi
      [ "$probe" = "$delim" ] && delim=""
      continue
    fi
    n=${#line}
    for ((i = 0; i < n; i++)); do
      ch="${line:$i:1}"
      # `$(` - enter the substitution's own quoting context (not `$((`, which is
      # arithmetic and handled below). A single-quoted region is literal, so no
      # substitution starts there (#400).
      #
      # The `arith -eq 0` test is REQUIRED, and its absence was a bug: the
      # matching pop below is arith-guarded, so a `$(` opened inside an active
      # `$(( ... ))` pushed a frame whose own `)` - still inside the arithmetic -
      # the pop skipped. The orphan frame was then consumed by a later, unrelated
      # `)`, restoring the wrong quote state for the rest of the line. Push and
      # pop must agree on their guards; the bare-`(` push below already did.
      if [ "$q" != "'" ] && [ "$arith" -eq 0 ] && [ "${line:$i:2}" = '$(' ] && [ "${line:$i:3}" != '$((' ]; then
        qstack+=("$q"); [ -n "$q" ] && outerq=$((outerq + 1))
        q=""; i=$((i + 1)); continue
      fi
      if [ -z "$q" ] && [ "$arith" -eq 0 ] && [ "$ch" = ')' ] && [ ${#qstack[@]} -gt 0 ]; then
        qtop="${qstack[$((${#qstack[@]} - 1))]}"; unset 'qstack[${#qstack[@]}-1]'
        if [ "$qtop" != "GROUP" ]; then
          [ -n "$qtop" ] && outerq=$((outerq - 1))
          q="$qtop"
        fi
        continue
      fi
      # Bare `(` - a subshell/grouping paren, not a `$(` (that case already
      # `continue`d above). It doesn't touch q, but it MUST be pushed so its
      # own `)` isn't mistaken for the closer of an enclosing `$(` (#400
      # finding 1 review): `$(true; (true); cat <<'EOF' ...)` was popping the
      # `$(`'s saved quote state on the FIRST `)` - the one closing `(true)` -
      # leaving the real closer to read as ordinary text and the heredoc to
      # never open.
      if [ -z "$q" ] && [ "$arith" -eq 0 ] && [ "$ch" = '(' ]; then
        qstack+=("GROUP"); continue
      fi
      if [ "$q" = "'" ]; then
        [ "$ch" = "'" ] && q=""
      elif [ "$q" = '"' ]; then
        if [ "$ch" = '\' ]; then i=$((i + 1))
        elif [ "$ch" = '"' ]; then q=""; fi
      elif [ "$ch" = '\' ]; then
        i=$((i + 1))
      elif [ "$ch" = "'" ] || [ "$ch" = '"' ]; then
        q="$ch"
      elif [ "${line:$i:3}" = '$((' ]; then
        arith=$((arith + 1)); i=$((i + 2))
      elif [ "$arith" -gt 0 ] && [ "${line:$i:2}" = '))' ]; then
        arith=$((arith - 1)); i=$((i + 1))
      elif [ "$arith" -eq 0 ] && [ "${line:$i:2}" = '<<' ] \
        && [ "${line:$i:3}" != '<<<' ] \
        && { [ "$i" -eq 0 ] || [ "${line:$((i - 1)):1}" != '<' ]; }; then
        j=$((i + 2)); d=0
        [ "${line:$j:1}" = '-' ] && { d=1; j=$((j + 1)); }
        while [ "$j" -lt "$n" ] && [[ "${line:$j:1}" =~ [[:space:]] ]]; do j=$((j + 1)); done
        # #389: the delimiter is a shell WORD, and a word is the CONCATENATION
        # of its adjacent quoted and unquoted pieces - <<'END'x is delimited by
        # ENDx, <<x'END' by xEND, <<E'ND' by END (verified against bash: a line
        # ENDx terminates the first, a bare END does not). Recording only the
        # first piece left a delimiter that never arrives: the scan stayed in
        # body mode to end-of-input and ate every real command AFTER the
        # heredoc - a fail-open on every gate downstream. Keep collecting pieces
        # until an unquoted word boundary. Shell rule: if ANY piece is quoted,
        # the WHOLE delimiter is quoted, so the body is inert text and is
        # dropped at any depth.
        qdelim=0
        w=""
        while [ "$j" -lt "$n" ]; do
          dch="${line:$j:1}"
          if [ "$dch" = "'" ]; then
            qdelim=1; j=$((j + 1))
            while [ "$j" -lt "$n" ] && [ "${line:$j:1}" != "'" ]; do
              w+="${line:$j:1}"; j=$((j + 1))
            done
            [ "$j" -lt "$n" ] && j=$((j + 1))   # closing quote
          elif [ "$dch" = '"' ]; then
            qdelim=1; j=$((j + 1))
            while [ "$j" -lt "$n" ] && [ "${line:$j:1}" != '"' ]; do
              if [ "${line:$j:1}" = '\' ] && [ $((j + 1)) -lt "$n" ]; then j=$((j + 1)); fi
              w+="${line:$j:1}"; j=$((j + 1))
            done
            [ "$j" -lt "$n" ] && j=$((j + 1))   # closing quote
          elif [ "$dch" = '\' ] && [ $((j + 1)) -lt "$n" ]; then
            # <<\EOF - a backslash quotes the next character, and quoting any
            # piece quotes the whole delimiter.
            qdelim=1; j=$((j + 1))
            w+="${line:$j:1}"; j=$((j + 1))
          elif [[ "$dch" =~ [A-Za-z0-9_.+-] ]]; then
            w+="$dch"; j=$((j + 1))
          else
            break   # unquoted word boundary ends the delimiter
          fi
        done
        # Quoted delimiter -> inert body, drop it wherever it is. Unquoted ->
        # only where nothing quoted encloses it, i.e. exactly the pre-#400 set.
        if [ -n "$w" ] && { [ "$qdelim" = 1 ] || [ "$outerq" -eq 0 ]; }; then
          dashed=$d; delim="$w"
          break # body starts on the next line
        fi
        i=$((j - 1))
      fi
    done
    printf '%s\n' "$line"
  done <<< "$1"
}

# ---
# Recursively extract and check command substitutions ($(...) and backticks).
# Nested git commands inside substitutions must be inspected — `echo $(git push
# origin main)` would otherwise slip through because the main tokenizer sees
# "echo" as the command. We parse out each substitution body, then apply the
# full heredoc-strip / split / tokenize / check_git_subcommand pipeline to it.
# ---

extract_and_check_substitutions() {
  # NB: ${#1}, NOT ${#s} — bash expands the whole `local` line before any
  # assignment runs, so ${#s} reads the OLD (unset) s and n becomes 0,
  # silently disabling the scan (the bug shipped in #105's original).
  local s="$1" n=${#1} i=0 ch nch depth start body q indq=0

  while [ "$i" -lt "$n" ]; do
    ch="${s:$i:1}"

    # Skip escape sequences (checked first — a backslash hides the next char
    # from every rule below, including the quote toggles)
    if [ "$ch" = '\' ]; then
      i=$((i + 2))
      continue
    fi

    # Double-quote state is load-bearing (#208/#105): inside "…" an apostrophe
    # is ORDINARY TEXT, not a quote delimiter, while $( ) and ` ` still expand.
    # Without this, the first ' in `echo "it's $(git push)"` opened a literal
    # region that ran to the next ' and swallowed the substitution whole — the
    # tokenizer then saw only `echo` and the push was allowed.
    if [ "$ch" = '"' ]; then
      indq=$((1 - indq))
      i=$((i + 1))
      continue
    fi

    # Skip single-quoted regions entirely (substitutions are literal inside),
    # but only where a ' actually opens one
    if [ "$ch" = "'" ] && [ "$indq" -eq 0 ]; then
      i=$((i + 1))
      while [ "$i" -lt "$n" ] && [ "${s:$i:1}" != "'" ]; do
        i=$((i + 1))
      done
      i=$((i + 1))
      continue
    fi

    # Handle $(...) substitutions — executed in double quotes and unquoted
    if [ "$ch" = '$' ]; then
      nch="${s:$((i + 1)):1}"
      if [ "$nch" = '(' ]; then
        i=$((i + 2))
        start=$i
        depth=1
        q=""
        while [ "$i" -lt "$n" ] && [ "$depth" -gt 0 ]; do
          ch="${s:$i:1}"
          if [ -n "$q" ]; then
            # Inside quotes — track quote state to ignore parens
            if [ "$q" = "'" ]; then
              [ "$ch" = "'" ] && q=""
            else  # double quote
              if [ "$ch" = '\' ]; then
                i=$((i + 1))
              elif [ "$ch" = '"' ]; then
                q=""
              fi
            fi
          else
            # Outside quotes — count parens, track quote entry
            case "$ch" in
              \\) i=$((i + 1)) ;;
              "'") q="'" ;;
              '"') q='"' ;;
              '(') depth=$((depth + 1)) ;;
              ')') depth=$((depth - 1)) ;;
            esac
          fi
          [ "$depth" -gt 0 ] && i=$((i + 1))
        done
        body="${s:$start:$((i - start))}"
        i=$((i + 1))
        check_child_string "$body"
        continue
      fi
    fi

    # Handle backtick substitutions
    if [ "$ch" = '`' ]; then
      i=$((i + 1))
      start=$i
      while [ "$i" -lt "$n" ]; do
        ch="${s:$i:1}"
        if [ "$ch" = '\' ]; then
          i=$((i + 2))
          continue
        fi
        if [ "$ch" = '`' ]; then
          break
        fi
        i=$((i + 1))
      done
      body="${s:$start:$((i - start))}"
      i=$((i + 1))
      check_child_string "$body"
      continue
    fi

    i=$((i + 1))
  done
}

# ---
# Push-target parsing (#74): inspect each git sub-command's tokens.
# One blocked sub-command blocks the whole command line (fail-safe).
# ---

check_push() {
  local cpath="$1" gitdir="$2"; shift 2
  local args=("$@")
  local remote="" refspecs=() a i=0 n=${#args[@]}
  while [ "$i" -lt "$n" ]; do
    a="${args[$i]}"
    case "$a" in
      # push modes that inherently sweep in main/master (and --mirror can
      # force-update/delete every remote ref) — never safe, block outright
      --all|--branches|--mirror)
        block "'$a' pushes/rewrites all refs including main/master." ;;
      # --repo IS the remote (git's repository argument) — record it so the
      # following positionals are refspecs, not a remote (#74 review finding 4)
      --repo)
        remote="${args[$((i + 1))]:--}"; i=$((i + 2)) ;;
      --repo=*)
        remote="${a#--repo=}"; [ -z "$remote" ] && remote="-"; i=$((i + 1)) ;;
      # options that consume a following argument
      -o|--push-option|--receive-pack|--exec)
        i=$((i + 2)) ;;
      -*)
        i=$((i + 1)) ;;
      *)
        if [ -z "$remote" ]; then remote="$a"; else refspecs+=("$a"); fi
        i=$((i + 1)) ;;
    esac
  done

  if [ ${#refspecs[@]} -eq 0 ]; then
    # Bare push (at most a remote): the affected repo's current branch decides
    local b
    b=$(effective_branch "$cpath" "$gitdir")
    if is_main_ref "$b"; then
      block "pushes current branch main/master."
    fi
    return 0
  fi

  local rs dst b2
  for rs in "${refspecs[@]}"; do
    rs="${rs#+}"          # +refspec force marker
    dst="${rs##*:}"       # src:dst — destination decides; no colon → the ref itself
    if [ -z "$dst" ] && [ "$rs" != "$dst" ]; then  # empty dst + a colon present
      # ':' is git's MATCHING refspec — pushes every branch that exists on
      # both sides, main included ('+:' force-updates them). An empty dst
      # never equals 'main', so it needs its own gate (#74 review finding 10)
      block "':' (matching refspec) pushes all matching branches including main/master."
    fi
    if [ "$dst" = "HEAD" ] || [ "$dst" = "@" ]; then
      # symbolic ref: 'git push origin HEAD' pushes the CURRENT branch to its
      # same-named remote ref — resolve it instead of matching the literal
      # string (#74 review finding 8)
      b2=$(effective_branch "$cpath" "$gitdir")
      if is_main_ref "$b2"; then
        block "pushes current branch (HEAD) to main/master."
      fi
      continue
    fi
    if is_main_ref "$dst"; then
      block "pushes to main/master (ref '$rs')."
    fi
  done
  return 0
}

# Wrapper binaries that pass execution straight through to git (#74 review
# finding 5); exec replaces the shell with the command (#74 review finding 15)
GIT_WRAPPERS=" command env nice nohup time timeout stdbuf setsid ionice sudo doas exec "

# Shells whose -c argument is a full nested command string, and eval, which
# re-parses its arguments as a command — both must recurse through the whole
# check, not be skipped as opaque words (#74 review finding 14).
SHELL_RUNNERS=" bash sh zsh dash ksh "

# Options of each wrapper that consume a SEPARATE argument — `sudo -u root git
# push` must skip 'root' with the '-u', or the unknown word bails the scan and
# the push escapes (#74 review finding 11). Attached (-uroot) and =-joined
# (--user=root) forms are single '-' tokens and need no entry here.
wrapper_arg_opts() {
  case "$1" in
    env)     echo " -u --unset -C --chdir -S --split-string " ;;
    nice)    echo " -n --adjustment " ;;
    time)    echo " -f --format -o --output " ;;
    timeout) echo " -k --kill-after -s --signal " ;;
    stdbuf)  echo " -i -o -e " ;;
    ionice)  echo " -c -n -p -P -u " ;;
    sudo)    echo " -u -g -p -h -U -C -D -R -T -t -r --user --group --host --prompt --other-user --chdir --chroot --close-from --role --type --command-timeout " ;;  # long separate-arg forms: finding 18
    doas)    echo " -u -C -t " ;;
    exec)    echo " -a " ;;  # separate argv[0] argument (#74 review finding 15)
    *)       echo " " ;;
  esac
}

# ---
# Quote-aware lexing (#74 review finding 6): separators inside quotes are
# data, not command boundaries — `printf "note\ngit push origin main\n"`
# must yield ONE printf command, never a synthetic git push. Tokens keep
# quoted content but drop the quote chars, so `git push origin "main"`
# is seen as pushing main (the old naive split let quoted refs slip).
# ---

# Split at unquoted &&, ||, ;, |, &, and newlines → \x1f-separated string
split_subcommands() {
  local s="$1" out="" q="" ch i n=${#1}
  for ((i = 0; i < n; i++)); do
    ch="${s:$i:1}"
    if [ "$q" = "'" ]; then
      out+="$ch"; [ "$ch" = "'" ] && q=""
    elif [ "$q" = '"' ]; then
      if [ "$ch" = '\' ]; then out+="$ch${s:$((i + 1)):1}"; i=$((i + 1))
      else out+="$ch"; [ "$ch" = '"' ] && q=""; fi
    else
      case "$ch" in
        \\) out+="$ch${s:$((i + 1)):1}"; i=$((i + 1)) ;;
        \'|\") q="$ch"; out+="$ch" ;;
        # '(' / ')' outside quotes open/close a subshell group — split there
        # so `(cd wt && git commit)` exposes both the cd and the commit
        # (#301). `$(…)` bodies were already inspected by the substitution walk.
        # Separators become standalone MARKER entries so the walk can model
        # control flow (PR #305 review round 2): ';' ends a chain, '&&'/'||'
        # make what follows conditional, '|' and a single '&' put the adjacent
        # sub-command in a subshell, '(' / ')' open/close a scope.
        $'\n'|';') out+=$'\x1f;'$'\x1f' ;;
        '('|')') out+=$'\x1f'"$ch"$'\x1f' ;;
        '&'|'|')
          if [ "${s:$((i + 1)):1}" = "$ch" ]; then i=$((i + 1)); out+=$'\x1f&&'$'\x1f'
          else out+=$'\x1f'"$ch"$'\x1f'; fi ;;
        *) out+="$ch" ;;
      esac
    fi
  done
  printf '%s' "$out"
}

# Whitespace-split honoring quotes: quoted content kept, quote chars dropped.
# Fills the global TOKENS array.
tokenize() {
  TOKENS=()
  local s="$1" cur="" q="" ch i n=${#1} quoted=0
  for ((i = 0; i < n; i++)); do
    ch="${s:$i:1}"
    if [ "$q" = "'" ]; then
      if [ "$ch" = "'" ]; then q=""; else cur+="$ch"; fi
    elif [ "$q" = '"' ]; then
      if [ "$ch" = '\' ]; then cur+="${s:$((i + 1)):1}"; i=$((i + 1))
      elif [ "$ch" = '"' ]; then q=""
      else cur+="$ch"; fi
    else
      case "$ch" in
        \\) cur+="${s:$((i + 1)):1}"; i=$((i + 1)) ;;
        \') q="'"; quoted=1 ;;
        \") q='"'; quoted=1 ;;
        ' '|$'\t') if [ -n "$cur" ] || [ "$quoted" = 1 ]; then TOKENS+=("$cur"); cur=""; quoted=0; fi ;;
        *) cur+="$ch" ;;
      esac
    fi
  done
  if [ -n "$cur" ] || [ "$quoted" = 1 ]; then TOKENS+=("$cur"); fi
}

# Index of the real command word in TOKENS, set by skip_benign_prefix.
PREFIX_START=0

# ---
# Skip a benign prefix — wrappers, their -options, VAR=val assignments, bare
# numbers (nice/timeout values) — and stop at the first real command word.
# Sets PREFIX_START and returns 0 when that word is git or gh. Returns 1 when
# the line is not a guarded invocation ('echo git push …' stays text), or when
# it was a nested shell string that has already been re-checked in full.
#
# Shared by the git and gh checks on purpose (#208/#189). It used to live inside
# check_git_subcommand, so check_gh_command matched a raw T[0] and every wrapper
# this function knows about — `sudo gh pr merge`, `env gh pr merge`,
# `GH_HOST=… gh pr merge` — walked straight through the human-only merge gate.
# One parser, two consumers: a wrapper learned here is understood by both.
# ---
skip_benign_prefix() {
  local -a T=("${TOKENS[@]}")
  local i=0 n=${#T[@]} t arg_opts=" " base
  while [ "$i" -lt "$n" ]; do
    t="${T[$i]}"
    base="${t##*/}"
    if [ "$base" = "git" ] || [ "$base" = "gh" ]; then PREFIX_START=$i; return 0; fi
    if [[ "$t" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then i=$((i + 1)); continue; fi
    # Runners and wrappers match by basename like git itself does —
    # /bin/sh and /usr/bin/env are still sh and env (finding 19)
    case "$SHELL_RUNNERS" in *" $base "*)
      # bash -c '<string>' runs a full nested shell command — recurse the
      # whole check on the -c argument (#74 review finding 14). Without -c
      # it's a script-file invocation whose arguments are data.
      local j=$((i + 1)) a
      while [ "$j" -lt "$n" ]; do
        a="${T[$j]}"
        if [ "$a" = "-c" ] || [[ "$a" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]]; then
          if [ $((j + 1)) -lt "$n" ]; then
            check_child_string "${T[$((j + 1))]}"
          fi
          return 1
        fi
        case "$a" in -*) j=$((j + 1)) ;; *) break ;; esac
      done
      return 1 ;;
    esac
    if [ "$t" = "eval" ]; then
      # eval concatenates and re-parses its arguments as a shell command
      check_command_string "${T[*]:$((i + 1))}"
      return 1
    fi
    case "$GIT_WRAPPERS" in *" $base "*)
      arg_opts=$(wrapper_arg_opts "$base"); i=$((i + 1)); continue ;;
    esac
    # option + its separate argument (e.g. sudo -u root) — #74 review finding 11
    case "$arg_opts" in *" $t "*) i=$((i + 2)); continue ;; esac
    case "$t" in -*) i=$((i + 1)); continue ;; esac
    if [[ "$t" =~ ^[0-9]+[A-Za-z]*$ ]]; then i=$((i + 1)); continue; fi
    return 1
  done
  return 1
}

# ---
# Inspect a git invocation. PREFIX_START indexes the 'git' word itself — the
# benign prefix before it has already been consumed by skip_benign_prefix.
# ---
check_git_subcommand() {
  local -a T=("${TOKENS[@]}")
  local n=${#T[@]}
  local i=$((PREFIX_START + 1))

  # git global options before the subcommand; capture -C <path> and
  # --git-dir <path> (both select the affected repo — finding 17)
  local cpath="" gitdir="" worktree=""
  while [ "$i" -lt "$n" ]; do
    case "${T[$i]}" in
      -C)
        # git chains -C options: each relative path resolves from the directory
        # established by the previous one (#74 review finding 9)
        local nxt="${T[$((i + 1))]:-}"
        if [ -n "$cpath" ] && [ "${nxt#/}" = "$nxt" ]; then
          cpath="$cpath/$nxt"
        else
          cpath="$nxt"
        fi
        i=$((i + 2)) ;;
      -c) i=$((i + 2)) ;;
      # --git-dir selects the affected repo (finding 17). --work-tree does not
      # move HEAD, so it never changes which BRANCH a check reads — but it does
      # change which TREE is dirty, and #419 review measured the bypass that
      # follows: `git --work-tree=<dirty> checkout feature && git commit -m x`
      # was allowed while git refused the switch and the commit landed on main.
      # So it is captured, and used for the dirtiness test alone.
      --git-dir) gitdir="${T[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --git-dir=*) gitdir="${T[$i]#--git-dir=}"; i=$((i + 1)) ;;
      --work-tree) worktree="${T[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --work-tree=*) worktree="${T[$i]#--work-tree=}"; i=$((i + 1)) ;;
      --no-pager|-P|--paginate|-p) i=$((i + 1)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  local cmd="${T[$i]:-}"
  i=$((i + 1))

  case "$cmd" in
    push)
      check_push "$cpath" "$gitdir" "${T[@]:$i}"
      ;;
    reset)
      local tok b
      for tok in "${T[@]:$i}"; do
        if [ "$tok" = "--hard" ]; then
          b=$(effective_branch "$cpath" "$gitdir")
          if is_main_ref "$b"; then
            block "hard-resets on main/master."
          fi
        fi
      done
      ;;
    branch)
      # -D is shorthand for --delete --force: split (-d -f), long
      # (--delete --force), and clustered (-df) spellings force-delete just
      # the same — and EVERY positional is a deletion target, not only the
      # token after the flag (#74 review finding 12). Non-force -d stays
      # allowed: it refuses unless merged, so nothing unrecoverable is lost.
      local deleting=0 forcing=0 tok2
      local -a del_targets=()
      for tok2 in "${T[@]:$i}"; do
        case "$tok2" in
          --delete) deleting=1 ;;
          --force) forcing=1 ;;
          --*) ;;
          -?*)
            case "$tok2" in *D*) deleting=1; forcing=1 ;; esac
            case "$tok2" in *d*) deleting=1 ;; esac
            case "$tok2" in *f*) forcing=1 ;; esac
            ;;
          *) del_targets+=("$tok2") ;;
        esac
      done
      if [ "$deleting" = 1 ] && [ "$forcing" = 1 ]; then
        for tok2 in "${del_targets[@]}"; do
          if is_main_ref "$tok2"; then
            block "force-deletes main/master branch."
          fi
        done
      fi
      ;;
    # Always blocked on any branch (discard uncommitted/untracked work).
    # Token-based (#74 review finding 3): whitespace-agnostic, catches the
    # '--' pathspec separator and split flag forms the old literal-space
    # regexes missed — and stops false-blocking dotfile pathspecs like
    # 'git checkout .gitignore' (only the bare '.' token wipes everything).
    checkout|restore)
      local tok3
      for tok3 in "${T[@]:$i}"; do
        if [ "$tok3" = "." ]; then
          block "discards uncommitted work ('git $cmd .', always blocked)."
        fi
      done
      [ "$cmd" = "checkout" ] && apply_lift checkout "$cpath" "$gitdir" "$worktree" "${T[@]:$i}"
      ;;
    switch)
      apply_lift switch "$cpath" "$gitdir" "$worktree" "${T[@]:$i}"
      ;;
    # Commits on main are blocked, not just pushes (#301, btw#21): main
    # advances only through PRs, so every enforced check concentrates on PR
    # review. `git-checkpoint` already refuses on main (#225); this closes the
    # raw-git path. `revert` is here too (#391) — it commits like the rest.
    # --abort/--quit undo (allowed); --ff-only creates no commit
    # (allowed, Duppy 2026-08-16); a plain `pull` is fetch+merge and can commit
    # on a diverged main, so it needs --ff-only. `checkout -b`/`switch -c` are
    # not in this set — the escape from main can never deadlock.
    commit|merge|rebase|cherry-pick|am|pull|revert)
      # Option ARGUMENTS are not options: `git commit -m --abort` is a commit
      # whose message is '--abort' (PR #305 review). Skip the word after any
      # argument-taking option, stop at `--`, and honour --abort/--quit only
      # for the sub-commands that have them.
      local tok6 ffonly=0 b6 skip6=0
      for tok6 in "${T[@]:$i}"; do
        if [ "$skip6" = 1 ]; then skip6=0; continue; fi
        case "$tok6" in
          --) break ;;
          -m|-F|-C|-c|-s|-X|-S|-x|--message|--file|--strategy|--strategy-option|--onto|--exec|--author|--date|--template|--fixup|--squash|--reuse-message|--reedit-message|--gpg-sign|--cleanup|--into-name|--patch-format|--whitespace|--directory|--exclude|--include|--mainline)
            skip6=1 ;;
          --abort|--quit)
            case "$cmd" in merge|rebase|cherry-pick|am|revert) return 0 ;; esac ;;
          --ff-only) ffonly=1 ;;
        esac
      done
      if [ "$ffonly" = 1 ] && { [ "$cmd" = "merge" ] || [ "$cmd" = "pull" ]; }; then
        return 0
      fi
      b6=$(effective_branch "$cpath" "$gitdir")
      if [ "$b6" = "$UNKNOWN_CWD" ]; then
        block "${cmd}s with an UNKNOWN effective cwd — an earlier cd in this line could not be resolved (\$VAR from another call, ~user); use a literal path or run the cd on its own line."
      fi
      if is_main_ref "$b6"; then
        if [ "$cmd" = "pull" ] || [ "$cmd" = "merge" ]; then
          block "${cmd}s on main/master; use --ff-only to sync main, or run 'wt-new <issue#>-<slug>' (or 'git checkout -b') first."
        fi
        block "${cmd}s on main/master; main advances only through PRs (#301) — run 'wt-new <issue#>-<slug>' (or 'git checkout -b') first."
      fi
      ;;
    clean)
      local tok4
      for tok4 in "${T[@]:$i}"; do
        case "$tok4" in
          --force) block "discards untracked files (forced git clean, always blocked)." ;;
          --*) ;;
          -*f*) block "discards untracked files (forced git clean, always blocked)." ;;
        esac
      done
      ;;
    # `worktree remove --force` discards uncommitted/untracked work in the
    # worktree unconditionally — same class as `clean -f` above (#225 gap 2).
    # Scoped to the `remove` subcommand only: `worktree add --force` overrides
    # git's "already checked out elsewhere" refusal, not a data-loss guard, so
    # it stays unblocked. Plain `worktree remove` (no force) also stays
    # allowed — git itself refuses on a dirty tree; that refusal is the
    # existing safeguard (#210's reasoning in pr-cleanup).
    worktree)
      local tok5 wt_removing=0
      for tok5 in "${T[@]:$i}"; do
        [ "$tok5" = "remove" ] && wt_removing=1
      done
      if [ "$wt_removing" = 1 ]; then
        for tok5 in "${T[@]:$i}"; do
          case "$tok5" in
            --force) block "discards uncommitted work (forced git worktree remove, always blocked)." ;;
            --*) ;;
            -*f*) block "discards uncommitted work (forced git worktree remove, always blocked)." ;;
          esac
        done
      fi
      ;;
  esac
  return 0
}

# ---
# Check for dangerous gh (GitHub CLI) commands.
# Separate from git guardrails because gh is not git — but gh pr merge
# is the merge-to-main gate and must stay human-only.
# ---
# gh's GLOBAL options that consume a SEPARATE value (#389). Everything else
# beginning with '-' is a boolean flag or a =-joined pair and consumes only
# itself, so it can be skipped without swallowing the sub-command.
GH_GLOBAL_ARG_OPTIONS=" -R --repo --hostname "

# #389: this used to test positional ADJACENCY (T[s+1] == "pr"), so any global
# gh flag shifted the gate out of view — and `-R owner/repo` is the ordinary way
# an agent addresses a repo it is not standing in. It now collects the first two
# POSITIONAL words after `gh` (cobra accepts flags interleaved anywhere, so
# `gh pr --repo o/r merge` is the same command as `gh -R o/r pr merge`), the way
# skip_benign_prefix already finds the command word past its wrappers.
check_gh_command() {
  local -a T=("${TOKENS[@]}")
  local n=${#T[@]} i=$((PREFIX_START + 1)) t
  local -a words=()
  while [ "$i" -lt "$n" ] && [ ${#words[@]} -lt 2 ]; do
    t="${T[$i]}"
    case "$GH_GLOBAL_ARG_OPTIONS" in *" $t "*) i=$((i + 2)); continue ;; esac
    case "$t" in -?*) i=$((i + 1)); continue ;; esac
    words+=("$t"); i=$((i + 1))
  done
  if [ "${words[0]:-}" = "pr" ] && [ "${words[1]:-}" = "merge" ]; then
    block "gh pr merge is human-only — merge PRs manually via GitHub or a separate shell."
  fi
  return 0
}

# Full check of one command string: strip heredocs, inspect command
# substitutions, quote-aware split, then tokenize each sub-command with
# quotes honored before inspection. This is the recursion point for nested
# command strings (bash -c / eval — #74 review finding 14) and for
# substitution bodies ($(...) and backticks — #105/finding 16b): block()
# exits directly, so any nested hit stops everything.
# One sub-command: line-state changes (assignment, cd, lift) or a check.
check_one_sub() {
  tokenize "$1"
  [ ${#TOKENS[@]} -eq 0 ] && return 0
  record_assignment && return 0   # NAME=value alone: remembered, nothing to block
  apply_cd && return 0            # line-state only, nothing to block (#301)
  # Strip the benign prefix ONCE, then dispatch on what is actually being run.
  # Once matters: the walk recurses into `bash -c` / `eval` bodies, and running
  # it per-checker would re-walk every nested string twice.
  skip_benign_prefix || return 0
  if [ "${TOKENS[$PREFIX_START]##*/}" = "git" ]; then
    check_git_subcommand
  else
    check_gh_command
  fi
  return 0
}

# Walk the split with control flow modelled fail-closed (PR #305 review round 2):
#   ';'        ends a &&/|| chain — state changes made under a condition are
#              REVERTED (`false && git checkout -b x; git commit` is judged on
#              main). The FIRST sub-command of a chain is unconditional, so
#              `cd wt && git commit; git push` keeps its cd.
#   '&&' '||'  everything after the first one in a chain is conditional.
#   '|' '&'    the adjacent sub-command runs in a subshell: its cd/vars/lifts
#              are dropped (`cd x | cat; git commit`).
#   '(' ')'    scope: cwd and vars restored at ')'.
check_command_string() {
  local stripped subs sub
  local -a S=()
  local i n prev next
  local snap_on=0 snap_cwd="" snap_vars="" snap_lifts=""
  local sv_cwd sv_vars sv_lifts
  stripped=$(strip_heredocs "$1")
  extract_and_check_substitutions "$stripped"
  subs=$(split_subcommands "$stripped")
  while IFS= read -r -d $'\x1f' sub || [ -n "$sub" ]; do S+=("$sub"); done <<< "${subs}"$'\x1f'
  n=${#S[@]}
  for ((i = 0; i < n; i++)); do
    sub="${S[$i]}"
    case "$sub" in
      "(") CWD_STACK+=("$HOOK_CWD"); VARS_STACK+=("$LINE_VARS"); continue ;;
      ")")
        if [ ${#CWD_STACK[@]} -gt 0 ]; then
          HOOK_CWD="${CWD_STACK[$((${#CWD_STACK[@]} - 1))]}"; unset 'CWD_STACK[${#CWD_STACK[@]}-1]'
          LINE_VARS="${VARS_STACK[$((${#VARS_STACK[@]} - 1))]}"; unset 'VARS_STACK[${#VARS_STACK[@]}-1]'
        fi
        continue ;;
      ";")
        if [ "$snap_on" = 1 ]; then
          HOOK_CWD="$snap_cwd"; LINE_VARS="$snap_vars"; LIFTS="$snap_lifts"; snap_on=0
        fi
        continue ;;
      "&&")
        if [ "$snap_on" = 0 ]; then
          snap_on=1; snap_cwd="$HOOK_CWD"; snap_vars="$LINE_VARS"; snap_lifts="$LIFTS"
        fi
        continue ;;
      "|"|"&") continue ;;
    esac
    prev="${S[$((i - 1))]:-}"; [ "$i" -eq 0 ] && prev=""
    next="${S[$((i + 1))]:-}"
    if [ "$prev" = "|" ] || [ "$next" = "|" ] || [ "$next" = "&" ]; then
      # pipeline element / background job: a subshell — nothing it sets persists
      sv_cwd="$HOOK_CWD"; sv_vars="$LINE_VARS"; sv_lifts="$LIFTS"
      check_one_sub "$sub"
      HOOK_CWD="$sv_cwd"; LINE_VARS="$sv_vars"; LIFTS="$sv_lifts"
    else
      check_one_sub "$sub"
    fi
  done
  return 0
}

check_command_string "$COMMAND"

exit 0
