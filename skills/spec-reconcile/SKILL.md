---
name: spec-reconcile
description: Find and FIX every readable artifact that contradicts the actual code — specs, manifests, --help text, error messages, README, docstrings, test header comments. Runs fresh-context auditors that must quote code, then applies the corrections and re-verifies until a pass finds nothing new. Use at the **Code & Spec Approved** step — after GREEN, before `pr-open` — or when the user says "reconcile the spec", "bring the docs up to date with the code", "does the spec still match", or before answering "ready to merge?".
---

# Spec Reconcile

> **Where this file lives.** The copy in `princess-pi-packages/skills/spec-reconcile/SKILL.md`
> is the **source of truth**. `~/.claude/skills/spec-reconcile/SKILL.md` and
> `~/.pi/agent/skills/spec-reconcile/SKILL.md` are **downstream deploy copies** — edit the
> repo copy, then copy it out to both harness targets. Never the reverse. If the two differ,
> the repo copy wins; the dotfile has no history to lose. The backtest corpus and harness
> that keep §4 honest live in the same repo (`research/spec-reconcile-backtest/`), which is
> why the skill lives here rather than in `dotfiles`.

The flow's reconcile step asks you to *update the Spec artifacts to perfectly mirror the
tested Code*. "Perfectly mirror" is unfalsifiable — you cannot fail it, so you cannot
finish it either. This skill replaces that with something checkable.

Where it sits: **Spec Approved → RED → GREEN (Code Approved) → *spec-reconcile* (Code &
Spec Approved) → `pr-open` → human `pr-merge`.** The step used to be numbered — "Step 5"
of a five-step flow that the PR-based flow replaced — and the number is gone, not the
step.

## The rule this exists to enforce

**Any readable artifact that contradicts the code is a landmine.** The next agent or
human gets the spec, the `--help` text, or the comment — and has no way to know it lost
a race with the code. Whichever they read first becomes their source of truth, and they
build on it. One stale sentence compounds.

So the bar is not "the spec looks right." It is **zero known contradictions left
standing**, across every artifact a reader might reach.

## The inversion — this is why it gets missed

Every other review in the flow checks **code against spec**: *did we build what we said?*
This one is the opposite: **spec against code**: *does every claim we wrote still hold?*

Nobody catches drift by re-reading a spec they wrote. It reads as correct because it
matches what they believed. You must **enumerate the claims and go look at the code for
each one** — which is why the audit runs in fresh context and must quote source.

## 1. Scope — file-level blast radius, one auditor per bounded artifact set

Take every **source file** the branch touched (`git diff <base>..HEAD --name-only`,
excluding docs and lockfiles). For each one, audit every readable assertion about
**anything in that file** — not only the symbols you edited.

