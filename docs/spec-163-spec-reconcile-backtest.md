# Spec 163 — Backtesting `spec-reconcile`: does the skill find the drift it was written from?

**Issue:** #163
**Branch:** `163-backtest-spec-reconcile`
**Base:** `main` @ `ad91cdc`
**Fixture SHA:** `9b2a16e` (`main` before the #158 work landed)
**State:** Spec Draft (2026-08-10)

---

## 1. The problem

`~/.claude/skills/spec-reconcile/SKILL.md` was written during #158, from a reconciliation
that a human-plus-agent pass had already done by hand. It has **never been executed.** Its
own §7 says so and names the backtest.

That ordering is the risk. The skill was generalised *from* an answer sheet, so every
sentence in it reads as obviously right — of course it would have found those drifts, it
was written while looking at them. A skill in that state has exactly one failure mode worth
worrying about, and it is not "it is wrong":

> A skill that sounds rigorous and finds nothing is worse than no skill.

Worse, because `merge-checklist` already treats "spec reconciled" as a gate. A skill that
runs, produces a confident empty table, and satisfies that gate converts an unknown into a
false negative. The unreviewed state is honest; the confidently-empty state is not.

So this issue is not "document the skill" or "improve the skill". It is: **run it against
drift with known answers and see whether it comes back with them.**

## 2. The fixture corpus — verified here, not taken from the issue text

Issues go stale. Every fixture below was re-verified against a throwaway `git archive` of
`9b2a16e` before this spec was written. Line numbers are from that tree.

Materialise it with:

```
git archive 9b2a16e | tar -x -C <tmpdir>
```

### F1 — stale docstring, a **false statement** (issue's fixture 1)

`extensions/lib/wtft-renderer.ts:694-699`:

```
/**
 * Build a 24-hour surge timeline string in the format:
 * (---[colored]---◆---) [⚡ SURGE 2x] [⚡ SURGE APPROACHING]
 *
 * @param surgeHours - Set of local hours (0-23) that are surge-priced
 * @param currentHour - Current local hour (0-23) for diamond marker
 */
```

Contradicted at `:735-736` and `:747-748` of the same file — the only `◆` left in the file
is on line 695, inside that docstring:

```ts
const CLOCK_FACES = ["🕛","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚"];
const char = (isCurrent && h !== 12) ? CLOCK_FACES[h % 12] : (h === 12 ? "☀️" : "─");
...
const moon = getMoonPhase(date ?? new Date());
let result = `${moon}${timelineBody}${moon}`;
```

Difficulty: **low.** A grep for `◆` finds it. This fixture mostly tests that the auditor
reads docstrings at all.

### F2 — undocumented accepted input, an **omission** (issue's fixture 2)

`docs/manifests/wtft-cmd.json:114`:

```json
"flags": "-i, --interval <size><m|h|d|w>",
"desc": "Group cost data into arbitrary binned intervals of minutes, hours, days, or weeks (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h)."
```

Contradicted by `parseInterval` at `extensions/lib/wtft-renderer.ts:150-162`:

```ts
const turnMatch = /^(\d+)(?:t|turns?)$/.exec(val);
if (turnMatch) {
    const size = parseInt(turnMatch[1], 10);
    if (size > 0) return { size, unit: "t", type: "turns" };
}
```

The manifest contains exactly **one** occurrence of the substring `turn` in the whole file,
and it is `"every turn's cost"` in the tool description — nothing about the interval unit.
Covered by `tests/wtft-issue-121.test.ts` (#121). Because `docs/EXT_WTFT.html:317` renders
this same manifest via `fetch('manifests/wtft-cmd.json')`, the extension doc inherits the
gap — Tier 1 in the skill's own taxonomy.

Difficulty: **high, and it is the diagnostic one.** Two independent things must both hold
for an auditor to reach it:

1. **File-level blast radius (§1).** `parseInterval` sits in a file the #158 branch touched
   but is not a symbol #158 edited. Symbol-level scoping never looks at it.
2. **"Silent on / partial" in the audit prompt (§4).** Nothing in the manifest is *false*.
   An auditor hunting for wrong sentences finds nothing here. It has to reason from the
   code outward — *this input is accepted; is it documented anywhere?*

### F3 — stale test header comment, invariant its own assertions abandoned (issue's fixture 3)

`tests/wtft-title-layout.test.ts:10-11`:

```
 *   Invariant: the SURGE timeline (---◆---) MUST be on the title row,
 *   never on its own row. Legend goes to its own row when too wide.
```

The file's own assertions at `:130` and `:135` still check `includes("◆")`, and those are
the six failures RC-4b of spec-158 diagnosed. Difficulty: **medium** — it needs the auditor
to treat a *test file* as a readable artifact rather than as code.

### F4 — control fixture, found while verifying the corpus (not in the issue)

`extensions/lib/wtft-renderer.ts:143-149`, immediately above `parseInterval`:

```
/**
 * Parse a .jsonl session file into raw (undeduped) interactions.
 * Caller is responsible for deduplication via {@link deduplicateInteractions}.
 *
 * @param filePath - Absolute path to the .jsonl session log
 * @returns Array of parsed interactions (may contain duplicate message.id entries)
 */
export function parseInterval(val: string): IntervalConfig {
```

The docstring describes a **different function entirely.** `parseInterval` takes a string
`val` and returns an `IntervalConfig`; it has no `filePath`, reads no file, and returns no
interactions. This is the most blatant class of contradiction in the corpus and the #158
hand-run missed it — which is itself the argument for the skill.

F4 is kept as a **control**: it is a false statement about the *same symbol* F2 concerns.
An auditor that surfaces F2 but not F4 read the code and skipped the prose; one that
surfaces F4 but not F2 read the prose and skipped the code. Scoring both separates those.

### Corpus summary

| # | Artifact | Class | Reachable only via | In issue? |
|---|---|---|---|---|
| F1 | `wtft-renderer.ts:695` docstring | false statement | any reading | ✅ |
| F2 | `docs/manifests/wtft-cmd.json:114` | **omission** | file-level scope **and** "silent on / partial" | ✅ |
| F3 | `tests/wtft-title-layout.test.ts:10` | false statement in a test header | treating tests as artifacts | ✅ |
| F4 | `wtft-renderer.ts:143` docstring | false statement (wrong function) | any careful reading | ❌ control |

## 3. Blast radius used for the run

The skill's §1 says: every source file the branch touched, excluding docs and lockfiles.
For #158 that is `git diff 9b2a16e..562f24f --name-only`, minus docs/lockfiles/generated
`.mjs`, intersected with files that exist at the fixture SHA:

- `extensions/lib/wtft-renderer.ts`
- `extensions/lib/config.ts`
- `tests/wtft-title-layout.test.ts`
- `tests/wtft-auto-fit.test.ts`
- `package.json`
- `CLAUDE.md`

(`tests/run.ts` and `tests/config-persistence.test.ts` are created *by* #158 and do not
exist at the fixture SHA.)

Note what this list does **not** contain: `docs/manifests/wtft-cmd.json`. F2's artifact is
never in the blast radius — it is reached only by auditing outward *from* a file that is.
That is the whole point of the fixture.

## 4. The fork — how faithfully to run it, and what each answer proves

| Direction | What it commits to | What it makes easier | What it pulls toward |
|---|---|---|---|
| **A. Faithful execution, genuinely fresh context** — one `claude -p` auditor process per blast-radius file, given the skill's §4 prompt verbatim, no session history | Accepting whatever it returns as the score, including a miss | A result that transfers: the same prompt run by any future agent should behave the same | Slower, costs real tokens, and may embarrass the skill — which is the point |
| **B. Single-context self-audit** — I audit the fixture myself in this session | Nothing; it is cheap | Finishing today | Proving only that *I*, holding the answer key from §2, can find drift I just wrote down. It measures nothing about the skill |
| **C. Deterministic harness** — a script that greps the fixture for the three known drift strings and asserts they are present | A regression gate on the corpus | Repeatability, CI-able | Testing the *fixture*, not the skill. Useful as a companion, useless as the backtest |
| **D. Fix the skill first, then run** — obvious weaknesses patched before the first execution | Skipping the measurement | A better-looking first result | A skill tuned to its own answer sheet twice over. Every fix would be unfalsifiable |

**Direction: A**, with **C** kept as a *companion* gate rather than as the backtest.

What A commits the codebase to: the skill's §4 prompt becomes a **tested artifact**, not
prose. Changing its wording changes measured behaviour, so the wording gets versioned with
the repo and any future edit is expected to re-run this backtest. It also commits us to
one honest asymmetry — **a miss is a finding about the skill, never about the score.** If a
fixture cannot be surfaced even after fixing the skill, this issue stays open with that
named as the next step.

**Roads not taken:**

- **B (single-context)** — the skill's §4 exists *because* a reviewer sharing your context
  inherits your blind spot. Auditing the fixture from this session, having just written §2,
  is the exact failure §4 describes. It is not a cheaper version of the backtest; it is a
  different experiment with a foregone conclusion. Kept only as the explicitly-labelled
  fallback if `claude -p` proves unusable, in which case the writeup must say so in the
  result line, because it changes what the result proves.
- **C alone** — a grep harness that asserts `◆` is in the docstring at `9b2a16e` will pass
  forever and tell us nothing about whether an auditor notices. Retained as a companion
  because the corpus itself can rot (a rewritten history, a lost SHA) and then the record
  in this file becomes unverifiable.
- **D (pre-fix)** — the ordering *is* the experiment.
- **Auditing today's `main` instead of the fixture SHA** — the drifts are fixed there, so
  the expected result is an empty table, which is indistinguishable from the failure mode
  this issue exists to detect.
- **Routing auditors to `sonnet` to save tokens** — the skill's §4 prescribes the strong
  model for auditing because it is judgment work. Downshifting would make a miss
  un-attributable: prompt weakness or model weakness? Mechanical work in this run (fixture
  materialisation, table assembly) stays in-session and costs nothing extra.

## 5. Durability — where the skill lives

Second fork, from the issue's "decide where it belongs".

`~/.claude/skills/spec-reconcile/SKILL.md` is a live dotfile in no git repo. It reaches
this machine's `~/.claude` only through the dotfiles doctor sync, and nothing version-
controls it. A skill that gates every Step 5 merge cannot live somewhere with no history
and no diff.

| Direction | What it commits to | Pulls toward |
|---|---|---|
| **Dotfile only** (today) | Nothing | Silent loss; no way to review a change to the gate |
| **`dotfiles` repo** | Skills as personal config | Correct for machine setup, wrong for a skill whose *fixtures live in this repo* — the backtest and the artifact would sit in different repos |
| **Vendored here**, `skills/spec-reconcile/SKILL.md` | This repo as the skill's home | Fixtures, backtest record, and skill diff in one history; ships already — `skills/` is in the `package.json` `files` allowlist alongside `skills/cross-harness-tool/SKILL.md` |

**Direction: vendored here.** And because two copies exist, the sync direction must be
stated or they fork silently:

> **`skills/spec-reconcile/SKILL.md` in this repo is the source of truth.**
> `~/.claude/skills/spec-reconcile/SKILL.md` is a **downstream deploy copy**. Edits go to
> the repo copy, then get copied out to `~/.claude`. Never the reverse. If the two differ,
> the repo copy wins — the dotfile has no history to lose.

The live dotfile is outside this repo, so it is backed up (`SKILL.md.<ISO-8601>.bak`)
before being overwritten.

## 6. What Code Draft delivers

1. **`skills/spec-reconcile/SKILL.md`** — vendored, with backtest-driven fixes applied and
   the sync-direction note above carried in the file itself.
2. **`~/.claude/skills/spec-reconcile/SKILL.md`** — updated to match, after a `.bak`.
3. **`docs/spec-163-spec-reconcile-backtest.md`** (this file) — §9 carries the full record:
   per fixture, surfaced yes/no, by which auditor, quoting what.
4. **`research/spec-reconcile-backtest/`** — the reusable harness: fixture materialiser,
   the instantiated auditor prompts as run, and the scoring rubric with expected answers.
5. **`tests/spec-163-spec-reconcile.test.ts`** — the companion gate (direction C).

## 7. Verification criteria

Every criterion is checkable by a third party from the artifacts in this branch.

| # | Check | Expected |
|---|---|---|
| V1 | F1 surfaced by a fresh-context auditor | Named auditor + verbatim quote of both artifact line and contradicting `path:line` recorded in §9 |
| V2 | **F2 surfaced** | Same, and §9 names *which* clause reached it (file-level scope, "silent on / partial", or both) |
| V3 | F3 surfaced | Same |
| V4 | F4 (control) result recorded either way | §9 states surfaced/missed; a miss is a finding, not a failure of the run |
| V5 | Output shape | The run produces the §6 five-column table (artifact / claim / contradicted-by / test-covered? / action), not prose |
| V6 | Coverage column honesty | At least one row correctly carries a real test name, and any row whose code no test covers is marked `reconciled-against-untested` — no row left blank |
| V7 | Fix, not just report | Every contradiction the run surfaces is either fixed in-branch, or carried as a named filed issue with a reason. Zero left standing and unattributed |
| V8 | Glossary gap | `CONTEXT.md` at the fixture SHA has `## Language — Serve` and no WTFT section; the run records that as a gap (#162) and invents no terminology |
| V9 | Miss handling | For any fixture missed, §9 names the exact clause that failed to reach it, and the skill is edited — the score is not adjusted |
| V10 | Sync direction | `diff skills/spec-reconcile/SKILL.md ~/.claude/skills/spec-reconcile/SKILL.md` is empty; a `.bak` of the pre-edit dotfile exists |
| V11 | Corpus gate | `bun run test spec-163` passes: all four fixtures still present at `9b2a16e`, and the vendored skill still carries the clauses V2 showed to be load-bearing |
| V12 | Build hygiene | `bun run typecheck` shows no new errors beyond the 2 known `TS7016`; `bun run build` leaves `git status` clean |

V2 is the one that matters most. F1 and F3 are `◆` greps; a skill can surface both and
still be useless, because the drift that actually bit this repo (#160) is an omission.

## 8. Open follow-ups

_(filled at Step 4/5)_

## 9. Backtest record

_(filled at Step 3 — see the Code Draft commit)_

— 👑π🐱 Princess Pi
