---
name: spec-reconcile
description: Find and FIX every readable artifact that contradicts the actual code — specs, manifests, --help text, error messages, README, docstrings, test header comments. Runs fresh-context auditors that must quote code, then applies the corrections and re-verifies until a pass finds nothing new. Use at Step 5 of the 5-step flow ("Code and Spec Approved"), or when the user says "reconcile the spec", "step 5", "bring the docs up to date with the code", "does the spec still match", or before answering "ready to merge?".
---

# Spec Reconcile

> **Where this file lives.** The copy in `princess-pi-packages/skills/spec-reconcile/SKILL.md`
> is the **source of truth**. `~/.claude/skills/spec-reconcile/SKILL.md` is a **downstream
> deploy copy** — edit the repo copy, then copy it out to `~/.claude`. Never the reverse.
> If the two differ, the repo copy wins; the dotfile has no history to lose. The backtest
> corpus and harness that keep §4 honest live in the same repo (`research/spec-reconcile-backtest/`),
> which is why the skill lives there rather than in `dotfiles`.

Step 5 of the 5-step flow says: *update the Spec artifacts to perfectly mirror the
tested Code*. "Perfectly mirror" is unfalsifiable — you cannot fail it, so you cannot
finish it either. This skill replaces that with something checkable.

## The rule this exists to enforce

**Any readable artifact that contradicts the code is a landmine.** The next agent or
human gets the spec, the `--help` text, or the comment — and has no way to know it lost
a race with the code. Whichever they read first becomes their source of truth, and they
build on it. One stale sentence compounds.

So the bar is not "the spec looks right." It is **zero known contradictions left
standing**, across every artifact a reader might reach.

## The inversion — this is why it gets missed

Every other review in the flow checks **code against spec**: *did we build what we said?*
Step 5 is the opposite: **spec against code**: *does every claim we wrote still hold?*

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

## 2. Artifact classes — three tiers, checked three different ways

Not every artifact is reachable the same way. Sort them before auditing, or you will
either miss the unlinkable ones or waste passes on ones that cannot drift.

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
`buildTimelineString` docstring but pasted the corrected text four declarations too early,
so it bound to `MOON_PHASES` and the function shipped undocumented. A re-audit of the
artifact just edited catches that class of error; nothing else does.

## 4. The audit pass — fresh context, must quote code

Dispatch auditors with **no session history**. This is the whole point: you cannot catch
*"I assumed the help text was authoritative"* from inside the head that assumed it. A
reviewer sharing your context inherits your blind spot.

Sub-agents work. Separate `claude -p` **processes** work better and are the fallback when
the harness has no agent-dispatch tool — a fresh process cannot inherit your assumptions
even accidentally.

Fan out one auditor per changed source file (subject to §1's granularity rule), plus one
for the spec document. Set the model explicitly on every dispatch — this is judgment work,
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
| `wtft-renderer.ts:694` | timeline renders `(---◆---)` | clock faces, `☀️` at noon, moon bookends — `:744` | ✅ `wtft-title-layout.test.ts` | Fixed in this commit |

Every row is checkable by a third party. "Reviewed the docs" is not.

The coverage column is the skill's own honesty check. A row marked
`reconciled-against-untested` means the doc now matches code that nothing verifies —
still the right fix, but a lead for the test process. Count them; a run producing many is
reporting a coverage hole, not a documentation one.

Step 5 commits change **specs, comments, and spec-supporting artifacts only** — no
production code. If the audit turns up a code finding (§5), it does not belong in this
commit.

`merge-checklist`'s "spec reconciled" gate is satisfied when this record exists and shows
no open contradictions — not when someone remembers re-reading the spec.

## 7. Validating this skill — backtested, and re-runnable

A skill that sounds rigorous and finds nothing is worse than no skill.

**Backtest ran 2026-08-10 (`princess-pi-packages#163`)** against four real drifts frozen
at SHA `9b2a16e`. The version of this skill written during #158 **surfaced two of four.**
Every fix in §1, §3, §4, and §5 above is traceable to one of those two misses; the record
with per-fixture attribution is `docs/spec-163-spec-reconcile-backtest.md` §9. The
corrected prompts surfaced four of four, including two drifts still live on `main` that
#158's hand-run had missed.

The corpus, the prompts as run, and the scoring rubric are in
`princess-pi-packages/research/spec-reconcile-backtest/`. **Re-run it after any edit to §1
or §4** — those two sections are measured artifacts now, not prose:

```
research/spec-reconcile-backtest/run-backtest.sh    # then score against RUBRIC.md
```

If a fixture regresses, **fix the skill, not the score.** A miss is a finding about this
file.