File-level, not symbol-level, is deliberate and load-bearing. Worked example: on
`princess-pi-packages#158` the branch edited one docstring in
`extensions/lib/wtft-renderer.ts`. `parseInterval` sits at line 150 of that same file
and had been undocumented in `--help` since a much earlier issue. Symbol-level scoping
misses it; file-level scoping finds it (it became #160). You will surface drift you did
not cause — **fix it anyway**, or file it. Leaving it is the landmine.

**Backtested (#163):** the symbol-scoped control auditor was handed the same file and the
same prompt body but told to audit only the edited symbol. It missed the manifest gap
entirely. The scope rule is doing real work — do not quietly narrow it back.

### Granularity — a bloated artifact set silently becomes a triage exercise

One auditor per changed source file is the *floor*, not the ceiling. An auditor whose
artifact set contains more contradictions than it can comfortably report starts ranking
them, and **ranking loses findings** — usually the small ones, which is exactly the class
this skill exists to catch.

**Backtested (#163):** an auditor given a 1683-line source file plus three doc artifacts
returned 21 findings and dropped a stale docstring that a *narrower* auditor on the same
file, same model, same prompt body found immediately. Nothing was wrong with the model or
the wording; the scope was too wide to report exhaustively.

So:

- If a pass returns a long triaged list, **re-run it narrowed** — split by artifact, or
  by region of the source file — rather than accepting the top-N as the finding set.
- Treat "grouped by theme, most important first" in auditor output as a **symptom**, not
  a service. It means findings were dropped.

### Reverse scope — when the branch changes a *tool*, ask who quotes it

Diff scope answers *"which artifacts describe the files I changed?"*, and it answers it
from inside the repo. For a **tool whose behaviour other documents assert** — a hook, a
`bin/` script, an extension, a skill — the useful question is the reverse: **"who quotes
this tool's behaviour, anywhere?"** That is a downstream-readers set. It is not a diff set,
and no widening of `--name-only` produces it.

**Trigger.** The branch touches `hooks/`, `bin/`, `extensions/`, or `skills/` → **Tier 4**
(§2) activates, in addition to every tier the diff already reached.

**Why a diff provably cannot get there** (`princess-pi-packages#381`).
`~/git-projects/CLAUDE.md` told every session that `git push` was intercepted
unconditionally. `hooks/block-dangerous-git.sh` has blocked by push *destination* since
#74. The file is not gitignored — `~/git-projects/` is **not a git repository at all**, so
the file has no history, no diff, and no commit any check can hang off. *There is no
changeset in which it appears*, which is why "add `CLAUDE.md` to the reconcile file list"
does not reach it. An agent read the file, believed it, and wrote *"the guardrails hook
blocks agent `git push`"* into four artifacts in another repo — during a session in which
`pr-open` pushed a branch for it four times. The tracked spec
(`docs/dev-workflow-spec.md`) was correct the whole time, so a repo-scoped audit of that
branch would have come back clean.

## 2. Artifact classes — four tiers, checked four different ways

Not every artifact is reachable the same way. Sort them before auditing, or you will
either miss the unlinkable ones or waste passes on ones that cannot drift. Tiers 1–3 are
reached by the diff; Tier 4 is reached only by §1's reverse scope.

### Tier 1 — shared source: fix once, propagates

Where a doc and the running code read the *same* file, drift is structurally impossible
and there is nothing to cross-check. Audit **the shared source against the code**, once.

Worked example: `docs/EXT_WTFT.html` does not copy the flag reference — it
`fetch('manifests/wtft-cmd.json')` at load and renders it, the same manifest that drives
`--help` and `--why`. So one manifest edit corrects the tool's help output *and* the
extension doc simultaneously. When you find a gap here (`princess-pi-packages#160`), it is
one fix, not three.

Prefer creating these. A contradiction that cannot exist beats one you have to hunt.

### Tier 2 — live prose: audit against the code

| Class | Typical location |
|---|---|
| System spec (per tool) | `docs/EXT_*.html` |
| Feature specs it links out to | `docs/spec-*.md`, `docs/adr/` |
| Agent + human docs | `README.md`, `docs/agents/*`, `CLAUDE.md` |
| Docstrings and `//` comments | on/around every symbol in a changed file |
| **Test file header comments** | they state invariants, and they rot silently |
| Issue body resolution block | the tracker |

Feature specs are **live**, not archived — the system spec links to them as its detailed
layer, so they must stay true. The audit trail lives in git history and the issue's
Step 1–5 commits, not in leaving a stale file frozen.

Test header comments are the ones people skip. They state invariants, no one re-reads
them, and they outlive the assertions below them. §5 has the rule that makes them
reachable.

### Tier 3 — non-enumerable strings: audit against the glossary

Error, warning, status, and notify text is hardcoded across the codebase and will never be
linked from a spec. Do not try to enumerate it centrally. Check two things instead:

1. **Factual accuracy** — does the string describe what the surrounding code does? A
   warning naming a wrong path, a stale condition, or a flag that no longer exists is
   exactly as misleading as a stale spec.
2. **Terminology** — does it use the project's canonical terms? The Domain-Driven Design
   glossary (`CONTEXT.md`, `GLOSSARY.md`, or whatever the `domain-modeling` skill
   produced) is authoritative. Its entries carry an `_Avoid_:` list of banned synonyms —
   **that list is mechanically checkable against any user-facing string.** A message using
   an `_Avoid_` term is a finding.

If the glossary has no section for the tool you are reconciling, say so in the record
rather than inventing terms. That is a gap for the `domain-modeling` process, not
something to paper over here.

**This tier only happens if the prompt asks for it.** Tier 3 was unreachable in the
skill's first version (#163) — it described a check that no audit prompt implemented, so
no auditor ever performed it. The glossary clause is now in the §4 template. If you write
a variant prompt, carry that clause or Tier 3 silently stops existing.

### Tier 4 — host-scoped docs: loaded every session, reachable by no diff

These are the documents that configure the agent rather than the product. They are read
into **every session**, they assert what your tools do, and **nothing enumerates them from
a changeset** — some live in another repo, some in no repo at all.

| Document | Status | Reachable by a diff? |
|---|---|---|
| `<this repo>/CLAUDE.md`, `AGENTS.md` | tracked | yes — Tier 2 already has it |
| Other clones' `CLAUDE.md` / `AGENTS.md` — listable: `ls ~/git-projects/*/CLAUDE.md ~/git-projects/*/AGENTS.md` | tracked, **other repo** | no |
| `~/git-projects/CLAUDE.md` (domain rules) | **in no repository** | **no** |
| `~/.claude/CLAUDE.md` (global rules) | **in no repository** | **no** |
| `~/.claude/settings.json` where it names a script by path | **in no repository** | **no** |

**The set is enumerated because it cannot be derived from a changeset** — but four of the
five rows *are* derivable from the filesystem, and the fifth is a glob. Run this and you
have the tier's artifact set:

```
ls ~/.claude/CLAUDE.md ~/git-projects/CLAUDE.md ~/.claude/settings.json \
   ~/git-projects/*/CLAUDE.md ~/git-projects/*/AGENTS.md 2>/dev/null
```

That is what makes the tier practical rather than aspirational: no agent has to *know* the
clones, only to list them.

**Two limits, stated rather than papered over.** A clone outside `~/git-projects/` is
invisible to that glob — if a project lives elsewhere, its row is a manual addition. And a
*new kind* of host document that quotes a tool and never gets a row here is invisible
again; when you write one, add it in the same commit. Neither is fixable by machinery,
which is why the cheapest mitigation is this sentence rather than a scanner.

**Check the ones present; declare the ones absent.** An agent on a laptop cannot see this
VPS's files, and CI has none of them. "Absent" is a fact to record, never a pass — a run
that silently checked nothing reports the same green as a run that checked everything.

#### Pin the claim; do not merely edit the sentence

Where the claim is about **observable tool behaviour** — an exit code, what is blocked,
what a flag accepts — the reconcile output should be a **claim-table entry**, not just a
corrected sentence. `princess-pi-packages#381` / PR #382 is the worked pattern
(`tests/doc-claims-vs-hooks.test.ts`): each entry pins a **verbatim quote that must still
appear in its document** *and* the **probes that quote asserts**, run against every
implementation, with `##SKIP##` (`tests/lib/skips.ts`) when the host document is absent.

That covers two failure directions, and a probe-only check catches just one:

1. **The tool changes and a doc still asserts the old behaviour** — caught by the probes.
2. **A doc is reworded into a false claim while the tool stays put** — caught only by the
   pinned quote. This is the direction that actually happened.

A pin converts a one-time correction into a standing check, so the next behaviour change
fails the build instead of waiting for a human to ask the right question.

**Honest limits, which this tier does not paper over:**

- **A check on host state cannot be enforced on CI**, which has none of these files. It
  must skip *visibly*, never pass quietly.
- **Not every prose claim is probe-able.** *"Prefer X over Y"* has no verdict. Pin the
  claims that name observable behaviour; correct the rest as ordinary Tier 2 prose.
- **A wrong rule here is worse than an absent one.** These files carry the authority of
  the harness itself, so agents propagate their errors into places the file's author will
  never look — which is the whole reason a tier that costs an enumerated list is worth it.

## 3. The loop — find, fix, re-verify, until dry

This is a convergence loop, not a checklist. It is not done when you have a report; it
is done when the contradictions are gone.

1. **Enumerate + audit** (fresh context — §4). Get back a list of contradictions, each
   with the artifact quote and the contradicting `file.ts:line`.
2. **Classify each** (§5) — doc-follows-code, or escalate.
3. **Apply the fixes.** Edit the artifacts. This is the part that makes the skill worth
   running; a finding you did not fix is a finding you deferred onto the next reader.
4. **Re-run the audit** on the artifacts you just changed, plus anything your edits now
   reference.
5. **Repeat until a pass finds nothing new.** One clean pass = done.

Step 4 is not ceremony. **Backtested (#163):** #158's reconciliation corrected the stale
`buildTimelineString` docstring text but left it four declarations above the function,
where it had already been binding to `MOON_PHASES` since before the branch started — so
the function still shipped undocumented after a reconciliation pass that touched that
exact docstring. Correcting a doc's words does not re-point it. A re-audit of the artifact
just edited catches that class of error; nothing else does.

## 4. The audit pass — fresh context, must quote code

Dispatch auditors with **no session history**. This is the whole point: you cannot catch
*"I assumed the help text was authoritative"* from inside the head that assumed it. A
reviewer sharing your context inherits your blind spot.

Sub-agents work. Separate `claude -p` **processes** work better and are the fallback when
the harness has no agent-dispatch tool — a fresh process cannot inherit your assumptions
even accidentally.

Fan out one auditor per changed source file (subject to §1's granularity rule), plus one
for the spec document — **plus one host-scoped auditor whenever §1's reverse-scope trigger
fired** (the branch touched `hooks/`, `bin/`, `extensions/`, or `skills/`).

**That last one is not optional, and this is the second time this skill has needed the
rule.** Tier 3 was unreachable in v1 because it described a check no prompt implemented
(#163). Tier 4 arrives with the same hazard and a worse blast radius: its documents are
loaded into every session. A tier that no auditor is dispatched for does not exist.

The host-scoped auditor gets the **same prompt body** as the others, with one block added
naming the enumerated set from §2 — and nothing else. Keep the addition to enumeration:

> This branch changes a TOOL, so the artifact set is not the diff. Also audit the
> host-scoped documents that quote this tool's behaviour and that no changeset contains.
> Read every one of these that exists, and for each one that does NOT exist, say so
> explicitly rather than passing over it:
>
> `~/.claude/CLAUDE.md` · `~/git-projects/CLAUDE.md` · `~/.claude/settings.json`, plus
> every path printed by
> `ls ~/git-projects/*/CLAUDE.md ~/git-projects/*/AGENTS.md 2>/dev/null`.
> Run that glob rather than guessing which clones exist. Report any listed path you could
> not read, and say plainly that a clone outside `~/git-projects/` is out of this scope.

Do **not** also tell it to quote the offending sentence verbatim, or to look for a
particular claim. Those instructions aim the auditor at the answer; §7's round 3 had to be
re-run once for exactly that reason. Set the model explicitly on every dispatch — this is judgment work,
so keep the strong model for auditing; route the mechanical fix-application to `sonnet`.
Downshifting the auditor makes a miss un-attributable: weak prompt, or weak model?

Prompt shape matters more than the word "adversarial". Asked *"is this accurate?"* a
reviewer confirms. Give it this instead:

> Read `<source file>` in full, top to bottom. That file is the authority.
> Then read `<artifacts>`.
>
> List EVERY claim in those artifacts that the source contradicts, is silent on, or
> documents only partially. One line per finding. Do NOT triage, rank, or summarise — if
> there are forty, list forty. Never drop a finding to fit a length; there is no length
> limit.
>
> Sweep the source file's own docstrings and banner comments in file order and account
> for each one. A docstring that sits above the wrong symbol — or that TypeScript will
> attach to a different symbol than the author intended — is a finding.
>
> For each finding: quote the artifact line, quote the contradicting code as `path:line`,
> and state what the code actually does.
>
> Include claims that are *incomplete*, not just wrong — an accepted input that `--help`
> never mentions is a contradiction, because a reader concludes it is unsupported.
>
> If a user-facing string uses a term the project glossary (`CONTEXT.md`) marks under
> `_Avoid_`, that is a finding. If the glossary has no section for this tool, say so
> plainly and invent no terminology.
>
> If you find none, do not say "looks good" — list what you checked and how you verified
> it. Do not fix anything.

Every clause there is load-bearing, and #163 measured which:

| Clause | What it reaches | Evidence |
|---|---|---|
| "silent on / partial" + the `--help` sentence | **omissions** — the drift class that is invisible to anyone hunting for wrong sentences | Both #158 drifts and #160 were omissions |
| "no length limit / do not triage" | small findings that lose a ranking contest | v1's 400-word cap dropped a stale docstring |
| "sweep docstrings in file order" | comments the reader never navigates to | found a JSDoc describing an entirely different function |
| "wrong symbol / TypeScript will attach" | misplaced docs, which read as correct in review and are wrong in the editor | found #158's own mis-paste |
| glossary sentence | Tier 3, which is otherwise unreachable | v1 had no auditor that ever checked it |

### Variant — when the changed file is a test

Swap the first three lines. A test audited against itself has nothing to contradict: its
header and its assertions rot together, agreeing with each other the whole way down.

> `<test file>` is an ARTIFACT, not an authority.
>
> Read `<production file(s) it exercises>` first — those are the authority for what the
> code actually does.
>
> Then read `<test file>`. Treat BOTH its header comment AND its assertion strings as
> claims about that production code. A header comment and an assertion that agree with
> each other but not with the production code are **two findings, not zero** — do not
> audit a test against itself.

Then continue with the standard template from "List EVERY claim…".

**Backtested (#163):** with the standard prompt, the stale `◆` invariant in
`tests/wtft-title-layout.test.ts` was missed — the auditor read the test as the source of
truth, and the header agreed with the assertions. With this variant it came back first,
plus the observation that the sibling assertion passed *vacuously* because it searched for
a glyph nothing ever emits. Vacuous assertions are the same rot one layer down.

## 5. Code is the authority — always fix the doc

**The code is correct. The doc is what changes.** You only reach this step because the
feature's tests passed, and by then any in-process spec adjustments have already been
re-approved against real observed behaviour. Tested behaviour *is* the spec.

"The code" means **production code**. A test file is an artifact (§4 variant) — never the
authority for what the production code does.

Do **not** brake on "but maybe the code regressed." Reconcile is not a second regression
detector — that is the test suite's job, and if the tests are inadequate that is a
test-generation problem to fix in the test process, not here. A skill with two jobs does
both badly, and a brake that fires on judgment becomes an excuse generator: *"this might
be a regression"* is a very convenient reason to leave a contradiction standing, which is
the exact landmine this skill exists to remove.

**One mechanical check, which never blocks the fix.** The residual risk is narrow and
locatable: a contradiction in behaviour *the tests never covered*. There, "the tests
passed" is not evidence about this behaviour at all — it is an assumption wearing a
verified costume.

So for each contradiction, ask the checkable question — **is this behaviour covered by a
test?** — not the unanswerable one. Then:

- **Covered** → fix the doc. The authority is real.
- **Not covered** → fix the doc anyway, and mark the row `reconciled-against-untested`
  in the record (§6).

Either way the contradiction dies, so nothing is deferred onto the next reader. The mark
routes the signal to the test process, where it belongs, instead of stalling reconcile or
being lost. A run with many such rows is telling you about coverage, not about specs.

## 6. Output — the record is the definition of done

**The orchestrator assembles the table; auditors return findings, not tables.** Do not ask
an auditor for the record — asking for a formatted table invites it to fill five columns
per row instead of finding a sixth row, and the coverage column is a judgment about the
test suite that a single-file auditor cannot make.

Commit a reconciliation table in the spec (or the PR body):

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/manifests/x.json:114` | `--interval <size><m\|h\|d\|w>` | `parseInterval` also accepts `t`/`turn`/`turns` — `wtft-renderer.ts:157` | ✅ `wtft-issue-121.test.ts` | Filed #160 (manifest copy) |
| `wtft-renderer.ts:694` | timeline renders `(---◆---)` | clock faces, `☀️` at noon — `:736`; moon bookends — `:748` | ✅ `wtft-title-layout.test.ts` | Fixed in this commit |

Every row is checkable by a third party. "Reviewed the docs" is not.

The coverage column is the skill's own honesty check. A row marked
`reconciled-against-untested` means the doc now matches code that nothing verifies —
still the right fix, but a lead for the test process. Count them; a run producing many is
reporting a coverage hole, not a documentation one.

Reconcile commits change **specs, comments, and spec-supporting artifacts only** — no
production code. If the audit turns up a code finding (§5), it does not belong in this
commit.

The "spec reconciled" gate is satisfied when this record exists and shows no open
contradictions — not when someone remembers re-reading the spec.

**Nothing enforces that gate, and saying so is the point.** `pr-open` runs branch,
divergence, and PR-state pre-checks; it never reads a reconcile record and never asks
whether contradictions are closed. The gate belonged to a `merge-checklist` skill that never
existed on disk. So the record is *evidence for the human at `pr-merge`*, not a
blocker — an unenforced rule is a wish, and a wish described as a gate is worse than
either. If it should block, that is a change to `pr-open`, filed as its own issue.

## 7. Validating this skill — backtested, and re-runnable

A skill that sounds rigorous and finds nothing is worse than no skill.

**Backtest ran 2026-08-10 (`princess-pi-packages#163`)** against four real drifts frozen
at SHA `9b2a16e`. The version of this skill written during #158 **surfaced two of four.**
Every fix in §1, §3, §4, and §5 above is traceable to one of those two misses; the record
with per-fixture attribution is `docs/spec-163-spec-reconcile-backtest.md` §9. The
corrected prompts surfaced four of four, including two drifts still live on `main` that
#158's hand-run had missed.

**Round 3 ran 2026-08-19 (`princess-pi-packages#383`)** against a fifth fixture — the
Tier-4 case, at its own corpus SHA `bf4d104`, with the host document staged beside the
tree because no `git archive` can carry a file that lives in no repository. F5 is the only
fixture that measures a **scope** rule with nothing left for prompt wording to explain —
the two prompts are byte-identical apart from the block that enumerates the host documents,
and both arms are handed the same tree.

**The sharpest part of the result: the host document sat in the control's corpus the whole
time.** Both arms got the same tree; only C2's prompt named the file. C1 returned **59
scoreable findings (60 labelled) and never mentioned it once.** The drift was not hidden from the diff-scoped
auditor — it was *unenumerated*, which is precisely what a diff does to a file that appears
in no changeset.

**And "the control came back clean" means clean *on the F5 claim*, nothing more.** Those 59 included a live guardrail bug (#389, the `gh -R … pr merge` bypass);
none of them said push was blocked outright, because no tracked artifact claimed it.
Per-arm attribution, and the one issue whose transcript an earlier re-run erased, are in
`RUBRIC.md`'s log — read it before crediting a finding to an arm.

The corpus, the prompts as run, and the scoring rubric are in
`princess-pi-packages/research/spec-reconcile-backtest/`. **Re-run it after any edit to §1,
§2's Tier 4, or §4** — those sections are measured artifacts now, not prose.

**Know what the re-run does and does not catch.** `run-backtest.sh` replays the *frozen*
`prompts/<round>/*.txt` files; it does not read this document. So editing §4's wording
changes nothing about a re-run's score, and a weakened §4 can post four-of-four forever.
Two consequences, both load-bearing:

- **Changing §4 means the CURRENT round's prompts change to match, by hand, in the same
  commit** — or, more usually, that you add a new round. Otherwise the corpus measures a
  skill that no longer exists.
  **Never retrofit a historical round.** Round 1 is *"the skill as written during #158"* and
  round 2 is the post-#163 wording as scored on 2026-08-10; §7's headline result — two of
  four, then four of four — is a before/after comparison and editing either side erases it.
  `RUBRIC.md` states the same constraint for their corpora.
- `tests/spec-163-spec-reconcile.test.ts` pins that the measured clauses still *appear* in
  this file. That catches a **deletion**; nothing catches a **weakening**. Neither the test
  nor the backtest is a wording regression detector, and treating either as one is how a
  skill quietly regresses to the version that scored 2 of 4.

**One invocation runs one round.** Re-measuring after a §1/§4 edit means all three:

Each round writes into its own tracked `runs/<round>/` and **refuses to overwrite a
completed run** (exit 4) — "completed" being what the harness can test: every declared
auditor ran and exited 0. Whether anyone *scored* it lives in the hand-authored
`SCORES.tsv`, which the harness never reads or writes. So a re-measurement writes to a
scratch directory and is diffed against the record — replace the record only once you have decided the new run supersedes it:

```
B=research/spec-reconcile-backtest/run-backtest.sh
S=$(mktemp -d)
ROUND=round1-as-written OUT=$S/round1-as-written $B   # F1-F4, skill as of #158, SHA 9b2a16e
ROUND=round2-fixed      OUT=$S/round2-fixed      $B   # F1-F4, post-fix,        SHA 9b2a16e
ROUND=round3-host-scope OUT=$S/round3-host-scope $B   # F5, Tier 4,             SHA bf4d104
# then score every $S/<round>/ against RUBRIC.md
```

**To adopt a scored run, promote the transcripts you scored** — never re-run to "make it
official", because a second run produces different transcripts than the ones you read:

```
R=research/spec-reconcile-backtest/runs/<round>
rm -f "$R"/*.md "$R"/STATUS.tsv      # NOT SCORES.tsv — see below
cp "$S"/<round>/* "$R"/
```

`SCORES.tsv` is **hand-authored** — `run-backtest.sh` writes only `*.md` and `STATUS.tsv`,
so a `cp` cannot restore it. Leave the old one in place and **edit it** to describe the
transcripts you just promoted; deleting it first leaves the round failing the suite's
"every non-grandfathered round ships both" check with no template to work from.

Then update `RUBRIC.md`'s result log to match. `tests/spec-163-spec-reconcile.test.ts`
asserts the counts in `SCORES.tsv`, `RUBRIC.md` and this file all agree, so forgetting one
fails the suite rather than shipping a record that contradicts itself.

`run-backtest.sh --help` carries the exit-code table. **Adopting a re-run destroys the
transcript the previous record cites** — the #383 run did exactly that and erased the
evidence behind issue #390, which is why the refusal exists.

If a fixture regresses, **fix the skill, not the score.** A miss is a finding about this
file.
