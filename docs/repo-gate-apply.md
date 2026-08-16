# Applying repo-gate drift — an instruction prompt for an agent

`repo-gate` reports; it never writes. This file is the other half: what to do with a
red row. It is written to be handed to an agent verbatim.

Everything below assumes you were pointed here by Duppy in the live session. Being
told to read this file is not the same as being told to run it — see **Authorisation**.

---

## What you are doing

Bringing a repo's live branch-protection ruleset into line with the declared baseline
in `docs/repo-policy.json`. That is one `gh api` call per repo, using a payload the
tool generates. You are not designing the ruleset; the policy already did.

## Preconditions — check, do not fix

Check each. If one fails, stop and say which. Do not repair a missing precondition
silently: a broken precondition usually means the caller skipped a step, and papering
over it hides that forever.

1. `repo-gate --help` runs. If not, it is not on PATH — `bin/install-workflow-tools`.
2. `gh auth status` reports an authenticated account. On a host with a stale
   `GH_TOKEN` exported, every `gh` call fails with `Bad credentials` even though the
   keyring is fine; prefix with `env -u GH_TOKEN -u GITHUB_TOKEN`.
3. `repo-gate` finds a policy — it prints the path it used on the first line.

## The loop

**Step 1 — read the report, whole.**

```
repo-gate --json
```

Exit `0` means nothing to do; you are finished. Exit `6` means drift. Exit `5` means
part of the fleet could not be read — that is *not* "the rest is fine", and you must
say which repos were unreadable before doing anything else.

Work only from `.repos[] | select(.status == "drift")`. Ignore `n/a` rows entirely.

**Step 2 — get the payload from the tool, never from your head.**

```
repo-gate --remedy <repo>
```

This prints a comment line and one command. Do not hand-author a payload, and do not
edit the one you are given. The payload is derived from the same tier definition the
check reads, which is the only reason the remedy and the verdict cannot disagree. A
hand-edited payload breaks that and you will have no way to know.

If the tier is `plan-blocked`, the remedy is `none`. Do not attempt a write.

**Step 3 — confirm before the first write.** See **Authorisation**.

**Step 4 — run the command exactly as printed.**

Note that `PUT` **replaces** the entire ruleset, not just the rules that differ. That
is intended: the payload carries the full declared state including `bypass_actors`.
It also means any rule someone added out-of-band is removed. `repo-gate` reported
those as `unexpected rule:` in step 1 — if you saw one and it looked deliberate, stop
and ask rather than deleting it.

**Step 5 — verify, per repo, immediately.**

```
repo-gate <repo>
```

Expect `ok` and exit `0`. Anything else: stop, report what it said, do not retry.

**Step 6 — repeat.** When the last one is done, run a bare `repo-gate` and confirm
`drift=0`.

---

## Authorisation

These writes are outward-facing and change access control on real repositories.

- Get an explicit go-ahead from Duppy before the **first** write of a session. A
  batch approval ("do all sixteen") covers the batch; it does not carry to a later
  session or to a repo that was not in the report you showed him.
- `princess-pi-packages` is tier `gated`, not `protected`. Never apply a `protected`
  payload to it — that silently removes the required CI check. `--remedy` gets this
  right on its own, which is another reason not to hand-author.
- Never widen `bypass_actors`. The declared value is `RepositoryRole 5, always` and it
  is deliberate (see `enforcement_disclosure` in the policy). Narrowing it is a
  separate decision that belongs to Duppy, not to a drift fix.

## What is not an apply

Three statuses look like drift and are not fixed by an API call:

| status | meaning | what to do |
|---|---|---|
| `unlisted` | in scope by the policy's own rule, absent from its `repos` map | edit `docs/repo-policy.json` — add it with a tier, or add it to `scope.excluded` with a reason |
| `gone` | declared in the policy, not present on the account | edit the policy, or find out who deleted the repo |
| `error` | state could not be determined | nothing. Report it. An unreadable repo is not a compliant one |

Never resolve a red row by adding the repo to `scope.excluded` to make the report
green. Exclusion means "governance does not apply here", and using it as a silencer
turns the file from a policy into a list of things that happened to pass.

## Failure modes

- **422 Unprocessable** — GitHub rejected the payload. Do not mutate it and retry.
  Report the message; it usually means the policy declares something this repo cannot
  have.
- **403 Forbidden** — either the token lacks `admin:repo` scope, or the repo is
  private on a plan without rulesets. If it is the latter, the repo is mis-tiered:
  it belongs in `plan-blocked`.
- **404** — the ruleset id in the remedy no longer exists (someone deleted it between
  your report and your write). Re-run `repo-gate --remedy <repo>`; it will emit a
  `POST` instead.

## Stop and ask when

- Any repo reports `error`, at any point.
- The plan probe reports `expired` — private-repo rulesets have become available and
  twelve repos need tiering decisions, which is a policy change, not a drift fix.
- A repo has an `unexpected rule:` you did not expect to be removing.
- More than two consecutive writes fail.

## What this does not achieve

Applying every remedy does not make anything enforced. Every governed repo grants the
owner bypass `always`, so a PR can show `BLOCKED` and still merge. What you are
restoring is a *signal* that is uniform and therefore readable. Do not report the
result as "the fleet is now protected" — report it as "the fleet now matches the
declared baseline", which is the true and much smaller claim.
