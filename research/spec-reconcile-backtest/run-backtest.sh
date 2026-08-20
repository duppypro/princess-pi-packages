#!/usr/bin/env bash
# ---
# Reusable harness for the spec-reconcile backtest (princess-pi-packages#163, #383).
#
# WHY this exists: the spec-reconcile skill's §1 (scope) and §4 (audit prompt) are the
# load-bearing artifacts — the whole skill lives or dies on whether that scope reaches the
# artifact and that wording reaches the omission. Prose cannot be regression-tested, so
# both get re-run against frozen corpora with known answers instead.
#
# WHY a throwaway `git archive` and not a worktree: the corpus must be immutable and must
# not appear in `git worktree list` (#158's worktree-hygiene rules). A tar extract into a
# tmpdir cannot be committed to by accident.
#
# WHY every degradation is fatal (#383 review): a dead auditor emits zero findings, and a
# round scored "the control found nothing" cannot tell that apart from a control that ran
# and found nothing. Every path that used to look like a clean run now exits non-zero.
#
# WHY STATUS.tsv is the authority on whether a directory holds a record: an earlier
# revision decided that by grepping transcripts for a failure marker — which an auditor can
# legitimately quote — and then deleted files. Provenance and per-auditor exit status live
# in STATUS.tsv, and nothing is removed unless that file says the run failed.
#
# usage: run-backtest.sh                      # ROUND defaults to round2-fixed; ONE round per run
#        ROUND=round1-as-written run-backtest.sh
#        ROUND=round3-host-scope OUT=/tmp/scratch run-backtest.sh
#        run-backtest.sh -h | --help
#
# env:
#   ROUND         which prompts/<round>/ to run (default round2-fixed)
#   OUT           where transcripts land (default runs/$ROUND — the TRACKED record)
#   FIXTURE_SHA   must equal the round's own marker unless OVERRIDE_SHA=1
#   OVERWRITE=1   replace a SCORED record in OUT (a failed run is replaced without it)
#   MODEL / REPO  auditor model (default opus) · repo the corpus is archived from
#
# exit codes:
#   0  every auditor exited 0
#   1  at least one auditor exited non-zero, or wrote fewer than 200 bytes — see STATUS.tsv
#   2  usage — no such round, round has no *.txt prompts, round has no/blank FIXTURE_SHA,
#      unknown argument
#   3  corpus — not a git repo, `git archive`/`tar` failed, overlay missing, corpus already
#      carries host/
#   4  refused — OUT already holds a SCORED record; set OVERWRITE=1 or OUT=<path>.
#      A round with transcripts but no STATUS.tsv counts as a record (rounds 1-2 predate it).
#   5  sha — env FIXTURE_SHA contradicts the round's marker; set OVERRIDE_SHA=1
# ---
set -euo pipefail

case "${1:-}" in
	-h|--help) sed -n '/^# usage:/,/^# ---$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//;$d'; exit 0 ;;
	"") ;;
	*) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- The prompts and the corpus must come from the SAME clone. REPO defaulted to the
#     caller's cwd, so running this from another repository archived that repository's tree
#     against these prompts. Derive it from the script's own location instead.
REPO="${REPO:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)}"
[ -n "$REPO" ] || { echo "not inside a git repository (looked from $HERE)" >&2; exit 3; }

ROUND="${ROUND:-round2-fixed}"
PROMPT_DIR="$HERE/prompts/$ROUND"
[ -d "$PROMPT_DIR" ] || { echo "no such round: $ROUND (looked in $PROMPT_DIR)" >&2; exit 2; }

# --- Each round pins its OWN corpus: a fixture is a tree AND a question, and the two cannot
#     be separated. A round whose corpus was guessed would produce a full transcript set, a
#     green STATUS.tsv, and a scoreable-looking result measured on the wrong tree.
[ -f "$PROMPT_DIR/FIXTURE_SHA" ] || { echo "round $ROUND has no prompts/$ROUND/FIXTURE_SHA — a round must declare its own corpus" >&2; exit 2; }
ROUND_SHA="$(tr -d "[:space:]" < "$PROMPT_DIR/FIXTURE_SHA")"
[ -n "$ROUND_SHA" ] || { echo "round $ROUND's FIXTURE_SHA is empty" >&2; exit 2; }

