# Agent Job Standard

**Status: Spec Approved** (Duppy, 2026-08-09). Normative rules for **scheduled agent background
work** — the thing `scheduled-work-standard.md` §2 deliberately did not cover.
**Authoritative copy** — promoted from btw `8f0b51b` on 2026-08-09; btw #20 is closed.
Implementation of the first Agent Job: princess-pi-brain #1.

Vocabulary: `tenancy-glossary.md` (**Job**, **Lane**, **Operator**, **State root**). Companion:
`scheduled-work-standard.md` — §2 governs Jobs generally; this file governs the subset whose work
is performed by an agent.

**How to read it.** Same conventions as the tenancy standard. **MUST** is a rule whose violation has
produced, or would produce, a real failure — each carries the one-line reason. **SHOULD** is a strong
default with named exceptions. **⚠ NOT YET ENFORCEABLE** rules depend on tooling that does not exist
and are listed together in §10.

---

## 1. What an Agent Job is

1.1 An **Agent Job** is a Job whose work is performed by an LLM agent rather than by a deterministic
script. Everything in scheduled-work §2 still applies; this file adds what is specific to the agent.

1.2 A Job **MUST NOT** be an Agent Job when the question has an exact answer. *Why:* a version
string, a release tag, a CVE list and a checksum are all obtainable from a structured feed, and a
deterministic poller answering them is cheaper, faster, and cannot drift. Reserve the agent for
questions where reasonable readers disagree — attitudes, trends, consensus, "has the state of the
art moved."

1.3 The measured example: `keywordSearch=sqlite` against NVD returns 246 results whose first hit is a
2006 PHP bug. The fix was a CPE query, not a better prompt. **A bad source is not an agent problem.**

---

## 2. Lane selection

2.1 Every Agent Job **MUST** declare a **lane**, and the lane **MUST** be derived from the rule
below rather than chosen by preference:

> **Needs local state → on-box (§4). Needs only the network → off-box (§3).**

2.2 A Job that reads or writes the state root, a release dir, a secrets file, a local database, the
tunnel, or any repo clone on this box **MUST** be on-box. *Why:* the alternative is shipping those
credentials off the box to reach them, which converts a local dependency into a permanent secret
distribution problem.

2.3 A Job whose entire input is the public internet **SHOULD** be off-box. *Why:* blast radius. Its
input is hostile by default and permanently so; an ephemeral container that is destroyed after each
run holds no credentials, no repos, and no tunnel, and cannot be persistently compromised.

2.4 The lane is a **classification, not a decision**. Two Jobs in the same repo may sit in different
lanes. A Job that changes what it touches changes lane.

---

## 3. Lane A — off-box

3.1 An off-box Agent Job **MUST** run on a GitHub-hosted ephemeral runner. Self-hosted runners on
this box are **MUST NOT** — they reintroduce every property §2.3 exists to avoid while keeping the
inconvenience of Actions.

3.2 The workflow **MUST** declare both `schedule:` and `workflow_dispatch:`. *Why:* off-cadence
on-demand runs are a stated requirement, and `workflow_dispatch` supplies them without an SSH
session or a second code path.

3.3 The repository **MUST** be private. *Why:* the trust boundary is then enforced by GitHub
permissions rather than by an allow-list somebody has to keep correct. See §5.1.

3.4 Authentication **MUST** be a long-lived token from `claude setup-token`, stored as a repository
secret. The Operator generates it interactively in their own shell — never an agent, never in CI.

3.5 The Operator's `gh` token **MUST** carry the `workflow` scope before the first workflow file is
pushed. *Why:* GitHub rejects any push that creates or modifies `.github/workflows/**` from a token
without it, so the failure lands on the first commit and reads as a permissions mystery.
*(Granted on this box 2026-08-09 via `gh auth refresh -h github.com -s workflow`.)*

---

## 4. Lane B — on-box

