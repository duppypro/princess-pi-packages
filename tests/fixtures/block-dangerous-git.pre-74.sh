#!/bin/bash
# Block dangerous git commands, branch-aware:
#   Always block: checkout ., restore ., clean -f (discard work, any branch)
#   Block on main/master only: push to main, reset --hard on main, branch -D main

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# --- Helpers ---

current_branch() {
  # Extract cwd from the hook input to run git in the right directory
  local cwd
  cwd=$(echo "$INPUT" | jq -r '.tool_input.cwd // .cwd // ""')
  if [ -n "$cwd" ]; then
    git -C "$cwd" branch --show-current 2>/dev/null || true
  else
    git branch --show-current 2>/dev/null || true
  fi
}

is_main() {
  local branch="$1"
  [ "$branch" = "main" ] || [ "$branch" = "master" ]
}

# --- Always-blocked patterns (discard uncommitted work) ---

ALWAYS_BLOCKED=(
  'git checkout \.'
  'git restore \.'
  'git clean -fd'
  'git clean -f'
)

for pattern in "${ALWAYS_BLOCKED[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' discards uncommitted work (always blocked)." >&2
    exit 2
  fi
done

# --- Branch-aware: git push ---

if echo "$COMMAND" | grep -qE '\bgit push\b'; then
  # Explicit push to main/master
  if echo "$COMMAND" | grep -qE 'push\s+.*\b(main|master)\b'; then
    echo "BLOCKED: '$COMMAND' pushes to main/master." >&2
    exit 2
  fi
  # Explicit --force push to any branch (still dangerous, check context)
  if echo "$COMMAND" | grep -qE '\bgit push\b.*(--force|-f)\b'; then
    # Check if pushing to main (explicit or via current branch)
    if echo "$COMMAND" | grep -qE '(--force|-f)\s+.*\b(main|master)\b' || \
       echo "$COMMAND" | grep -qE '\b(main|master)\b.*(--force|-f)\b'; then
      echo "BLOCKED: '$COMMAND' force-pushes to main/master." >&2
      exit 2
    fi
    # Force push to feature branch with no explicit remote branch — check current
    local_branch=$(current_branch)
    if is_main "$local_branch"; then
      echo "BLOCKED: '$COMMAND' force-pushes to main/master (current branch)." >&2
      exit 2
    fi
  fi
  # Bare 'git push' — check current branch
  if ! echo "$COMMAND" | grep -qE 'push\s+\S+\s+\S+'; then
    local_branch=$(current_branch)
    if is_main "$local_branch"; then
      echo "BLOCKED: '$COMMAND' pushes to main/master (current branch)." >&2
      exit 2
    fi
  fi
fi

# --- Branch-aware: git reset --hard ---

if echo "$COMMAND" | grep -qE '\bgit reset --hard\b'; then
  local_branch=$(current_branch)
  if is_main "$local_branch"; then
    echo "BLOCKED: '$COMMAND' hard-resets on main/master." >&2
    exit 2
  fi
fi

# --- Branch-aware: git branch -D ---

if echo "$COMMAND" | grep -qE '\bgit branch -D\b'; then
  if echo "$COMMAND" | grep -qE 'branch -D\s+(main|master)\b'; then
    echo "BLOCKED: '$COMMAND' deletes main/master branch." >&2
    exit 2
  fi
fi

exit 0
