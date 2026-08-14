#!/usr/bin/env bash
# ---
# Princess-Pi status line: model + cwd + git branch + session token spend + $ cost spend.
# Reads the JSON Claude Code pipes to stdin (see statusline docs for schema).
#
# Source:  princess-pi-packages/statusline/statusline-command.sh
# Deploy:  bin/install-workflow-tools  →  ~/.claude/statusline-command.sh
#
# Edit the REPO copy, never ~/.claude/. A fix authored in a copy that looks like
# the owner but deploys nowhere is the exact failure ADR 0001 exists to stop —
# dotfiles-doctor#15 sat in the wrong repo for a day and ran on no host.
# ---

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "?"')
dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "?"')
cwd_label=$(basename "$dir")

# --- Git branch (when inside a repo) — resolved against the session dir, not the
#     script's own cwd, so it stays correct regardless of where the command runs. ---
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$branch" ]; then
  branch_str=" | ⎇ $branch"
else
  branch_str=""
fi

# --- Token usage: prefer context_window totals (input+output currently in context) ---
in_tok=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
out_tok=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
total_tok=$((in_tok + out_tok))

# Format token count compactly (e.g. 1.2k, 45k)
#
# awk, not `bc` (PR #278 review, reproduced): `bc` is not installed by default
# on Debian/Ubuntu, and its absence failed in the worst available way — the
# command substitution came back empty, `printf "%.1fk" ""` rendered a
# confident **0.0k**, and the only hint was a `bc: command not found` on stderr
# that nothing displays. A status line reporting zero tokens for a session
# spending them is worse than one reporting nothing at all.
#
# awk costs nothing to adopt: this script already uses it 20 lines down for the
# context-bar percentage, so `bc` was the file's one single-use dependency and
# is now gone entirely. jq remains the only hard dependency, and it is the one
# `install-workflow-tools` already warns about by name.
fmt_tokens() {
  local n=$1
  if [ "$n" -ge 1000 ]; then
    awk "BEGIN {printf \"%.1fk\", $n / 1000}"
  else
    printf "%d" "$n"
  fi
}
tok_str=$(fmt_tokens "$total_tok")

# --- Dollar cost: Claude Code provides cost.total_cost_usd for the session ---
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
if [ -n "$cost" ]; then
  cost_str=$(printf "\$%.2f" "$cost")
else
  cost_str="\$?"
fi

# --- Context window bar graph: [####....] XX% used ---
remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
if [ -n "$remaining" ]; then
  used_pct=$(awk "BEGIN {printf \"%.0f\", 100 - $remaining}")
  filled=$(( (used_pct * 8 + 99) / 100 ))
  (( filled > 8 )) && filled=8
  empty=$(( 8 - filled ))
  bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}#"; done
  for ((i=0; i<empty; i++)); do bar="${bar}."; done
  ctx_str=$(printf " | [%s] %s%%" "$bar" "$used_pct")
else
  ctx_str=""
fi

# --- Session tag: last 4 chars of the transcript's session id, e.g. `...c1ae`.
#     Taken from the transcript filename (<session-id>.jsonl) rather than .session_id
#     so the tag matches what you would grep for on disk; falls back to .session_id if
#     the harness ever stops sending a path. Four chars is enough to tell two open
#     sessions apart, which is the whole job — it is not meant to be a unique key. ---
transcript=$(echo "$input" | jq -r '.transcript_path // empty')
if [ -n "$transcript" ]; then
  sid=$(basename "$transcript" .jsonl)
else
  sid=$(echo "$input" | jq -r '.session_id // empty')
fi
if [ -n "$sid" ]; then
  sid_str=$(printf " | ...%s" "${sid: -4}")
else
  sid_str=""
fi

# Dim color (works against dark/dim terminal status line rendering)
printf "\033[2m%s | %s%s | %s tok | %s%s%s\033[0m" \
  "$model" "$cwd_label" "$branch_str" "$tok_str" "$cost_str" "$ctx_str" "$sid_str"

# --- Audit log: one JSONL record per *change* in Claude Code's own cost/token
#     numbers, at ~/.claude/statusline-logs/<session-id>.jsonl.
#
#     Why: `.cost.total_cost_usd` is computed inside Claude Code and written
#     nowhere on disk — the status line is the only place it surfaces. Without a
#     log there is no way to reconcile it against `wtft`, which derives cost from
#     the transcript (princess-pi-packages#149), and no history to audit later.
#
#     Why dedup on cost+tokens only: the payload also carries duration counters
#     that tick on every render, so logging whole-payload changes would append
#     several records per second. Keying on the numbers we actually care about
#     turns the log into an event stream of real updates.
#
#     Runs *after* the status line is printed, and every step is best-effort:
#     a full disk, an unwritable dir, or a jq failure must never break rendering
#     or emit noise into the status line. ---
log_statusline_update() {
  local log_dir="$HOME/.claude/statusline-logs"
  mkdir -p "$log_dir" 2>/dev/null || return 0

  local key="${sid:-unknown}"
  local log_file="$log_dir/$key.jsonl"
  local sig_file="$log_dir/.$key.sig"

  # Signature of the values worth recording. Nulls are preserved (rather than
  # defaulted) so "field absent" stays distinguishable from "field is zero".
  local sig
  sig=$(echo "$input" | jq -c '[
    .cost.total_cost_usd,
    .context_window.total_input_tokens,
    .context_window.total_output_tokens,
    .context_window.remaining_percentage
  ]' 2>/dev/null) || return 0
  [ -z "$sig" ] && return 0
  [ -f "$sig_file" ] && [ "$sig" = "$(cat "$sig_file" 2>/dev/null)" ] && return 0

  # Whole payload, not a hand-picked subset: the schema will grow, and an audit
  # a year from now should not be limited to the fields that mattered today.
  # _epoch_ms is the join key against transcript/wtft-tag timestamps; _ts is for
  # humans reading the log directly.
  local ts epoch_ms
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  epoch_ms=$(date -u +%s%3N)
  echo "$input" \
    | jq -c --arg ts "$ts" --argjson ms "${epoch_ms:-0}" --arg sid "$key" \
        '{_ts: $ts, _epoch_ms: $ms, _session: $sid} + .' \
        >> "$log_file" 2>/dev/null \
    || return 0

  printf '%s' "$sig" > "$sig_file" 2>/dev/null || true
}
log_statusline_update 2>/dev/null || true