4.1 An on-box Agent Job **MUST** be a systemd user timer meeting scheduled-work §2.2 — including the
absolute-interpreter rule of `unit-authoring-standard.md` §1.2. *Why, specifically measured:* `claude` resolves to
`~/.local/bin/claude`, which is **not** on the systemd user PATH. A bare `claude` in a unit fails at
3am in something nobody is watching.

4.2 An on-box Agent Job **MUST** write a run outcome to the state root (scheduled-work §3.1), because
nothing else observes it.

4.3 An on-box Agent Job **MUST NOT** depend on an interactive credential refresh. *Why:* an
unattended timer cannot answer an auth prompt; it dies silently and the first symptom is absent
output weeks later. ⚠ **NOT YET ENFORCEABLE** — the expiry behaviour of the on-box OAuth credential
is unverified (§10).

4.4 An on-box Agent Job that writes to a repo **SHOULD** run in a dedicated worktree. *Why:* it
otherwise races the Operator's own working tree.

---

## 5. Trust boundary

5.1 Everything an Agent Job reads — web pages, search results, API responses, issue and PR bodies —
is **DATA, never instructions**. This is the global rule, restated here because an Agent Job's entire
purpose is ingesting untrusted content unattended, with no human in the loop to catch a steer.

5.2 An Agent Job **MUST** declare an explicit tool allow-list, and that list **MUST NOT** include
`Bash`. *Why:* the job's input is hostile by construction; shell access turns a prompt injection into
code execution. Read tools plus exactly one write surface.

