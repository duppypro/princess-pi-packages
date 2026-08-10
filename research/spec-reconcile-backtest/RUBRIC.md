# Scoring rubric — `spec-reconcile` backtest

Corpus SHA: **`9b2a16e`** (`princess-pi-packages` `main`, before #158 landed).
Score auditor output in `runs/<round>/` against the four fixtures below.

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

---

## Non-fixture checks, scored on the same run

| Check | Passes when |
|---|---|
| Output shape | The orchestrator can assemble the §6 five-column table from the output. Auditors return findings, not tables (§6) |
| Coverage honesty | Rows carry a real test name, or `reconciled-against-untested`. Never blank |
| Fix, not report | Every surfaced contradiction ends fixed in-branch or filed as a named issue |
| Glossary | `CONTEXT.md` has `## Language — Serve` and **no wtft section**. The auditor must say so and invent nothing. Applying serve's `_Avoid_` list to wtft is a **fail** — it is inventing a ruling |
| Triage smell | Output grouped "most important first", or a stated word budget, means findings were dropped (§1 granularity) |

## Result log

| Round | Prompts | F1 | F2 | F3 | F4 | Notes |
|---|---|---|---|---|---|---|
| 2026-08-10 round 1 | `prompts/round1-as-written/` (skill as written during #158) | ❌ A1 / ✅ A2 | ✅ A1, A3 | ❌ all | ✅ A1 | 2 of 4 under the skill as written. A2 is a symbol-scope control the skill forbids, so its F1 hit does not count toward the score |
| 2026-08-10 round 2 | `prompts/round2-fixed/` (post-fix) | ✅ B1 | ✅ B1, B3 | ✅ B3 | ✅ B1 | 4 of 4. Also surfaced two drifts still live on `main` |