FIXTURE_SHA="${FIXTURE_SHA:-$ROUND_SHA}"
if [ "$FIXTURE_SHA" != "$ROUND_SHA" ] && [ "${OVERRIDE_SHA:-0}" != "1" ]; then
	echo "FIXTURE_SHA=$FIXTURE_SHA contradicts round $ROUND's marker ($ROUND_SHA)." >&2
	echo "A round's prompts are written against its own tree; scoring a foreign one is not a result." >&2
	echo "Set OVERRIDE_SHA=1 if that is genuinely what you want." >&2
	exit 5
fi

OUT="${OUT:-$HERE/runs/$ROUND}"
# --- §4 prescribes the strong model: auditing is judgment work. Downshifting makes a miss
#     un-attributable (weak prompt, or weak model?).
MODEL="${MODEL:-opus}"

shopt -s nullglob
PROMPTS=("$PROMPT_DIR"/*.txt)
# `${#arr[@]}` on an empty array is an unbound-variable error under `set -u` on bash < 4.4
# (macOS ships 3.2), which exits 1 with no message instead of the refusal below.
[ -n "${PROMPTS[0]:-}" ] || { echo "round $ROUND contains no *.txt prompts" >&2; exit 2; }

STATUS="$OUT/STATUS.tsv"

# --- Is OUT a SCORED RECORD, or wreckage? Never decided by transcript text, which an
#     auditor may legitimately quote.
#
#     Two ways to be a record:
#       1. STATUS.tsv is present, has auditor rows, and EVERY row is a clean exit 0.
#       2. There is no STATUS.tsv but there ARE transcripts — a LEGACY record. Rounds 1-2
#          were scored in 2026-08-10, before STATUS.tsv existed, and RUBRIC's result log
#          cites them. An earlier revision of this guard read "no STATUS.tsv" as wreckage,
#          so a bare `run-backtest.sh` (ROUND defaults to round2-fixed) would have DELETED
#          the very transcripts the record depends on — the guard inverted onto exactly
#          what it exists to protect (#383 review).
#
#     Wreckage is therefore the narrow case: a STATUS.tsv that says the run failed, or that
#     is malformed. A row whose exit column is not a plain integer counts as failed — a
#     truncated write must not read as a clean auditor.
holds_record() {
	if [ ! -f "$STATUS" ]; then
		# Legacy record iff transcripts are present.
		local mds=("$OUT"/*.md)
		[ -n "${mds[0]:-}" ] && return 0
		return 1
	fi
	local rows
	rows="$(grep -v '^#' "$STATUS" | tail -n +2 || true)"
	[ -n "$rows" ] || return 1
	printf '%s\n' "$rows" | awk -F'\t' '
		$2 !~ /^[0-9]+$/ { bad = 1 }
		$2 + 0 != 0      { bad = 1 }
		END { exit bad ? 1 : 0 }
	'
}

if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	if holds_record; then
		if [ "${OVERWRITE:-0}" != "1" ]; then
			if [ -f "$STATUS" ]; then
				echo "$OUT already holds a scored record (STATUS.tsv: every auditor exit 0)." >&2
			else
				echo "$OUT holds a legacy scored record (transcripts, no STATUS.tsv — it predates the file)." >&2
			fi
			echo "Set OVERWRITE=1 to replace it, or OUT=<path> to write elsewhere." >&2
			exit 4
		fi
		echo "OVERWRITE=1 — replacing the scored record in $OUT" >&2
	else
		echo "$OUT holds no scored record (missing/failed STATUS.tsv) — replacing it" >&2
	fi
	# Clear first either way: a re-run with renamed or fewer prompts would otherwise leave
	# stale transcripts beside the new ones, with STATUS.tsv describing only the new set.
	# SCORES.tsv too: leaving it behind publishes verdicts for transcripts that no longer
	# exist, which is the same defect one file over.
	rm -f "$OUT"/*.md "$OUT"/STATUS.tsv "$OUT"/SCORES.tsv
fi
mkdir -p "$OUT"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spec-reconcile-backtest-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- An unchecked extraction is a corpus you did not get. Report it as a corpus failure
#     rather than letting tar's own exit code masquerade as this script's "usage".
git -C "$REPO" archive "$FIXTURE_SHA" > "$WORK/corpus.tar" 2> "$WORK/archive.err" \
	|| { echo "git archive $FIXTURE_SHA failed in $REPO:" >&2; cat "$WORK/archive.err" >&2; exit 3; }
tar -x -f "$WORK/corpus.tar" -C "$WORK" \
	|| { echo "tar could not extract the corpus for $FIXTURE_SHA" >&2; exit 3; }
rm -f "$WORK/corpus.tar"

# --- Host-doc overlay (#383). A Tier-4 fixture lives in NO repository by definition — that
#     is the whole reason spec-reconcile's diff scope cannot reach it — so `git archive`
#     cannot carry it. Gated on a PER-ROUND marker, not on the fixture's existence: rounds
#     1-2 are scored against the 2026-08-10 record and their corpus must not grow a
#     directory that run never saw.
HOST_OVERLAY=no
if [ -f "$PROMPT_DIR/STAGE_HOST" ]; then
	[ -d "$HERE/fixtures/host" ] || { echo "round $ROUND asks for the host overlay, but $HERE/fixtures/host is missing" >&2; exit 3; }
	[ -e "$WORK/host" ] && { echo "corpus $FIXTURE_SHA already contains host/ — refusing to overlay onto it" >&2; exit 3; }
	mkdir -p "$WORK/host" || { echo "could not create $WORK/host for the overlay" >&2; exit 3; }
	cp -R "$HERE/fixtures/host/." "$WORK/host/" || { echo "could not stage the host overlay into $WORK/host" >&2; exit 3; }
	HOST_OVERLAY=yes
fi

echo "fixture   : $FIXTURE_SHA"
echo "corpus    : $WORK"
echo "output    : $OUT"
echo "round     : $ROUND"
echo "auditors  : ${#PROMPTS[@]}"
echo "overlay   : $HOST_OVERLAY"
echo "model     : $MODEL"

# --- F5's validity rests on the overlay having been staged, so the transcript set records
#     it alongside the corpus it was measured against.
printf '# round=%s fixture_sha=%s model=%s host_overlay=%s\n' \
	"$ROUND" "$FIXTURE_SHA" "$MODEL" "$HOST_OVERLAY" > "$STATUS"
printf 'auditor\texit\tbytes\n' >> "$STATUS"

# --- Each auditor is a separate `claude -p` PROCESS, not an in-session subagent. That is
#     the strictest available reading of §4's "no session history": a fresh process cannot
#     inherit the orchestrator's assumptions even accidentally.
worst=0
for p in "${PROMPTS[@]}"; do
	name="$(basename "$p" .txt)"
	echo "--- auditor: $name"
	rc=0
	( cd "$WORK" && timeout 900 claude -p "$(cat "$p")" \
		--model "$MODEL" \
		--allowedTools "Read,Grep,Glob" ) > "$OUT/$name.md" 2>&1 || rc=$?
	# If the redirection itself failed there is no file to measure, and `set -e` would
	# abort here — leaving STATUS.tsv holding only the earlier, successful rows, which
	# holds_record would then read as a clean record. Record the failure instead.
	if ! bytes=$(wc -c < "$OUT/$name.md" 2>/dev/null | tr -d '[:space:]'); then
		bytes=0
		rc=1
		echo "auditor $name produced no readable transcript" >&2
	fi
	# An auditor that exits 0 having written nothing is not a clean run with no findings —
	# it is a run that produced no evidence either way.
	if [ "$rc" -eq 0 ] && [ "$bytes" -lt 200 ]; then
		rc=1
		echo "auditor $name exited 0 but wrote only $bytes bytes — not a scoreable transcript" >&2
	fi
	printf '%s\t%s\t%s\n' "$name" "$rc" "$bytes" >> "$STATUS"
	if [ "$rc" -ne 0 ]; then
		echo "auditor $name failed (exit $rc)" >&2
		worst=1
	fi
done

echo
echo "Per-auditor exit status and provenance: $STATUS"
echo "Score the outputs in $OUT against $HERE/RUBRIC.md."
echo "A missed fixture is a finding about the skill. Fix the skill, not the score."
exit "$worst"
