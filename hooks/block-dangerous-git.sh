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
# Heredoc delimiters are general shell WORDs, not identifiers — numeric and
# dashed/dotted names are valid (#74 review finding 13b). And '<<EOF' inside
# quotes is data — the old blind regex entered body mode on it and stripped
# the real commands after, failing open (#74 review finding 13a). Char-scan
# with quote state (persisting across lines, as shell quotes do) and $(( ))
# tracking (a << there is a bit-shift, never a heredoc opener).
strip_heredocs() {
  local line probe delim="" dashed=0 q="" arith=0
  local i n ch j w d
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
        case "${line:$j:1}" in \'|\") j=$((j + 1)) ;; esac
        w=""
        while [ "$j" -lt "$n" ] && [[ "${line:$j:1}" =~ [A-Za-z0-9_.+-] ]]; do
          w+="${line:$j:1}"; j=$((j + 1))
        done
        if [ -n "$w" ]; then
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
  local s="$1" n=${#1} i=0 ch nch depth start body q

  while [ "$i" -lt "$n" ]; do
    ch="${s:$i:1}"

    # Skip single-quoted regions entirely (substitutions are literal inside)
    if [ "$ch" = "'" ]; then
      i=$((i + 1))
      while [ "$i" -lt "$n" ] && [ "${s:$i:1}" != "'" ]; do
        i=$((i + 1))
      done
      i=$((i + 1))
      continue
    fi

    # Skip escape sequences (outside single quotes)
    if [ "$ch" = '\' ]; then
      i=$((i + 2))
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
        check_command_string "$body"
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
      check_command_string "$body"
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
    sudo)    echo " -u -g -p -h -U -C -D -R -T -t -r " ;;
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
    [ "${t##*/}" = "git" ] && break
    if [[ "$t" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then i=$((i + 1)); continue; fi
    case "$SHELL_RUNNERS" in *" $t "*)
      # bash -c '<string>' runs a full nested shell command — recurse the
      # whole check on the -c argument (#74 review finding 14). Without -c
      # it's a script-file invocation whose arguments are data.
      local j=$((i + 1)) a
      while [ "$j" -lt "$n" ]; do
        a="${T[$j]}"
        if [ "$a" = "-c" ] || [[ "$a" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]]; then
          if [ $((j + 1)) -lt "$n" ]; then
            check_command_string "${T[$((j + 1))]}"
          fi
          return 0
        fi
        case "$a" in -*) j=$((j + 1)) ;; *) break ;; esac
      done
      return 0 ;;
    esac
    if [ "$t" = "eval" ]; then
      # eval concatenates and re-parses its arguments as a shell command
      check_command_string "${T[*]:$((i + 1))}"
      return 0
    fi
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

# Full check of one command string: strip heredocs, inspect command
# substitutions, quote-aware split, then tokenize each sub-command with
# quotes honored before inspection. This is the recursion point for nested
# command strings (bash -c / eval — #74 review finding 14) and for
# substitution bodies ($(...) and backticks — #105/finding 16b): block()
# exits directly, so any nested hit stops everything.
check_command_string() {
  local stripped subs sub
  stripped=$(strip_heredocs "$1")
  extract_and_check_substitutions "$stripped"
  subs=$(split_subcommands "$stripped")
  while IFS= read -r -d $'\x1f' sub || [ -n "$sub" ]; do
    tokenize "$sub"
    [ ${#TOKENS[@]} -eq 0 ] && continue
    check_git_subcommand
  done <<< "${subs}"$'\x1f'
  return 0
}

check_command_string "$COMMAND"

exit 0
