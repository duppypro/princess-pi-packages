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

FIXTURE_SHA="${FIXTURE_SHA:-9b2a16e}"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/runs/$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
# --- §4 prescribes the strong model: auditing is judgment work. Downshifting makes a
#     miss un-attributable (weak prompt, or weak model?).
MODEL="${MODEL:-opus}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spec-reconcile-backtest-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "fixture   : $FIXTURE_SHA"
echo "corpus    : $WORK"
echo "output    : $OUT"
echo "model     : $MODEL"
mkdir -p "$OUT"

git -C "$REPO" archive "$FIXTURE_SHA" | tar -x -C "$WORK"

# --- Each auditor is a separate `claude -p` PROCESS, not an in-session subagent.
#     That is the strictest available reading of §4's "no session history": a fresh
#     process cannot inherit the orchestrator's assumptions even accidentally.
ROUND="${ROUND:-round2-fixed}"
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
