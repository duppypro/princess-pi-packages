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
  local re="<<(-?)[[:space:]]*['\"]?([A-Za-z_][A-Za-z0-9_]*)"
  local line probe delim="" in_body=0 dashed=0
  while IFS= read -r line; do
    if [ "$in_body" -eq 1 ]; then
      # <<- : terminator may be tab-indented (#74 review finding 7)
      probe="$line"
      if [ "$dashed" -eq 1 ]; then
        probe="${probe#"${probe%%[!$'\t']*}"}"
      fi
      [ "$probe" = "$delim" ] && in_body=0
      continue
    fi
    if [[ "$line" =~ $re ]]; then
      [ "${BASH_REMATCH[1]}" = "-" ] && dashed=1 || dashed=0
      delim="${BASH_REMATCH[2]}"
      in_body=1
    fi
    printf '%s\n' "$line"
  done <<< "$1"
}

STRIPPED=$(strip_heredocs "$COMMAND")

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
    b=$(branch_of "$cpath")
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
      b2=$(branch_of "$cpath")
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

# Wrapper binaries that pass execution straight through to git (#74 review finding 5)
GIT_WRAPPERS=" command env nice nohup time timeout stdbuf setsid ionice sudo doas "

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
    sudo)    echo " -u -g -p -h -U -C -D -R -T -t -r " ;;
    doas)    echo " -u -C -t " ;;
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
        $'\n'|';') out+=$'\x1f' ;;
        '&'|'|') [ "${s:$((i + 1)):1}" = "$ch" ] && i=$((i + 1)); out+=$'\x1f' ;;
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

check_git_subcommand() {
  local -a T=("${TOKENS[@]}")

  # Skip a benign prefix — wrappers, their -options, VAR=val assignments,
  # bare numbers (nice/timeout values) — until 'git'. Anything else means
  # this is not a git invocation ('echo git push …' stays text).
  local i=0 n=${#T[@]} t arg_opts=" "
  while [ "$i" -lt "$n" ]; do
    t="${T[$i]}"
    [ "$t" = "git" ] && break
    if [[ "$t" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then i=$((i + 1)); continue; fi
    case "$GIT_WRAPPERS" in *" $t "*)
      arg_opts=$(wrapper_arg_opts "$t"); i=$((i + 1)); continue ;;
    esac
    # option + its separate argument (e.g. sudo -u root) — #74 review finding 11
    case "$arg_opts" in *" $t "*) i=$((i + 2)); continue ;; esac
    case "$t" in -*) i=$((i + 1)); continue ;; esac
    if [[ "$t" =~ ^[0-9]+[A-Za-z]*$ ]]; then i=$((i + 1)); continue; fi
    return 0
  done
  [ "$i" -lt "$n" ] || return 0
  i=$((i + 1))

  # git global options before the subcommand; capture -C <path>
  local cpath=""
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
  esac
  return 0
}

# Quote-aware split (heredoc bodies already stripped), then tokenize each
# sub-command with quotes honored before inspection.
SUBS=$(split_subcommands "$STRIPPED")
while IFS= read -r -d $'\x1f' sub || [ -n "$sub" ]; do
  tokenize "$sub"
  [ ${#TOKENS[@]} -eq 0 ] && continue
  check_git_subcommand
done <<< "${SUBS}"$'\x1f'

exit 0
