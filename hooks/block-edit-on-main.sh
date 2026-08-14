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
# repo is on a feature branch; or HEAD is detached with a rebase/merge/
# cherry-pick/revert in progress (#272 — resolving conflict markers is the only
# way forward, and a plain detached checkout stays blocked).
# Blocks only edits to files inside a repo on main.
# Disable switch: remove the Edit|Write|MultiEdit matcher from settings.json.
# ---
INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Resolve the directory that holds the target file (relative paths hang off cwd).
#
# Canonicalize BEFORE taking dirname (#267 finding, macroscopeapp on PR #267):
# `dirname` does not dereference a symlink. A symlink sitting in a feature
# worktree but pointing at a file physically inside a DIFFERENT clone (e.g.
# the main clone this hook exists to protect) used to resolve DIR to the
# worktree — `git -C "$DIR" branch --show-current` then reported the feature
# branch and allowed the edit, while the bytes actually written landed in the
# other clone, on whatever branch IT is on. `realpath -m` resolves every
# symlink in the path (including ancestor directories) while still tolerating
# a FILE that doesn't exist yet (new-file creation, handled by the
# nearest-existing-parent walk below) — a plain `realpath` would error on that
# case instead of normalizing it.
if [ -n "$FILE" ]; then
  case "$FILE" in
    /*) RESOLVED=$(realpath -m "$FILE") ;;
    *)  RESOLVED=$(realpath -m "${CWD:-.}/$FILE") ;;
  esac
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

# Not inside a git work tree → not gated (e.g. ~/.claude/*.md). Allow.
git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

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