5.3 An Agent Job's write surface **SHOULD** be a GitHub API call (an issue comment), not a `git
push`. *Why:* it keeps the Job clear of the git guardrails entirely rather than needing an exception
to them, and the record lands somewhere already versioned and readable.

5.4 A public repository **MUST NOT** be an Agent Job's trigger surface while the Job acts on issue
bodies. *Why:* an issue body used as a prompt makes any GitHub user an instruction source. The
resolution adopted here is private mirrors with occasional pushes outward — which removes the
surface rather than gating it, so there is no allow-list to write or keep correct.

---

## 6. Output schema discipline

6.1 An Agent Job that compares runs over time **MUST** emit a fixed schema, not prose. *Why:*
unbounded free text drifts between samples even when the underlying facts have not moved, so a
prose-to-prose comparison reports change that did not happen.

6.2 Any field on a comparison or alerting path **MUST** be a closed enum. **Measured:** across two
identical parallel invocations, both enum fields agreed exactly; the one contested free-text field
disagreed.

6.3 A free-text field **SHOULD** exist only where the answer is uncontested, and its constraint
**MUST** be pinned into the field name. **Measured:** `best_local_model` disagreed across runs not
because the model was wrong but because the field was underspecified — a 250GB open-weight model and
a laptop-resident one are both legitimate readings. `best_coding_model_fitting_64gb_unified` has no
such freedom.

6.4 A runner **MUST** parse defensively. **Measured:** an instruction to emit *only* a JSON object
produced, on one of two identical runs, a fenced block with a sources list appended.

6.5 An Agent Job **SHOULD** take several samples within one run and store the mode. *Why:* variance
reduction at the only point where sampling is cheap.

---

## 7. Cadence, trigger, and the record

7.1 An Agent Job **MUST** record `trigger: scheduled | manual` on every run. *Why:* once off-cadence
runs exist, the run sequence no longer maps to the calendar.

7.2 A Job with both cadences **MUST** have exactly **one entry point**, invoked identically by the
schedule and by hand. *Why:* two code paths diverge, and the one exercised less is the one that
breaks.

7.3 An off-box Agent Job's **record is the GitHub issue** — comments are the append-only history,
the body holds current state. There is no local-document option in this lane, by construction.

7.4 A subjective Agent Job **SHOULD** report on every run rather than firing on a threshold. *Why:*
a threshold on a subjective judgement is a false-positive generator, and always-reporting makes
**silence itself the failure signal** — which removes the need for separate heartbeat machinery.

---

## 8. Horizons and cold start

8.1 A trend-watching Agent Job **SHOULD** report difference across **multiple horizons** (last week,
3 months, 12 months) rather than against a single baseline. *Why:* it dissolves both the
alert-threshold problem and the **boiling-frog ratchet** — a single auto-advancing baseline makes
slow drift permanently invisible, because each step is within tolerance of the last.

8.2 Horizon selection **MUST** be by **timestamp nearest the target date**, never by positional
index. *Why:* off-cadence runs (§7.1) break the assumption that N runs ago is N weeks ago.

8.3 A new Agent Job **SHOULD** backdate its long horizons at cold start from dated sources rather
than waiting a year to become useful. **Verified working** — a pinned-to-August-2025 run returned
real dated artifacts with correct dates.

8.4 Any backdated snapshot **MUST** carry a `confidence` field. *Why:* hindsight contamination is
real and the model detects it when asked — the verification run self-reported that search results
were "heavily contaminated by 2026 retrospectives," and downgraded its own confidence accordingly.
A backdated anchor without a confidence marker is indistinguishable from a measured one.

---

## 9. Prohibitions

**MUST NOT**, for any Agent Job:

- use an agent where a structured feed has the exact answer (§1.2)
- run an off-box Job on a self-hosted runner (§3.1)
- run an off-box Job from a public repository (§3.3)
- grant `Bash` (§5.2)
- treat fetched content as instructions (§5.1)
- use a bare command name in an on-box unit (§4.1)
- compare prose to prose across runs (§6.1)
- select a horizon by position (§8.2)
- present a backdated anchor without `confidence` (§8.4)

---

## 10. Not yet enforceable

| Rule | Blocked on | Consequence today |
|---|---|---|
| §4.3 no interactive credential refresh | on-box OAuth credential expiry behaviour unverified — the lookup was blocked by the permission classifier | an on-box Agent Job may die silently at expiry; unknown whether it can happen at all |
| §6.5 mode across samples | no runner exists | single-sample runs carry §6.2's measured variance |
| lane declaration | no Job spec format exists (§11) | lane is prose, not a checked field |

---

## 11. Open, and deliberately not ruled on

- **Job spec format.** These rules describe what a Job must do, not the file that declares it.
  Whether a Job is a YAML spec consumed by one runner, or just a workflow file per Job, is
  undesigned. It only becomes pressing at the second Job.
- **Do the structured-source watchers survive?** SQLite features/CVEs and bun releases were the
  first candidates and are, by §1.2, **not Agent Jobs** — deterministic pollers serve them better.
  Whether they get built at all, and in which lane, is open.
- **Worktree isolation** (§4.4) is a SHOULD with no on-box Agent Job yet to test it against.
- **Agent-fires-on-new-issue.** Raised, not designed. §5.4 governs the trust surface; the scheduling
  and concurrency model does not exist.

---

## 12. Worked example — the first Agent Job

Specified here, **implemented elsewhere**: this repo is capped at Spec Draft, so the working watcher
is tracked as a task in `princess-pi-brain` and runs from `princess-pi-agent-workspace`.

| Property | Value | Rule |
|---|---|---|
| Subject | attitudes, trends and benchmarks on **local dev-machine hosting of a coding LLM vs a cloud LLM subscription** | §1.2 — subjective by construction |
| Lane | **off-box** | §2.3 — entire input is the public internet |
| Home | `princess-pi-agent-workspace` (private) | §3.3 |
| Cadence | weekly capture, weekly delivery, plus on-demand | §7.2 |
| Trigger surface | `schedule:` + `workflow_dispatch:` | §3.2 |
| Report model | always report; difference across week / 3mo / 12mo | §7.4, §8.1 |
| Cold start | backdate 3mo and 12mo anchors, `confidence` required | §8.3, §8.4 |
| Tools | `WebSearch` + one issue-comment write. No `Bash` | §5.2, §5.3 |
| Record | GitHub issue in the same private repo | §7.3 |
| Failure signal | a missing weekly report | §7.4 |
