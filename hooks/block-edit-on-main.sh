#!/bin/bash
# ---
# Block Edit/Write/MultiEdit when the target file's repo is on main/master.
# PreToolUse hook — matcher must be "Edit|Write|MultiEdit" (NOT Bash, or the
# git-checkout-b escape from main would itself be blocked → deadlock).
#
# Fail-closed on main: the CLAUDE.md HARD GATE says feature work starts on a
# branch. Editing on main leads to lossy stash/checkout-b recovery (ax #3fdda0e7).
#
# Allow when: file is outside any git work tree (e.g. ~/.claude configs), or the
# repo is on a feature branch. Blocks only edits to files inside a repo on main.
# Disable switch: remove the Edit|Write|MultiEdit matcher from settings.json.
# ---
INPUT=$(cat)

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Resolve the directory that holds the target file (relative paths hang off cwd).
if [ -n "$FILE" ]; then
  case "$FILE" in
    /*) DIR=$(dirname "$FILE") ;;
    *)  DIR=$(dirname "${CWD:-.}/$FILE") ;;
  esac
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
