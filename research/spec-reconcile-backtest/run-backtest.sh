#!/usr/bin/env bash
# ---
# Reusable harness for the spec-reconcile backtest (princess-pi-packages#163, #383).
#
# WHY this exists: the spec-reconcile skill's §1 (scope) and §4 (audit prompt) are the
# load-bearing artifacts — the whole skill lives or dies on whether that scope reaches
# the artifact and that wording reaches the omission. Prose cannot be regression-tested,
# so both get re-run against frozen corpora with known answers instead. Re-run this after
# ANY edit to §1, §2's Tier 4, or §4, and diff the outcome against RUBRIC.md.
#
# WHY a throwaway `git archive` and not a worktree: the corpus must be immutable and
# must not appear in `git worktree list` (issue #158's worktree-hygiene rules). A tar
# extract into a tmpdir cannot be committed to by accident.
#
# WHY every failure is fatal here (#383 review): a dead auditor emits zero findings, and
# a round scored "the control found nothing" cannot tell that apart from a control that
# ran and found nothing. So a mistyped ROUND, a zero-prompt round, a missing overlay, and
# a non-zero auditor all exit non-zero, and every auditor's exit status is recorded in
# STATUS.tsv beside its transcript.
# ---
set -euo pipefail

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUND="${ROUND:-round2-fixed}"
PROMPT_DIR="$HERE/prompts/$ROUND"

[ -d "$PROMPT_DIR" ] || { echo "no such round: $ROUND (looked in $PROMPT_DIR)" >&2; exit 2; }

# --- Each round pins its OWN corpus, because a fixture is a tree AND a question and the
#     two cannot be separated. Round 3 (#383, the Tier-4 host-scoped case) needs the tree
#     in which the guardrails hook was already destination-aware and a host document still
#     said otherwise — a different SHA from rounds 1-2, which stay on 9b2a16e so an
#     unqualified run reproduces the #163 record.
if [ -f "$PROMPT_DIR/FIXTURE_SHA" ]; then
	DEFAULT_SHA="$(tr -d "[:space:]" < "$PROMPT_DIR/FIXTURE_SHA")"
else
	DEFAULT_SHA="9b2a16e"
fi
FIXTURE_SHA="${FIXTURE_SHA:-$DEFAULT_SHA}"

# --- Default OUT to the round's own directory, which is what RUBRIC.md scores and what
#     tests/spec-163-spec-reconcile.test.ts checks. A timestamped default wrote somewhere
#     nothing read, so following the skill's own instructions left the record untouched.
OUT="${OUT:-$HERE/runs/$ROUND}"
# --- §4 prescribes the strong model: auditing is judgment work. Downshifting makes a
#     miss un-attributable (weak prompt, or weak model?).
MODEL="${MODEL:-opus}"

shopt -s nullglob
PROMPTS=("$PROMPT_DIR"/*.txt)
[ "${#PROMPTS[@]}" -gt 0 ] || { echo "round $ROUND contains no *.txt prompts" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spec-reconcile-backtest-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "fixture   : $FIXTURE_SHA"
echo "corpus    : $WORK"
echo "output    : $OUT"
echo "round     : $ROUND"
echo "auditors  : ${#PROMPTS[@]}"
echo "model     : $MODEL"
mkdir -p "$OUT"

git -C "$REPO" archive "$FIXTURE_SHA" | tar -x -C "$WORK"

# --- Host-doc overlay (#383). A Tier-4 fixture lives in NO repository by definition —
#     that is the whole reason spec-reconcile's diff scope cannot reach it — so
#     `git archive` cannot carry it. Stage it beside the corpus at the path the round's
#     prompts name.
#
#     Gated on a PER-ROUND marker, not on the fixture's existence: rounds 1-2 are compared
#     against the 2026-08-10 record, so their corpus must not grow a directory that run
#     never saw. And when a round asks for the overlay, a missing fixture is fatal — the
#     auditors would truthfully report every host path absent, the harness would exit 0,
#     and the run would be indistinguishable from a real one that found nothing.
if [ -f "$PROMPT_DIR/STAGE_HOST" ]; then
	[ -d "$HERE/fixtures/host" ] || { echo "round $ROUND asks for the host overlay, but $HERE/fixtures/host is missing" >&2; exit 3; }
	[ -e "$WORK/host" ] && { echo "corpus $FIXTURE_SHA already contains host/ — refusing to overlay onto it" >&2; exit 3; }
	mkdir -p "$WORK/host"
	cp -R "$HERE/fixtures/host/." "$WORK/host/"
	echo "host doc  : $(ls "$WORK/host" | tr "\n" " ")"
fi

# --- Each auditor is a separate `claude -p` PROCESS, not an in-session subagent.
#     That is the strictest available reading of §4's "no session history": a fresh
#     process cannot inherit the orchestrator's assumptions even accidentally.
STATUS="$OUT/STATUS.tsv"
printf 'auditor\texit\n' > "$STATUS"
worst=0
for p in "${PROMPTS[@]}"; do
	name="$(basename "$p" .txt)"
	echo "--- auditor: $name"
	rc=0
	( cd "$WORK" && timeout 900 claude -p "$(cat "$p")" \
		--model "$MODEL" \
		--allowedTools "Read,Grep,Glob" ) > "$OUT/$name.md" 2>&1 || rc=$?
	printf '%s\t%s\n' "$name" "$rc" >> "$STATUS"
	if [ "$rc" -ne 0 ]; then
		echo "(auditor $name exited $rc — transcript is NOT a scoreable run)" >> "$OUT/$name.md"
		echo "auditor $name exited $rc" >&2
		worst=1
	fi
done

echo
echo "Per-auditor exit status: $STATUS"
echo "Score the outputs in $OUT against $HERE/RUBRIC.md."
echo "A missed fixture is a finding about the skill. Fix the skill, not the score."
exit "$worst"
