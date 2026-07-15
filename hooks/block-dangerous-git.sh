#!/usr/bin/env bash
# ---
# Block dangerous git commands — branch-aware AND push-target-aware (#70, #74)
#   Always block: checkout ., restore ., clean -f/-fd (discard work, any branch)
#   Block on main/master only: push whose DESTINATION ref is main/master,
#     bare push / reset --hard when the affected repo is on main/master,
#     branch -D main/master.
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
# Cross-harness twin: extensions/git-guardrails.ts — keep logic in sync;
# tests/git-guardrails-parity.test.ts runs the same fixture against both.
# ---

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [ -z "$COMMAND" ]; then
  exit 0
fi
HOOK_CWD=$(echo "$INPUT" | jq -r '.tool_input.cwd // .cwd // ""')

block() {
  echo "BLOCKED: '$COMMAND' — $1" >&2
  exit 2
}

is_main_ref() {
  case "$1" in
    main|master|refs/heads/main|refs/heads/master) return 0 ;;
  esac
  return 1
}

# Branch of the repo the sub-command acts on: -C path wins, else hook cwd (#74 under-block fix).
# A relative -C is what git would see from the TOOL-CALL cwd — resolve it there,
# never against this hook process's own cwd (they differ when the guard runs out-of-repo).
branch_of() {
  local dir="$1"
  if [ -n "$dir" ] && [ "${dir#/}" = "$dir" ] && [ -n "$HOOK_CWD" ]; then
    dir="$HOOK_CWD/$dir"
  fi
  [ -z "$dir" ] && dir="$HOOK_CWD"
  if [ -n "$dir" ]; then
    git -C "$dir" branch --show-current 2>/dev/null || true
  else
    git branch --show-current 2>/dev/null || true
  fi
}

# ---
# Drop heredoc bodies so quoted text like `<<EOF\ngit push origin main\nEOF`
# is never mistaken for a command (#74 false-positive class 3).
# ---
strip_heredocs() {
  local re="<<-?[[:space:]]*['\"]?([A-Za-z_][A-Za-z0-9_]*)"
  local line delim="" in_body=0
  while IFS= read -r line; do
    if [ "$in_body" -eq 1 ]; then
      [ "$line" = "$delim" ] && in_body=0
      continue
    fi
    if [[ "$line" =~ $re ]]; then
      delim="${BASH_REMATCH[1]}"
      in_body=1
    fi
    printf '%s\n' "$line"
  done <<< "$1"
}

STRIPPED=$(strip_heredocs "$COMMAND")

# --- Always-blocked patterns (discard uncommitted work, any branch) ---

ALWAYS_BLOCKED=(
  'git checkout \.'
  'git restore \.'
  'git clean -fd'
  'git clean -f'
)

for pattern in "${ALWAYS_BLOCKED[@]}"; do
  if echo "$STRIPPED" | grep -qE "$pattern"; then
    block "discards uncommitted work (always blocked)."
  fi
done

# ---
# Push-target parsing (#74): inspect each git sub-command's tokens.
# One blocked sub-command blocks the whole command line (fail-safe).
# ---

check_push() {
  local cpath="$1"; shift
  local args=("$@")
  local remote="" refspecs=() a i=0 n=${#args[@]}
  while [ "$i" -lt "$n" ]; do
    a="${args[$i]}"
    case "$a" in
      # options that consume a following argument
      -o|--push-option|--receive-pack|--exec|--repo)
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
    b=$(branch_of "$cpath")
    if is_main_ref "$b"; then
      block "pushes current branch main/master."
    fi
    return 0
  fi

  local rs dst
  for rs in "${refspecs[@]}"; do
    rs="${rs#+}"          # +refspec force marker
    dst="${rs##*:}"       # src:dst — destination decides; no colon → the ref itself
    if is_main_ref "$dst"; then
      block "pushes to main/master (ref '$rs')."
    fi
  done
  return 0
}

check_git_subcommand() {
  local -a T
  read -ra T <<< "$1"
  [ "${T[0]:-}" = "git" ] || return 0

  # git global options before the subcommand; capture -C <path>
  local i=1 cpath="" n=${#T[@]}
  while [ "$i" -lt "$n" ]; do
    case "${T[$i]}" in
      -C) cpath="${T[$((i + 1))]:-}"; i=$((i + 2)) ;;
      -c) i=$((i + 2)) ;;
      --git-dir=*|--work-tree=*|--no-pager|-P|--paginate|-p) i=$((i + 1)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  local cmd="${T[$i]:-}"
  i=$((i + 1))

  case "$cmd" in
    push)
      check_push "$cpath" "${T[@]:$i}"
      ;;
    reset)
      local tok b
      for tok in "${T[@]:$i}"; do
        if [ "$tok" = "--hard" ]; then
          b=$(branch_of "$cpath")
          if is_main_ref "$b"; then
            block "hard-resets on main/master."
          fi
        fi
      done
      ;;
    branch)
      local prev="" tok2
      for tok2 in "${T[@]:$i}"; do
        if [ "$prev" = "-D" ] && is_main_ref "$tok2"; then
          block "deletes main/master branch."
        fi
        prev="$tok2"
      done
      ;;
  esac
  return 0
}

# Split on shell separators (&&, ||, ;, |) and newlines; heredoc bodies already stripped.
SUBS=$(printf '%s' "$STRIPPED" | sed -E 's/(\&\&|\|\||;|\|)/\x1f/g' | tr '\n' '\x1f')
while IFS= read -r -d $'\x1f' sub || [ -n "$sub" ]; do
  # trim leading whitespace so the first-token test works
  sub="${sub#"${sub%%[![:space:]]*}"}"
  [ -z "$sub" ] && continue
  check_git_subcommand "$sub"
done <<< "${SUBS}"$'\x1f'

exit 0
