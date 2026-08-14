#!/usr/bin/env bash
# ---
# subagent-statusline.sh — one row per running subagent in the agent panel.
#
# Source:  princess-pi-packages/statusline/subagent-statusline.sh
# Deploy:  bin/install-workflow-tools  →  ~/.claude/subagent-statusline.sh
#
# Edit the REPO copy, never ~/.claude/. Until 2026-08-14 this file was tracked by
# NO repo while settings.json invoked it by path (dotfiles-doctor#17), so a fresh
# host got a statusline command pointing at nothing.
#
# Input shape (undocumented; captured from a live run, 2026-08-13 — the schema
# only says "receives row context as JSON on stdin"):
#
#   { session_id, transcript_path, cwd, prompt_id, columns,
#     tasks: [ { id, type, status, description, label, startTime,
#                model, contextWindowSize, tokenCount, tokenSamples, cwd } ] }
#
# `tasks` is ALWAYS a single-element array here — the panel invokes this once
# per row, not once per render. Verified across 6 captured invocations.
#
# What each field earns its place for:
#
#   model    The routing rule (~/git-projects/CLAUDE.md) requires every dispatch
#            to carry an explicit model, and says plainly that NOTHING enforces
#            it — the route-dispatch hook only advises, and Workflow agent()
#            calls bypass it entirely. A dispatch that silently inherits the
#            flagship model is invisible until the bill arrives. Printing the
#            model per row is the cheapest enforcement available: opus renders
#            as OPUS! so a misrouted mechanical task is obvious at a glance.
#
#   ctx      tokenCount/contextWindowSize. An agent approaching its window is
#            about to degrade or truncate, and you cannot see that from the
#            main status line — which reports the PARENT session only, no
#            matter which conversation you are viewing.
#
#   stall    tokenSamples is a short rolling series. All-identical means the
#            agent has produced nothing across the sampled window: usually
#            waiting on a long tool call, sometimes wedged. Distinguishing
#            "working" from "hung" otherwise means opening the conversation.
#
# Fails soft everywhere. A status line that errors is worse than one that is
# terse: it renders as noise on every redraw and there is no obvious way to
# tell it is the LINE that is broken rather than the agent.
# ---
set -uo pipefail

payload=$(cat)

# jq absent is a real host state (#263 — the installer now warns about exactly
# this). Degrade to something honest rather than emitting a broken row.
if ! command -v jq >/dev/null 2>&1; then
	echo "· (jq missing — no agent detail)"
	exit 0
fi

read -r model tok ctxmax start status label stalled <<<"$(
	printf '%s' "$payload" | jq -r '
		# An absent tasks[0] must be distinguishable from a task with fields
		# missing — the first is "nothing to show", the second is "show what
		# we have". Without the sentinel both collapse to a bare "? 0" row.
		(.tasks[0] // null) as $t
		| if $t == null then ["__none__",0,0,0,"-","-","-"] else
		  [
			($t.model // "?"),
			($t.tokenCount // 0),
			($t.contextWindowSize // 0),
			($t.startTime // 0),
			($t.status // "?"),
			(($t.label // $t.description // "agent") | gsub("[ \t]+"; "_")),
			(
			  ($t.tokenSamples // []) as $s
			  | if ($s | length) >= 3 and (($s | unique | length) == 1)
			    then "stalled" else "-" end
			)
		  ] end
		| @tsv' 2>/dev/null
)" || { echo "· (unreadable row)"; exit 0; }

[ -n "${model:-}" ] || { echo "· (no task data)"; exit 0; }
[ "$model" = "__none__" ] && { echo "· (no task data)"; exit 0; }

# --- model: short name, and a flag when it is the expensive one -------------
# Deliberately loud for opus. The routing rule's failure mode is silent
# inheritance of the flagship model by mechanical work, so the default
# rendering must not be neutral.
case "$model" in
	*opus*)   m="OPUS!" ;;
	*sonnet*) m="sonnet" ;;
	*haiku*)  m="haiku" ;;
	*fable*)  m="FABLE!" ;;
	*)        m="${model#claude-}" ;;
esac

# --- context share ----------------------------------------------------------
pct=""
if [ "${ctxmax:-0}" -gt 0 ] 2>/dev/null; then
	pct=$(( tok * 100 / ctxmax ))
	pct="${pct}%"
fi

# --- elapsed ----------------------------------------------------------------
el=""
if [ "${start:-0}" -gt 0 ] 2>/dev/null; then
	now=$(date +%s%3N)
	secs=$(( (now - start) / 1000 ))
	if [ "$secs" -ge 3600 ]; then el="$(( secs / 3600 ))h$(( (secs % 3600) / 60 ))m"
	elif [ "$secs" -ge 60 ]; then el="$(( secs / 60 ))m$(( secs % 60 ))s"
	else el="${secs}s"; fi
fi

# --- token count, humanised -------------------------------------------------
if [ "${tok:-0}" -ge 1000 ] 2>/dev/null; then
	ktok="$(( tok / 1000 ))k"
else
	ktok="${tok:-0}"
fi

out="$m"
[ -n "$ktok" ] && out="$out ${ktok}"
[ -n "$pct" ] && out="$out/${pct}"
[ -n "$el" ] && out="$out · $el"
[ "$stalled" = "stalled" ] && out="$out · idle"
[ "$status" != "running" ] && [ "$status" != "?" ] && out="$out · $status"

echo "$out"
