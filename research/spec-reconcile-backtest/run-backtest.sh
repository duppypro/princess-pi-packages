#!/usr/bin/env bash
# ---
# Reusable harness for the spec-reconcile backtest (princess-pi-packages#163).
#
# WHY this exists: the spec-reconcile skill's §4 audit prompt is the load-bearing
# artifact — the whole skill lives or dies on whether that wording reaches an
# omission. Prose cannot be regression-tested, so the prompt gets re-run against a
# frozen corpus with known answers instead. Re-run this after ANY edit to the
# skill's §1 (scope) or §4 (prompt) and diff the outcome against RUBRIC.md.
#
# WHY a throwaway `git archive` and not a worktree: the corpus must be immutable and
# must not appear in `git worktree list` (issue #158's worktree-hygiene rules). A tar
# extract into a tmpdir cannot be committed to by accident.
# ---
set -euo pipefail

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUND="${ROUND:-round2-fixed}"

# --- Each round pins its OWN corpus, because a fixture is a tree plus a question and
#     the two cannot be separated. Round 3 (#383, the Tier-4 host-scoped case) needs the
#     tree in which the guardrails hook was already destination-aware and a host document
#     still said otherwise — a different SHA from rounds 1-2. Default stays 9b2a16e so an
#     unqualified run reproduces the #163 record.
if [ -f "$HERE/prompts/$ROUND/FIXTURE_SHA" ]; then
	DEFAULT_SHA="$(tr -d "[:space:]" < "$HERE/prompts/$ROUND/FIXTURE_SHA")"
else
	DEFAULT_SHA="9b2a16e"
fi
FIXTURE_SHA="${FIXTURE_SHA:-$DEFAULT_SHA}"
OUT="${OUT:-$HERE/runs/$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
# --- §4 prescribes the strong model: auditing is judgment work. Downshifting makes a
#     miss un-attributable (weak prompt, or weak model?).
MODEL="${MODEL:-opus}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spec-reconcile-backtest-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "fixture   : $FIXTURE_SHA"
echo "corpus    : $WORK"
echo "output    : $OUT"
echo "round     : $ROUND"
echo "model     : $MODEL"
mkdir -p "$OUT"

git -C "$REPO" archive "$FIXTURE_SHA" | tar -x -C "$WORK"

# --- Host-doc overlay (#383). A Tier-4 fixture lives in NO repository by definition —
#     that is the whole reason spec-reconcile's diff scope cannot reach it — so
#     `git archive` cannot carry it. Stage it beside the corpus at the path the
#     round-3 prompts name. Rounds that do not use it simply ignore the directory.
if [ -d "$HERE/fixtures/host" ]; then
	cp -R "$HERE/fixtures/host" "$WORK/host"
	echo "host doc  : $(ls "$WORK/host" | tr "\n" " ")"
fi

# --- Each auditor is a separate `claude -p` PROCESS, not an in-session subagent.
#     That is the strictest available reading of §4's "no session history": a fresh
#     process cannot inherit the orchestrator's assumptions even accidentally.
for p in "$HERE/prompts/$ROUND"/*.txt; do
	name="$(basename "$p" .txt)"
	echo "--- auditor: $name"
	( cd "$WORK" && timeout 900 claude -p "$(cat "$p")" \
		--model "$MODEL" \
		--allowedTools "Read,Grep,Glob" ) > "$OUT/$name.md" 2>&1 || \
		echo "(auditor $name exited non-zero)" >> "$OUT/$name.md"
done

echo
echo "Score the outputs in $OUT against $HERE/RUBRIC.md."
echo "A missed fixture is a finding about the skill. Fix the skill, not the score."
