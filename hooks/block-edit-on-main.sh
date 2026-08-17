#!/bin/bash
# ---
# Block Edit/Write/MultiEdit when the target file's repo is on main/master.
# PreToolUse hook — matcher must be "Edit|Write|MultiEdit" (NOT Bash, or the
# git-checkout-b escape from main would itself be blocked → deadlock).
#
# Fail-closed on main: the CLAUDE.md HARD GATE says feature work starts on a
# branch. Editing on main leads to lossy stash/checkout-b recovery (ax #3fdda0e7).
#
# Allow when: file is outside any git work tree (e.g. ~/.claude configs); the
# path is inside the git dir itself (.git/config, .git/info/exclude,
# .git/hooks/*, .git/worktrees/* — dotfiles-doctor#15), which is not
# branch-scoped content and so carries none of the hazard above; the repo is on
# a feature branch; or HEAD is detached with a rebase/merge/cherry-pick/revert
# in progress (#272 — resolving conflict markers is the only way forward, and a
# plain detached checkout stays blocked).
# Blocks only edits to WORK-TREE files inside a repo on main.
# Disable switch: remove the Edit|Write|MultiEdit matcher from settings.json.
# ---
INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# realpath_tolerant: mirrors extensions/lib/edit-on-main-core.ts's
# realpathTolerant() — walk the path component by component, resolving each
# symlink found along the way and tolerating components that don't exist yet
# (new-file creation), but cap the WHOLE walk at 40 symlink hops, same as the
# TS twin's SymlinkDepthExceededError budget (#303 review finding, #316).
#
# Why not just `realpath -m` (#267's original choice): -m resolves symlinks
# and tolerates missing components, which is exactly what new-file creation
# needs — but on an actual symlink LOOP (e.g. `ln -s selfLink selfLink`) GNU
# realpath hits ELOOP internally and in -m mode SWALLOWS that error, printing
# the unresolved input path with rc=0. This hook trusted that rc, so an
# unresolvable path was treated as resolved and the edit was ALLOWED — a
# guardrail failing open. Plain `realpath` (no -m) DOES report ELOOP as a
# real failure, but it also refuses any path with a not-yet-existing
# ancestor directory, which breaks new-file creation. Reimplementing the walk
# here (same as the TS twin already does) is what lets both cases be told
# apart: hitting the hop cap while still looking at a symlink is a loop (or a
# chain deep enough this guard cannot prove where it lands either way) → fail
# closed (#210: a check that cannot prove its precondition must refuse).
# Sets RESOLVED_TOLERANT on success; returns 1 (unset) once the cap trips.
realpath_tolerant() {
  local input="$1"
  local -a queue parts
  local part real="/" candidate target hops=0

  IFS='/' read -ra queue <<< "$input"

  while [ "${#queue[@]}" -gt 0 ]; do
    part="${queue[0]}"
    queue=("${queue[@]:1}")
    [ -z "$part" ] && continue
    [ "$part" = "." ] && continue
    if [ "$part" = ".." ]; then
      real=$(dirname "$real")
      continue
    fi
    if [ "$real" = "/" ]; then
      candidate="/$part"
    else
      candidate="$real/$part"
    fi

    if [ ! -L "$candidate" ]; then
      # Not a symlink — either a real node, or missing entirely. Either way
      # it is already resolved as far as it can be; keep walking (a later
      # `..` may still pop back onto an earlier symlink).
      real="$candidate"
      continue
    fi

    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then
      return 1
    fi

    target=$(readlink "$candidate")
    IFS='/' read -ra parts <<< "$target"
    [ "${target:0:1}" = "/" ] && real="/"
    queue=("${parts[@]}" "${queue[@]}")
  done

  RESOLVED_TOLERANT="$real"
  return 0
}

