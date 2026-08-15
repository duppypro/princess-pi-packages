# ADR 0003 — The fleet baseline is declared in a file and advisory in effect

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** Duppy, Princess-Pi
- **Context repo:** duppypro/princess-pi-packages
- **Issues:** #288 (this decision), #228 / [ADR 0002](0002-ci-is-the-merge-gate.md) (the single-repo gate this generalises), #229 (the repo split this tooling will follow)

## Context

ADR 0002 made one repo's merge gate real. The question that followed was what to do about
the other 28, and the survey that preceded this decision changed the shape of the answer
twice.

**First correction: the baseline was already uniform.** An earlier count of "five repos have
rulesets" was measured over *locally cloned* repos only. Across the account, **all 17 public
non-fork repos already carry a ruleset named `protect-default-branch-owner-only`.** So there
was no propagation problem. There was a *tiering* problem: 16 carried
`deletion + non_fast_forward + update`, `princess-pi-packages` carried
`deletion + non_fast_forward + pull_request + required_status_checks`, and nothing recorded
that the split was intentional — because it wasn't.

**Second correction: nothing here binds anyone.** Every one of the 17 sets
`bypass_actors = [{RepositoryRole: 5 (admin), bypass_mode: always}]`, and the owner is admin
on all of them. The `BLOCKED → CLEAN` transition observed on PR #285 proved the required
check is *computed and surfaced*; it never proved the gate is unbypassable, because the
merge could have gone through red the whole time.

That reframes the deliverable. What is being built is not enforcement. It is a **signal that
is uniform, declared, and therefore readable** — and a way to notice when it stops being any
of those.

A third fact constrains the scope: 12 private repos created in 2026 have zero rulesets and
cannot have any, because private-repo rulesets need a paid plan. That is not a backlog item;
no amount of engineering closes it.

## Decision

**1. The baseline is declared in `docs/repo-policy.json`, and `bin/repo-gate` reports the
difference between what it declares and what GitHub holds.** Report-only: the tool never
writes. Each drift record carries a `remedy` — the literal command — derived from the same
tier definition the check reads, so the remedy and the verdict cannot disagree.

**2. `update` is retired fleet-wide in favour of `pull_request`.** `pull_request` subsumes
the one property `update` held (a non-bypass actor cannot update the ref); `deletion` and
`non_fast_forward` cover the rest independently. The tiers now differ in exactly one
dimension — the CI check — instead of two, and `tests/repo-policy.test.ts` asserts
`protected` remains a strict subset of `gated` so they cannot drift apart again.

**3. `bypass_mode: always` stays.** The owner keeps the override. This is the decision that
makes everything else advisory, and it is deliberate rather than incidental.

**4. Because of (3), the policy states what it does *not* enforce, and `repo-gate` prints
that disclosure on every run.** Not filed in a doc — printed, every time. An agent that
reads "protected default branch" and infers that a red check stops a merge has inferred
something false and will act on it. The bypass configuration is itself an asserted claim,
because it is the field that determines what every other claim in the report *means*.

**5. `plan-blocked` is a first-class tier, and a waiver rather than an exemption.**
`repo-gate` re-probes the account plan on every run; the day private rulesets become
available, those 12 repos go red on their own.

## Consequences

- The first run reports **16 drift rows**, not one. Those repos are compliant with the *old*
  shape. This is expected and is what `docs/repo-gate-apply.md` exists for.
- `tests/repo-policy.test.ts` deliberately **does not assert drift is zero.** Sixteen repos
  are knowingly mid-migration, and a suite that fails for a known-open task is a suite people
  learn to skip (#256's lesson, applied). It surveys and prints the count instead, and
  asserts only the properties that must hold today: coverage, accounting, and remedy presence.
- A repo created on GitHub and never added to the policy is reported as `unlisted` — drift,
  not silence. Creating a repo therefore forces a decision here.
- The plan probe is **indeterminate** with the current token: `/user` exposes `.plan` only
  with the `user` scope. Reported as indeterminate rather than folded into "free", because
  "I could not check" is not "I checked and it says no" — the same 5-vs-6 distinction the
  `pr-*` exit-code table draws.

## Roads not taken

**Narrow the bypass so the gate actually binds.** Considered and declined by Duppy. It would
make `repo-gate` a report about real enforcement, at the cost of being unable to merge when
CI is broken for reasons unrelated to the change. On a solo account the override is load-
bearing. The disclosure exists precisely because this road was not taken.

**Keep `update` alongside `pull_request`.** Would have preserved the 16 repos' current state
and cost nothing to leave alone. Declined because it keeps two rule shapes alive with no
recorded reason for the split, and every future reader has to re-derive whether the
difference means something.

**Apply the remedies automatically.** The fix rewrites access control on real repositories.
Report-only first, with the remedy strings shipped and under test, so that a future applier
executes commands that have already been read by a human several times.

**Report private repos as failures.** Would have made 12 of 29 rows permanently red for a
condition no engineering change can fix, which is how a report stops being read.

**Derive scope from a predicate instead of listing repos.** The policy lists both governed
and excluded repos by name. A predicate is shorter and would have silently dropped a repo
out of governance the moment its metadata changed; naming them makes that an edit someone
has to make on purpose.
