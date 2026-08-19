# Spec 163 — Backtesting `spec-reconcile`: does the skill find the drift it was written from?

**Issue:** #163
**Branch:** `163-backtest-spec-reconcile`
**Base:** `main` @ `ad91cdc`
**Fixture SHA:** `9b2a16e` (`main` before the #158 work landed)
**State:** Code and Spec Approved (2026-08-10) — backtest run, skill fixed, §9 carries the record;
V1-V10 independently re-verified against the run transcripts and issue tracker before approval
(§10); every readable artifact reconciled against the tested code at Step 5 (§11)

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

`extensions/lib/wtft-renderer.ts:693-700` (comment fences included):

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

The substring `turn` occurs **twice** in the whole manifest, both on line 5 and both in
ordinary prose inside the tool description (`"each turn's action"`, `"every turn's cost"` —
"turn" as in conversational turn). Neither is about the interval unit, and the `-i,
--interval` entry's own `flags` and `desc` never mention it. That narrower statement — *the
flag entry is silent on the turn unit* — is the fixture; the whole-file count is not, and
was wrong when this section first claimed "exactly one" (corrected at Step 4; see §11 D1).
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

## 8. Follow-ups this issue found but did not fix

| Finding | Why not here |
|---|---|
| **~30 further doc/code contradictions across the wtft surface**, returned by the auditors alongside the fixtures. Five spot-verified at HEAD: `--limit` default documented as 10 vs 100 in code; `-w/--width` documented and parsed but never read by the CLI; a `/wtft -t America/New_York` example for a flag `wtft-cli-shared.ts:74` calls "intentionally NOT supported"; "9 work types" vs 14 in `CATEGORY_ORDER`; a `mixed` category that exists only in the doc. | Filed **#167**. Splits at least three ways — a manifest pass (overlaps #160), an `EXT_WTFT.html` rewrite (overlaps #161), and a `config.ts` docstring pass with a possible real bug behind it. Each wants its own 5-step cycle |
| **`CONTEXT.md` still has no `Language — WTFT` section.** Both round-2 auditors reported the gap and invented nothing, which is the specified behaviour. | Already filed as **#162**; requires domain-modeling judgment, not reconcile |
| **Building in a worktree rewrites tracked `.mjs` bundle paths.** `node_modules` is a symlink into the main clone, so Bun records `../../../princess-pi-packages/node_modules/...` in bundle comments — four lines per bundle, in three of five artifacts. Committing that from a worktree would poison the artifacts for everyone else. | Not this issue's subject. Worked around by restoring the bundles; see §9's note. Bun also strips comments, so the docstring fixes here need no bundle change at all |
| **The `'ending'` surge badge may be unreachable** (`wtft-renderer.ts:680` returns `'surge'` for any minute inside the window). | A *code* finding, and §5 is explicit that reconcile does not brake on those. Included in #167 for triage |

## 9. Backtest record

> **Superseded as a total, not as a record (#383, 2026-08-19).** Everything below is the
> #163 run and stays accurate for it: four fixtures, one corpus SHA, two rounds. The corpus
> has since gained a fifth fixture — **F5**, the Tier-4 host-scoped case — which pins its
> own SHA (`bf4d104`) because a fixture is a tree *and* a question. The live scoring record
> is `research/spec-reconcile-backtest/RUBRIC.md`; read "four of four" here as the score of
> *this* run, not as the size of the corpus.


Run 2026-08-10. Corpus: `git archive 9b2a16e` into a tmpdir — never a worktree, so it
cannot be committed to by accident and does not appear in `git worktree list`.

**Fresh context was implemented as separate `claude -p` processes**, not in-session
sub-agents: this session has no agent-dispatch tool. That is a *stricter* reading of §4
than the skill assumed — a separate process cannot inherit the orchestrator's assumptions
even accidentally — but it is a deviation from the literal wording and is recorded as one.
Model: `opus` on every auditor, per §4's "keep the strong model for auditing".

### Round 1 — the skill exactly as written during #158

Prompts: `research/spec-reconcile-backtest/prompts/round1-as-written/`.
Output: `research/spec-reconcile-backtest/runs/round1-as-written/`.

| Auditor | Scope given |
|---|---|
| A1 | `wtft-renderer.ts` + manifest + `EXT_WTFT.html` + `README.md` — the faithful §1/§2 configuration |
| A2 | `wtft-renderer.ts`, **symbol-scoped to the edited symbol only** — a deliberate control for the §1 scope rule, which the skill forbids |
| A3 | `tests/wtft-title-layout.test.ts` + manifest + `EXT_WTFT.html` |
| A4 | `extensions/lib/config.ts` + `build-and-toolchain.md` + `CLAUDE.md` + manifest |

| Fixture | Surfaced? | By | Evidence |
|---|---|---|---|
| **F1** `◆` docstring | ❌ **missed** | — | A1 returned 21 findings including six other docstring rows (`:87`, `:764`, `:19`, `:143`, `:1169`) and never reached `:695`. A2 found it immediately, but A2 is the forbidden control, so it does not count |
| **F2** manifest omission | ✅ | A1 #9, A3 | A1: "manifest:114 / html:58 `-i <size><m\|h\|d\|w>` → also accepts `Nt`, `Nturn`, `Nturns` (`:157`…)". A3 reached it independently via `wtft-cli-shared.ts:206` |
| **F3** test header | ❌ **missed** | — | A3 audited the header and found *two other* drifts in it (`:6` watch case, `:11` legend) but not the `◆` invariant on `:10` |
| **F4** control | ✅ | A1 #19 | "`:143-149` JSDoc for a `.jsonl` file parser (`@param filePath`) sits on `parseInterval` (`:150`)" |

**Score under the skill as written: 2 of 4. The pass criterion failed.** A2's F1 hit is
excluded deliberately — counting a configuration the skill tells you not to use would be
fixing the score instead of the skill.

Note what round 1 *did* prove: **F2, the fixture the issue called hardest, was the one
that worked.** Both #158 drifts and #160 were omissions, and the "silent on / partial"
clause reached all of them, twice, from two different auditors. The failures were
elsewhere.

### Diagnosis — which clause failed, per V9

**F1 — lost to triage, not to blindness.** A1 was given a 1683-line file plus three doc
artifacts under §4's `Under 400 words` cap. It found more contradictions than the cap
could hold, so it grouped them by theme and ranked them — and a single stale docstring
lost to taxonomy and flag errors. A2, same model, same prompt body, *narrower artifact
set*, surfaced F1 with two quotes and five additional partial-claim findings. The variable
is scope width against an output budget, not capability.

> Failing clauses: §4 `Under 400 words`, and §1's silence on how wide one auditor's
> artifact set may be.

**F3 — the auditor was pointed at the wrong authority.** §4's template opens `Read <source
file>. Then read <artifacts>.` When the changed file *is* a test, that makes the test the
source of truth. At the corpus SHA the header (`:10`) and the assertions (`:130`, `:135`)
both say `◆` — they rotted together and agree perfectly. Audited against itself, the file
contains no contradiction at all. §2 correctly lists test header comments as an artifact
class; §5 says "the code is the authority" without ever excluding test code.

> Failing clauses: §4's template framing, and §5's unqualified "code".

**Also found: §2 Tier 3 was unreachable.** The skill devotes a tier to checking
user-facing strings against the glossary's `_Avoid_` lists, and no audit prompt mentions
the glossary. No auditor performed the check in round 1, and none could have. A described
check that no prompt implements does not exist.

### Fixes applied to the skill

| Fix | Section | Reaches |
|---|---|---|
| Cap replaced with "One line per finding. Do NOT triage, rank, or summarise — if there are forty, list forty… there is no length limit" | §4 | F1 |
| "Sweep the source file's own docstrings and banner comments **in file order** and account for each one" | §4 | F1, F4 |
| "A docstring that sits above the wrong symbol — or that TypeScript will attach to a different symbol than the author intended — is a finding" | §4 | the `buildTimelineString` misbinding (B1 #103) |
| Granularity rule: one auditor per file is the *floor*; a long triaged list means **re-run narrowed**; themed grouping is a symptom, not a service | §1 | F1 |
| Test-file prompt variant: "`<test file>` is an ARTIFACT, not an authority… a header comment and an assertion that agree with each other but not with the production code are **two findings, not zero**" | §4 | F3 |
| "'The code' means **production code**. A test file is an artifact — never the authority" | §5 | F3 |
| Glossary clause added to the prompt template, plus a note that Tier 3 stops existing in any variant that drops it | §4, §2 | Tier 3 |
| "The orchestrator assembles the table; auditors return findings, not tables" | §6 | output shape |
| Re-audit rationale rewritten around the `buildTimelineString` misbinding — step 4 of the loop is what catches a corrected text that stayed in the wrong place | §3 | convergence. **The shipped §3 wording attributes the misbinding to #158; §11 D2 shows it predates #158. Filed #175** |
| Sync-direction header: the repo copy is the source of truth | top | durability |

### Round 2 — corrected prompts, same corpus, same model

Prompts: `research/spec-reconcile-backtest/prompts/round2-fixed/`.
Output: `research/spec-reconcile-backtest/runs/round2-fixed/`.

| Fixture | Surfaced? | By | Evidence |
|---|---|---|---|
| **F1** | ✅ | B1 #104 | "no `◆` diamond and no surrounding parentheses are ever emitted; `:736` renders clock-face/`☀️`/`─` and `:748` wraps the body in moon emoji" |
| **F2** | ✅ | B1 #52, B3 #11 | "`-i, --interval <size><m\|h\|d\|w>` (:114) — `wtft-renderer.ts:157` also accepts `<n>t`, `<n>turn`, `<n>turns`… a reader concludes turn intervals are unsupported" |
| **F3** | ✅ | B3 #1 | "`Invariant: the SURGE timeline (---◆---) MUST be on the title row` (line 10) — `wtft-renderer.ts:736`… `◆` appears nowhere in the renderer" |
| **F4** | ✅ | B1 #89 | "**misattached**: the very next symbol is `export function parseInterval`… so IDE hover shows this docstring for the interval parser" |

**4 of 4.** Both fixed prompts also returned findings neither the issue nor #158 had:

- **B1 #103** — the `buildTimelineString` docstring is **misattached**: `MOON_PHASES`,
  `SYNODIC_MONTH_MS`, `REF_NEW_MOON` and `getMoonPhase` sit between it and the function, so
  TypeScript binds it to the moon-phase array and the function ships undocumented. B1 found
  this on the *corpus* text at `:693-700` (`MOON_PHASES` at `:702`, the function at `:718`),
  and it was **still true on `main` at `ad91cdc`** with the corrected #158 wording — same
  four declarations, shifted to `:710`/`:726`. So the misbinding **predates #158**: #158
  rewrote the docstring's text in place and inherited the bad binding rather than
  introducing it. Its hand-run reconciliation could not see either half, because it re-read
  what it had just written and never asked what the text was attached to.
  *(Corrected at Step 5 — the first draft of this bullet asserted #158 "broke the binding",
  which its own cited evidence disproves. See §11 D2.)*
- **B3 #3** — `tests/wtft-title-layout.test.ts:140` passes **vacuously**: it searches rows
  2+ for a glyph nothing emits, so it cannot fail regardless of layout. Stale-invariant rot
  one layer below the header comment.

### The reconciliation table for this run (§6 shape)

Assembled by the orchestrator from auditor findings, per the §6 fix.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `wtft-renderer.ts:143-149` (docstring) | `parseInterval` parses a `.jsonl` session file, `@param filePath` | takes a string, returns `IntervalConfig`, reads no file — `:150-162` | ✅ `wtft-issue-121.test.ts` | **Fixed in this commit** — rewritten to document both accepted shapes and the silent `1h` fallback |
| `wtft-renderer.ts` (docstring for `buildTimelineString`) | binds to the function | four declarations intervene; binds to `MOON_PHASES` | ✅ `wtft-title-layout.test.ts` (behaviour) / ❌ the *binding* | **Fixed in this commit** — moved adjacent, with a `#163` note saying why. Binding now gated by `tests/spec-163-spec-reconcile.test.ts` |
| `docs/manifests/wtft-cmd.json:114` | `--interval <size><m\|h\|d\|w>` | `parseInterval` also accepts `t`/`turn`/`turns` — `:157` | ✅ `wtft-issue-121.test.ts` | Already filed **#160** — manifest copy, out of this branch's scope |
| `~/.claude/skills/spec-reconcile/SKILL.md` | authoritative copy of the skill | no history, no diff, reachable only via dotfiles sync | n/a | **Fixed** — vendored to `skills/spec-reconcile/SKILL.md` as source of truth; deploy copy synced after a `.bak`; drift gated by V11 |
| `SKILL.md` §7 | "Run the skill against that branch" (never run) | never executed; scored 2 of 4 when it finally was | ✅ this record + `tests/spec-163-spec-reconcile.test.ts` | **Fixed** — §7 now records the measured result and points at the re-runnable harness |
| `SKILL.md` §2 Tier 3 | user-facing strings are checked against the glossary | no prompt implemented the check | `reconciled-against-untested` | **Fixed** — glossary clause added to the §4 template. Nothing tests that an auditor *acts* on it beyond round 2's output |
| `CONTEXT.md` | — | no `Language — WTFT` section; only `Language — Serve` | n/a | Gap recorded; already filed **#162**. Both round-2 auditors said so explicitly and invented no terms |
| ~30 further wtft doc claims | see §8 | auditor output in `runs/` | mostly untested | Filed **#167**, with 5 spot-verified at HEAD |
| `bin/*.mjs` | tracked bundles | rebuilt paths differ under a worktree symlink | n/a | Restored, not committed. Bun strips comments, so no bundle change was warranted |

One row carries `reconciled-against-untested`, and it is honest: the glossary clause is
prose in a prompt, and nothing verifies that an auditor obeys it beyond this run's output.

Zero contradictions left standing: two fixed here, four fixed as artifacts of this issue,
three carried as filed issues (#160, #162, #167) with reasons.

### Verification criteria — status

V1-V10 and V12 were self-reported at Code Draft and re-verified at Spec Approved (§10) and
Code Approved. V11 could not be reported at Code Draft at all: the pre-test rule (Step 3)
forbids running the suite before that commit exists, so its ⏳ was correct, not lax.

| # | Status |
|---|---|
| V1 F1 surfaced | ✅ round 2 (B1 #104). ❌ round 1 — the finding, diagnosed above |
| V2 **F2 surfaced** | ✅ **both rounds**, and the clause is named: "silent on / partial" reached it, file-level scope put the renderer in range. The symbol-scoped control (A2) missed it, confirming §1 is load-bearing |
| V3 F3 surfaced | ✅ round 2 (B3 #1). ❌ round 1 — the finding, diagnosed above |
| V4 F4 recorded | ✅ surfaced in both rounds (A1 #19, B1 #89) |
| V5 §6 table | ✅ above. Skill amended: the orchestrator builds it, auditors return findings |
| V6 coverage honesty | ✅ one row marked `reconciled-against-untested`; no row blank |
| V7 fix not report | ✅ two fixed in-branch, four fixed as artifacts, three filed (#160, #162, #167) |
| V8 glossary gap | ✅ both round-2 auditors reported no WTFT section and invented nothing; one explicitly declined to apply Serve's `_Avoid_` list to wtft |
| V9 miss handling | ✅ two misses, each with its failing clause named, each answered with a skill edit. No fixture softened |
| V10 sync direction | ✅ `diff` empty; `~/.claude/skills/spec-reconcile/SKILL.md.2026-08-10T10-45-54Z.bak` exists |
| V11 corpus gate | ✅ at Code Approved (`09d97e0`). First-ever run failed one assertion — a **test-logic** bug, not a fixture regression: the F2 check swept the whole corpus manifest for the substring `turn`, which matches two occurrences of unrelated prose on line 5. Rescoped to the `-i, --interval` entry's own `desc`, which is the fixture's actual claim; the wrong claim was §2's, and §2 is corrected here. Re-run: **44/44 suites, 37/37 assertions in this suite** |
| V12 build hygiene | ✅ `bun run build` clean (validated 2 SKILL.md files), `git status` clean after; `bun run typecheck` shows exactly the 2 known pre-existing `TS7016` (`bin/serve.ts`, `extensions/lib/serve/process.ts` importing `cloudflare.js`) — unrelated to this branch, present on `main` |

**The headline: the skill as written scored 2 of 4, and both misses were in the audit
prompt rather than in the ideas.** §1's file-level scope rule and §4's "silent on /
partial" clause — the two things #158 was least sure about — were the two that worked.
The failures were a word cap nobody thought was load-bearing, and an unexamined assumption
that "the code is the authority" needs no qualification when the changed file is a test.

## 10. Spec Approved — independent re-verification

Duppy delegated approval on this issue; the check below is not a rubber stamp. Every
citation in §9 that names a run file and a finding number (e.g. "B1 #104", "A1 #9") was
re-opened and the quoted text confirmed to be exactly what that auditor returned — not
paraphrased. `CONTEXT.md` at `9b2a16e` was independently re-read for V8 (one section,
`## Language — Serve`, no WTFT section — confirmed). Issues #160, #162, #167 were
independently confirmed open on the tracker for V7. This closes the "raw agent output"
risk the drafting agent flagged in its own open questions — the citations are load-bearing,
not decorative.

**Two things this pass found and disposed of, neither a spec change:**

- **A tracked `node_modules` symlink** landed by accident in the Spec Draft commit
  (`0cf5c7c`) — `git add -A` picked it up because `.gitignore`'s `node_modules/` pattern
  matches directories, not a symlink of that name. Main does not track `node_modules` at
  all. Untracked in a standalone `chore:` commit ahead of this one; zero spec or code
  content changed.
- **V10's "repo copy vs deploy copy" assertion is host-state-dependent by design, not by
  oversight** — the drafting agent's second open question. Read the suite: it only compares
  when `~/.claude/skills/spec-reconcile/SKILL.md` exists, and skips (not fails) when it
  does not. That is the correct shape for a gate whose failure mode is "the two copies
  forked on a machine that has both" — it must not fail CI or a fresh clone that never had
  the deploy copy. Confirmed as intended; no change needed.

V11 and V12's checkmarks in §9 are the drafting agent's Code Draft self-report, made before
the suite had ever run once (correct, per the pre-test rule) — they are re-verified for
real, from the runner's own output, at Code Approved. The remaining open questions (Tier 2
artifact enumeration is still orchestrator judgment; #167's ~30 findings are mostly
unverified raw output) are accurately scoped as future work, not gaps in *this* issue's
V1-V12, and are left as recorded.

## 11. Step 5 — Code and Spec Approved: the reconciliation

This issue's subject is a skill that reconciles specs against code. Running Step 5 on it
without running that skill's own method would have been the joke writing itself, so §1's
file-level blast radius and §4's "silent on / partial" were applied here, to this branch:

    git diff main..HEAD --name-only, minus runs/ (raw auditor transcripts, preserved verbatim)
      docs/spec-163-spec-reconcile-backtest.md   extensions/lib/wtft-renderer.ts
      skills/spec-reconcile/SKILL.md             tests/spec-163-spec-reconcile.test.ts
      research/spec-reconcile-backtest/{RUBRIC.md, run-backtest.sh, prompts/}
    plus, per §1, the artifacts those files' *contents* changed the truth of:
      README.md (what `skills/` now contains)   tests/run.ts (how many suites exist)

Whole files were re-read, not only the hunks. Two of the six findings below sit in
neighbours nobody edited — which is the scope rule earning its keep a second time.

### The table (§6 shape)

| # | Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|---|
| D1 | `docs/…-backtest.md` §2 F2 | "The manifest contains exactly **one** occurrence of the substring `turn` … `"every turn's cost"`" | `git show 9b2a16e:docs/manifests/wtft-cmd.json` — **two**, both line 5, both prose (`"each turn's action"`, `"every turn's cost"`) | ✅ `spec-163-spec-reconcile.test.ts` (the assertion this broke) | **Fixed** — §2 now states the narrower true claim: the `-i, --interval` entry's own `desc` is silent on the turn unit |
| D2 | `docs/…-backtest.md` §9, round-2 bullet | "#158 fixed the *text* and broke the *binding*" | `9b2a16e` already has the docstring at `:693-700`, `MOON_PHASES` at `:702`, function at `:718` — B1 #103 audited **that** tree, and `ad91cdc` repeats it at `:710`/`:726` | ✅ `spec-163-spec-reconcile.test.ts` gates the binding, not the history | **Fixed** — bullet rewritten: the misbinding predates #158, which inherited it |
| D3 | `extensions/lib/wtft-renderer.ts` `#163` note in the `buildTimelineString` docstring | "#158 landed this text four declarations too early" | same as D2 — the note repeated the false causality into the source file | ✅ the binding is gated; the *comment* is not | **Fixed** — reworded to "the misbinding predates #158 … #158 rewrote the text in place and inherited it" |
| D4 | `tests/spec-163-spec-reconcile.test.ts` header | enumerates **3** things the suite gates | the suite has **5** sections — repo-vs-deploy parity and harness presence were unlisted | `reconciled-against-untested` — nothing asserts a header matches its own body | **Fixed** — header now lists all five, one per section, and states why §3 skips rather than fails |
| D5 | `skills/spec-reconcile/SKILL.md` §3 and §6 | §3 attributes the misbinding to #158 (D2 again); §6's example cites `:744` for "clock faces / moon bookends", which is a bare `}` (`:736` and `:748` are the code) | `9b2a16e` renderer | ✅ §2's clause set is gated; these two sentences are not | **Filed #175** — §3 of the suite pins this file byte-for-byte to `~/.claude/skills/spec-reconcile/SKILL.md`, and this pass was scoped to the worktree. Editing the repo copy without the paired copy-out ships a red gate. Both edits + the `cp` are in the issue |
| D6 | `README.md` "What's Included" | lists a `learning_pi_extension_api` skill "Found in `skills/learning-pi/SKILL.md`"; lists **no** skill this repo actually ships | `git ls-files` — no `learning-pi` path since `911507d` (#27, consolidated to `~/.pi/agent/skills/`); `skills/` holds `cross-harness-tool` and, as of this branch, `spec-reconcile` | `reconciled-against-untested` — nothing checks README against `skills/` | **Fixed** — stale row removed, real rows added. This branch *created* half of it: shipping a skill the index never mentions is the F2 omission class, in our own README |
| D7 | `tests/run.ts` header | "34 of 42 suites are standalone scripts" (present tense) | 44 suites today, 36 with `process.exit`; `docs/spec-158-one-test-runner.md:29` already pins those numbers to `main` @ `9b2a16e` "as measured" | `reconciled-against-untested` | **Fixed** — count claim anchored to the #158 measurement instead of the live tree, so it stops re-rotting each time a suite lands. This branch added the 44th |

### Convergence — passes until one found nothing new

1. **Pass 1** (whole-file re-read of the seven artifacts above): D1, D2, D4, D6, D7.
2. **Pass 2** (re-audit of what pass 1 *edited*, plus what those edits now reference — §3
   step 4 of the skill): found D3 and D5, both of which are the *same false sentence as D2*
   copied into a source comment and into the skill. Pass 1 had fixed the spec and left two
   copies standing. This is precisely the failure mode §3 step 4 exists for, and it fired on
   the first branch that ran it.
3. **Pass 3** (re-read of every file touched by passes 1-2, plus `docs/manifests/*.json`,
   `docs/EXT_WTFT.html`, `CLAUDE.md`, `docs/agents/*`): **nothing new.** Clean pass — done.

### What pass 3 checked and cleared, so the absence is legible

- **`docs/manifests/*.json`** — no drift *caused by this branch*. It ships no flag, no
  accepted input, no CLI surface: `extensions/lib/wtft-renderer.ts` changed comments only
  (`git diff main..HEAD -- extensions/lib/wtft-renderer.ts` is two docstrings). Manifest
  gaps that already existed are #160 (the `-i <n>t` omission, which is fixture F2) and #167.
- **`docs/EXT_WTFT.html`** — Tier 1: it `fetch`es the manifest rather than copying it, so it
  inherits exactly the above and adds nothing. Its prose drift is #167.
- **Every citation in §2, §3 and §9** re-opened against `git show 9b2a16e:…` a second time,
  independently of §10: F1 `:693-700`/`:695` (the file's only `◆`), the contradicting
  `:735-736` and `:747-748`, F2 manifest `:114`, `parseInterval` `:150`-`:163` with the turn
  branch at `:157`, F3 test `:10-11`/`:130`/`:135` and the vacuous `:140`, F4 `:143-149`.
  All exact. §2's F1 range was widened `694-699` → `693-700` to include the comment fences
  it quotes. The `:150-162` range for `parseInterval` is left as-is — the closing brace is
  at `:163`, which is a citation convention, not a false claim.
- **`skills/spec-reconcile/SKILL.md` §1, §4, §5, §7** — every "Backtested (#163)" claim
  traced to a run file and a finding number in `runs/`. All hold. Only §3 and §6 drifted
  (D5).
- **`research/spec-reconcile-backtest/`** — `RUBRIC.md`'s four fixtures and its result log
  match §9 row for row; `run-backtest.sh` pins `9b2a16e`, the SHA the record cites, and V11
  asserts that. `prompts/` and `runs/` are the run *as executed* and are deliberately frozen:
  correcting a prompt after the fact would destroy the measurement it produced.

### Notes on scope

No production code changed between `09d97e0` (Code Approved) and this commit. D3 and D7 are
comment-only edits; D1, D2, D4, D6 are docs and a test header. The one code-shaped finding
this branch is carrying — the possibly-unreachable `'ending'` surge badge (§8) — stays in
#167, per §5's rule that reconcile does not brake on code findings.

**Issues left open on purpose:** #160 (manifest copy — it *is* fixture F2; fixing it in this
branch would have destroyed the fixture), #162 (glossary, needs domain-modeling judgment),
#167 (~30 wtft doc claims, splits three ways), #175 (SKILL.md, needs the paired deploy-copy
sync). Each is named in a table row with its reason. Zero contradictions left standing and
unattributed.

— 👑π🐱 Princess Pi