# Resolve the directory that holds the target file (relative paths hang off cwd).
#
# Canonicalize BEFORE taking dirname (#267 finding, macroscopeapp on PR #267):
# `dirname` does not dereference a symlink. A symlink sitting in a feature
# worktree but pointing at a file physically inside a DIFFERENT clone (e.g.
# the main clone this hook exists to protect) used to resolve DIR to the
# worktree — `git -C "$DIR" branch --show-current` then reported the feature
# branch and allowed the edit, while the bytes actually written landed in the
# other clone, on whatever branch IT is on. realpath_tolerant() resolves
# every symlink in the path (including ancestor directories) while still
# tolerating a FILE that doesn't exist yet (new-file creation, handled by the
# nearest-existing-parent walk below), while ALSO failing closed on a
# symlink chain that cannot be resolved within the 40-hop cap (#316).
if [ -n "$FILE" ]; then
  case "$FILE" in
    /*) INPUT_PATH="$FILE" ;;
    *)  INPUT_PATH="${CWD:-.}/$FILE" ;;
  esac
  if ! realpath_tolerant "$INPUT_PATH"; then
    echo "BLOCKED: '$FILE' could not be safely resolved — its symlink chain is longer than 40 hops" >&2
    echo "(possible symlink loop, or a chain deep enough this guard cannot prove where the edit lands)." >&2
    echo "Refusing to edit until the path resolves within the hop limit:" >&2
    echo "  readlink -f '$FILE'" >&2
    echo "(CLAUDE.md HARD GATE / #210 — a check that cannot prove its precondition must refuse.)" >&2
    exit 2
  fi
  RESOLVED="$RESOLVED_TOLERANT"
  DIR=$(dirname "$RESOLVED")
else
  DIR="${CWD:-.}"
fi

# Writing a NEW file means $DIR may not exist yet — and `git -C <missing>` fails,
# which the old code read as "not a repo" and allowed. That let `new/subdir/f.txt`
# be created in a repo sitting on main, bypassing the gate entirely. Walk up to
# the nearest existing parent before asking git anything.
while [ ! -d "$DIR" ] && [ "$DIR" != "/" ] && [ -n "$DIR" ]; do
  DIR=$(dirname "$DIR")
done

# Inside the git dir itself (.git/config, .git/info/exclude, .git/hooks/*,
# .git/worktrees/*) → allow. Ported from dotfiles-doctor#15 under ADR 0001,
# which makes this repo the single source for this hook; the fix existed only
# in that repo's copy and was running on no host (#227, dotfiles-doctor#18).
#
# Nothing under .git/ lives in a branch, so the stash/checkout hazard this hook
# exists for cannot reach it. Blocking it was also unfollowable advice:
# branching does not move .git/config into a branch, it only changes what
# `git branch --show-current` reports — so the gate could be cleared without
# addressing anything it guards.
#
# Asked as a PATH question via git, not a string match on the filename. A match
# like `*/.git*` would also exempt .gitignore, .gitattributes, .gitmodules and
# .github/ — tracked WORK-TREE files that MUST stay gated (pinned as the
# lookalike cases in tests/hooks-deploy-drift.test.ts §5b).
[ "$(git -C "$DIR" rev-parse --is-inside-git-dir 2>/dev/null)" = true ] && exit 0

# Not inside a git work tree → not gated (e.g. ~/.claude/*.md). Allow.
#
# Tests the OUTPUT, not the exit status (dotfiles-doctor#15): run inside .git/
# this command SUCCEEDS and prints `false`, so the old `|| exit 0` never fired
# there and every .git/ path fell through to the branch check below — which is
# how the exemption above stayed necessary. Outside a repo the command fails and
# prints nothing, which is `!= true` either way, so this stays correct for the
# not-a-repo case too.
[ "$(git -C "$DIR" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 0

BRANCH=$(git -C "$DIR" branch --show-current 2>/dev/null)

# Detached HEAD is TWO states, and only one of them is dangerous (#272):
#
#   reached by `git checkout <sha>`  → editing IS hazardous. Edit, walk away,
#                                      and the work is unreferenced. The guard
#                                      is right, and this stays blocked.
#   mid-rebase / merge / cherry-pick → git detached HEAD itself, and the files
#                                      needing edits are the conflict markers
#                                      git just wrote. Resolving them is the
#                                      only way forward.
#
# Blocking the second case made the tool unusable for an entire rebase (5
# conflicts across 2 commits when this was found, rebasing a FEATURE branch
# onto main — not main work at all), and the advice it printed was
# unfollowable: you cannot `git checkout -b` mid-rebase. Its practical effect
# was not "prevented a dangerous edit" but "moved the edit into a shell
# heredoc" — the #225 gap-3 opaque-script bypass — with no record that a
# guarded file was touched. A guard that is trivially and legitimately routed
# around teaches routing around guards.
#
# Scoped to detached HEAD deliberately. A conflicted merge raised ON main keeps
# a branch name, so it never reaches here and stays blocked: exempting "any
# operation in progress" would punch a hole straight through the main gate, and
# `merge` on main is a state the workflow does not produce anyway ("never merge
# locally").
#
# The git dir is resolved by ASKING git, not by assuming `<toplevel>/.git` is a
# directory. In a linked worktree — the layout the workflow has used since #257
# — `.git` is a FILE and this state lives in `<main>/.git/worktrees/<name>/`. A
# fix that hardcodes the toplevel passes every other case here and fails in the
# only layout that matters.
if [ -z "$BRANCH" ]; then
  GIT_DIR=$(git -C "$DIR" rev-parse --absolute-git-dir 2>/dev/null)
  if [ -n "$GIT_DIR" ] && { [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ] || \
       [ -f "$GIT_DIR/MERGE_HEAD" ] || [ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] || [ -f "$GIT_DIR/REVERT_HEAD" ]; }; then
    exit 0
  fi
fi

# An empty BRANCH means detached HEAD — which `git branch --show-current`
# reports for a HEAD sitting directly on the main/master commit, so matching
# only the two names let mainline edits through. Fail closed: no identifiable
# branch is not a licence to edit.
if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "BLOCKED: '$FILE' is in a repo on '${BRANCH:-detached HEAD}'. Start feature/fix work on a branch first:" >&2
  echo "  git checkout -b <issue#>-<slug>" >&2
  echo "(CLAUDE.md HARD GATE — editing on main risks lossy stash/checkout recovery.)" >&2
  exit 2
fi

exit 0
