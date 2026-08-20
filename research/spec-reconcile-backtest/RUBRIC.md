# Scoring rubric — `spec-reconcile` backtest

Corpus SHA: **`9b2a16e`** (`princess-pi-packages` `main`, before #158 landed) for F1–F4.
**F5 pins its own corpus** — `bf4d104`, the commit before #382 landed — because a fixture
is a tree *and* a question, and F5's question did not exist in the older tree. **Every round
declares its SHA in `prompts/<round>/FIXTURE_SHA`** — rounds 1-2 carry `9b2a16e`, round 3
carries `bf4d104`. There is no fallback: a round without the marker is refused (exit 2), as
is an env `FIXTURE_SHA` contradicting it (exit 5).
`tests/spec-163-spec-reconcile.test.ts` asserts both the presence and the value.
Score auditor output in `runs/<round>/` against the five fixtures below.

**The rule: a miss is a finding about the skill, never about the score.** Do not soften a
fixture because an auditor came close. Record which prompt clause or scope rule failed to
reach it, then change the skill.

---

## F1 — stale docstring (false statement)

- **Artifact:** `extensions/lib/wtft-renderer.ts:694-699`, `(---[colored]---◆---)` and
  `@param currentHour … for diamond marker`
- **Contradicted by:** `:735-736` (`CLOCK_FACES`, `☀️` at noon), `:747-748` (moon bookends)
- **Test-covered:** ✅ `tests/wtft-title-layout.test.ts`
- **Counts as surfaced when:** the auditor quotes the `◆` docstring line AND a
  contradicting `path:line` in the renderer.
- **Difficulty:** low. A `◆` grep finds it. If this one misses, something is badly wrong.

## F2 — undocumented accepted input (**omission**)

- **Artifact:** `docs/manifests/wtft-cmd.json:114`, `-i, --interval <size><m|h|d|w>`
- **Contradicted by:** `extensions/lib/wtft-renderer.ts:150-162` — `parseInterval` also
  accepts `<n>t` / `<n>turn` / `<n>turns` (#121)
- **Test-covered:** ✅ `tests/wtft-issue-121.test.ts`
- **Counts as surfaced when:** the auditor names the manifest line AND the turn-unit
  branch. Naming only "the manifest is incomplete" does not count.
- **Difficulty:** high, and the most diagnostic fixture. Nothing in the manifest is
  *false*. Two independent things must hold: **file-level blast radius** (§1) puts the
  renderer in scope even though the branch never edited `parseInterval`, and the
  **"silent on / partial"** clause (§4) makes an omission reportable at all.
- **Do not hand the auditor the manifest as its primary source.** The whole point is that
  it is reached by auditing outward from a file in the blast radius.

## F3 — stale test header (false statement inside a test)

- **Artifact:** `tests/wtft-title-layout.test.ts:10`, `Invariant: the SURGE timeline
  (---◆---) MUST be on the title row`
- **Contradicted by:** `extensions/lib/wtft-renderer.ts:735-748`
- **Test-covered:** ✅ the suite itself (6 failing assertions at the corpus SHA)
- **Counts as surfaced when:** the auditor flags the header line against the **renderer**.
- **Difficulty:** medium, and it is the fixture that catches the *self-audit* failure.
  The header agrees with the file's own assertions at `:130` and `:135` — audited against
  itself, a test file has nothing to contradict. Requires §4's test-file variant, which
  names the production file as the authority.
- **Bonus signal:** a strong auditor also notices `:140` passes **vacuously** (it searches
  rows 2+ for a glyph nothing emits, so it can never fail).

## F4 — control: docstring describing an entirely different function

- **Artifact:** `extensions/lib/wtft-renderer.ts:143-149` — a `.jsonl` file-parser JSDoc
  with `@param filePath`, sitting on `export function parseInterval(val: string)`
- **Contradicted by:** `:150-162` — takes a string, returns `IntervalConfig`, reads no file
- **Test-covered:** ✅ `tests/wtft-issue-121.test.ts` covers the behaviour
- **Not in issue #163's fixture list** — found while verifying the corpus, and *missed by
  #158's hand reconciliation*, which is the argument for having the skill at all.
- **Why it is the control:** F2 is an **omission** about `parseInterval`; F4 is a **false
  statement** about the same symbol. An auditor surfacing F2 but not F4 read the code and
  skipped the prose. One surfacing F4 but not F2 read the prose and skipped the code.
  Scoring both separates those failure modes.

## F5 — host-scoped false claim, reachable by no diff (**Tier 4**, `#383`)

- **Corpus:** `bf4d104` + the staged host doc. Round `round3-host-scope`.
- **Artifact:** `host/git-projects-CLAUDE.md` — the **Git Guardrails (hard block)**
  bullet, frozen verbatim from `~/git-projects/CLAUDE.md` at `2026-08-19T16:01:47Z`:
  *"…intercept: `git push`, `git reset --hard`, `git clean -f`/`-fd`, `git branch -D`,
  `git checkout .`, `git restore .`"*, with the `main`/`master` qualifier attached only to
  the #301 additions that follow.
- **Contradicted by:** `hooks/block-dangerous-git.sh` — push is blocked on **destination**
  (`main`/`master`) since #74, and a bare `push` only while the repo is *on* `main`. Twin:
  `extensions/lib/git-guardrails-core.ts`.
- **Test-covered:** ✅ `tests/doc-claims-vs-hooks.test.ts` (#382), which pins the corrected
  sentence *and* probes both implementations.
- **Counts as surfaced when:** the auditor quotes the host document's `intercept:` sentence
  AND cites the destination check in the hook as `path:line`. Naming the hook's behaviour
  without reaching the host document does **not** count — that is the control's result.
- **Difficulty:** structural, not textual. **What the round controlled for is enumeration, not phrasing.** The two arms differ by one
  block — the paragraph naming the host documents — and by nothing else, so the result
  attributes the hit to *naming the file*. It does **not** establish that no other phrasing
  could ever reach the fixture; no arm tested that, and the fixture is staged in the tree
  for both arms precisely so the difference is enumeration rather than availability. The
  drift is not in the corpus at all: `~/git-projects/` is not a git repository, so the file
  has no commit, no history, and appears in no changeset. Only §1's **reverse scope**
  (branch touches `hooks/` → Tier 4 activates) and §2 Tier 4's **enumerated set** put the
  document in front of an auditor. This is the one fixture that measures a *scope* rule
  with nothing left over for prompt wording to explain.
- **The control is the point, and the manipulation is enumeration only.**
  `C1-guardrails-repo-only-control.txt` and `C2-guardrails-host-scoped.txt` are
  **byte-identical apart from one block**: C2's paragraph naming the host-scoped documents.
  `diff` the two files — if they differ anywhere else, the round is measuring prompt wording
  and not scope, and the result does not stand.
- **Both arms are handed the same corpus, host document included.** `STAGE_HOST` puts
  `./host/` in the tree for the whole round, so C1 *could* read the file and simply is never
  told to. That is the faithful reproduction: on a real host the document is right there, and
  the only thing the skill changes is whether an auditor is pointed at it. C1 is therefore
  "diff-*enumerated*", not "diff-restricted" — do not describe it as an artifact set the file
  was withheld from.
- **What the control must show:** no finding that push is blocked outright, in any tracked
  artifact. Nothing stronger. At `bf4d104` no tracked artifact carried that claim —
  `docs/dev-workflow-spec.md:449` says *"destination-aware, not a flat block list"* — but the
  control is expected to return plenty of *other* drift, and it does. **"Clean" means clean on
  the F5 claim, never clean overall**; the 2026-08-19 control returned 59 scoreable findings, two of
  which were filed as live bugs. A control that returns nothing at all is a dead auditor
  (check `STATUS.tsv`), not a result.
- **Bonus signal:** a strong auditor reports the offending sentence **verbatim**, so the
  correction can be pinned as a claim-table entry (§2 Tier 4) rather than merely reworded.
  Both prompts ask for quoting *generally* (`quote the artifact line`), symmetrically, so
  the signal stays earnable by either arm. What neither may carry is an instruction aimed
  at **this sentence** — an earlier revision of C2 said "report the exact verbatim sentence",
  which made the row un-earnable by the control and therefore worthless. If that goes back
  in, delete this row with it.

---

---

## Non-fixture checks, scored on the same run

| Check | Passes when |
|---|---|
| Output shape | The orchestrator can assemble the §6 five-column table from the output. Auditors return findings, not tables (§6) |
| Coverage honesty | Rows carry a real test name, or `reconciled-against-untested`. Never blank |
| Fix, not report | Every surfaced contradiction ends fixed in-branch or filed as a named issue |
| Glossary | `CONTEXT.md` has `## Language — Serve` and **no wtft section**. The auditor must say so and invent nothing. Applying serve's `_Avoid_` list to wtft is a **fail** — it is inventing a ruling |
| Triage smell | Output grouped "most important first", or a stated word budget, means findings were dropped (§1 granularity) |
| Absence declared (F5, **C2 only**) | `./host/claude-CLAUDE.md` and `./host/claude-settings.json` are deliberately absent from the corpus. The host-scoped auditor must SAY they are missing — the control's prompt never names them, so this row is not scored against it. Silence is a fail — a host check that finds no file and reports nothing is the failure mode `##SKIP##` exists to prevent. The absence is pinned by `tests/spec-163-spec-reconcile.test.ts`, which asserts `fixtures/host/` holds exactly the one expected file; adding either file silently inverts this row |
| Scores are machine-readable (round 3 on) | `runs/<round>/SCORES.tsv` carries the per-arm, per-fixture verdict and the labelled/scoreable counts this file quotes in prose. The test asserts the two agree, so a rescoring cannot drift from the record. Rounds 1-2 predate it |
| Auditor actually ran (round 3 on) | `runs/<round>/STATUS.tsv` shows exit `0` for every auditor, and its `#` header records the round, corpus SHA, model, and whether the host overlay was staged — the fact F5's validity rests on. Rounds 1-2 predate the file and are exempt. A killed or unauthenticated auditor emits zero findings, which scores identically to a clean control. Check this BEFORE reading a transcript as a result |

## Result log

> **Round 3 also paid for itself outside the fixture** — four issues, each **re-probed
> against current `main`** before filing rather than taken from a transcript:
>
> | Issue | What | Which arm found it |
> |---|---|---|
> | **#389** | `gh -R o/r pr merge` walks the human-only gate | **control** (`C1` D3), reproduced in both runs |
> | **#390** | the hook fails *open* when `jq` is unavailable | **the superseded first run only** — see the caveat below |
> | **#391** | `git revert` advances `main` without a PR | **both arms** (`C1` D12, `C2` A15) — not host-scoped |
> | **#392** (banner half) | the hook's banner misquotes the host doc it cites | **host-scoped arm only** (`C2` A16) — one of the two contradicting documents is in no repo |
> | **#392** (spec half) | `dev-workflow-spec.md:337` says nothing hooks `git worktree remove` | **both arms** (`C1` D8, `C2` B1) — an ordinary tracked-artifact drift |
>
> **Caveat, recorded rather than tidied away.** #390 was surfaced by the *first* round-3
> run, whose transcripts the corrected re-run **overwrote** — neither committed transcript
> mentions `jq`. The issue stands on its own re-probe against `main`, not on a transcript
> you can read here. That erasure is why `run-backtest.sh` now refuses to write into a
> non-empty `OUT` (exit 4): a harness that can destroy its own evidence will.

| Round | Prompts | F1 | F2 | F3 | F4 | F5 | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-10 round 1 | `prompts/round1-as-written/` (skill as written during #158) | ❌ A1 / ✅ A2 | ✅ A1, A3 | ❌ all | ✅ A1 | — | 2 of 4 under the skill as written. A2 is a symbol-scope control the skill forbids, so its F1 hit does not count toward the score |
| 2026-08-10 round 2 | `prompts/round2-fixed/` (post-fix) | ✅ B1 | ✅ B1, B3 | ✅ B3 | ✅ B1 | — | 4 of 4. Also surfaced two drifts still live on `main` |
| 2026-08-19 round 3 | `prompts/round3-host-scope/` (Tier 4, #383) | — | — | — | — | ✅ C2 / — C1 | **F5 surfaced by the host-scoped auditor only.** C2 (52 scoreable findings; 53 labelled, one self-declared "not a finding") quotes `host/git-projects-CLAUDE.md:24`'s `intercept: git push` sentence against `block-dangerous-git.sh:477`, measured (`git push origin 42-feat` from `main` → exit 0), and declares both **prompt-named but deliberately absent** host files. C1 — byte-identical prompt minus the enumeration block, **same corpus, host document present on disk** — returned 59 scoreable findings (60 labelled) and **zero mentions of `host/`**: it never opened the file, because nothing pointed it there. `STATUS.tsv`: both arms exit 0 |
