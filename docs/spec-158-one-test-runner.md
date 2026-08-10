# Spec 158 — One declared test runner, and the five things hiding behind "the tests fail"

**Issue:** #158
**Branch:** `158-one-test-runner`
**State:** Spec Draft

---

## 1. What was actually measured

Every claim below comes from running all 42 suites in `tests/` twice on `main` @ `9b2a16e`
— once with `node --experimental-strip-types <file>`, once with `bun test <file>` — and
recording exit codes. Not inferred from the issue body.

| Runner | Suites failing |
|---|---|
| `node --experimental-strip-types` (per file) | 10 |
| `bun test` (per file) | 3 |
| `bun test` (whole `tests/` directory, one process) | **runs 3 of 42 files, then exits 0** |

That last row is the finding the issue did not have, and it inverts the recommendation.

---

## 2. Root causes, corrected

The issue named four root causes. Measurement splits the fourth in two and adds a fifth
that outranks all of them.

### RC-0 (new, and the reason "declare `bun test`" is not enough) — plain scripts kill the in-process runner

34 of 42 suites are standalone scripts ending in `process.exit(failed > 0 ? 1 : 0)`.
Under `bun test <dir>`, all files share one runner process, so the **first** such suite to
finish tears the process down mid-run. On `main` that is
`tests/wtft-phase3-overhead.test.ts`, which exits 0 after 3 of 42 files:

```
$ bun test        # from the repo root
... 3 files ...
Results: 39 passed, 0 failed
$ echo $?
0
```

A green exit code that ran 7% of the suite is worse than the 10 red suites we started
with. Any single-process runner — `bun test`, `vitest`, `node --test` — has this problem
as long as the plain-script style exists. The fix is process-per-suite, not runner choice.

### RC-1 — `.js` specifiers into `.ts` sources (5 suites)

As the issue states. `node --experimental-strip-types` does not remap `.js` → `.ts`; bun
does. Affects `merge-step5-wording`, `rate-limiter-tpm-consolidation`, `serve-117-list`,
`serve-131-unit`, `serve-kill`. Confirmed: all five pass under bun.

### RC-2 — one suite is written for bun's runner (1 suite)

`git-guardrails-parity` imports from `bun:test`. It cannot run under node at all, and
needs `bun test <file>` rather than `bun <file>`. Passes: 106 pass, 212 `expect()` calls.

### RC-3 — missing dev dependency (2 suites)

`@earendil-works/pi-tui` is imported by four extensions and one test, and is in neither
`dependencies` nor `devDependencies`. It is published (`0.84.1`). `github-issue-autocomplete`
fails only under node; `session-name-display` fails under **both** runners.

### RC-4a (was "genuine assertion failure") — the developer's persisted config decides the test result

`wtft --tokens/--cost` is **config-persistable**. This machine's
`~/.config/princess-pi-packages/wtft.json` contains `"tokens": true`, so a CLI invocation
with no mode flag renders **token** mode. Two suites assume no-flag means **cost** mode:

- `wtft-auto-fit` searches output for `$0.00` — no `$` exists in token mode.
- `wtft-title-layout` asserts the cost-mode title is `💸 WTF Tokens?` — it renders `🔢`.

Isolating the config makes both go away:

```
$ T=$(mktemp -d); XDG_CONFIG_HOME=$T node --experimental-strip-types tests/wtft-auto-fit.test.ts
🎉 ALL AUTO-FIT AND COMPREHENSIVE TESTS PASSED PERFECTLY!     # exit 0
$ XDG_CONFIG_HOME=$T node --experimental-strip-types tests/wtft-title-layout.test.ts
Results: 26 passed, 6 failed                                  # was 25/7
```

So `wtft-auto-fit` is **not** a regression and needs **no bisect** — it is a hermeticity
bug in the harness. This is the one correction that matters most for effort estimation.

### RC-4b — a stale invariant, not a layout regression

The remaining 6 `wtft-title-layout` failures are all `timeline on title row (contains ◆)`.
`◆` is gone from the renderer. `buildTimelineString` (`extensions/lib/wtft-renderer.ts`)
now marks the current hour with a **clock-face emoji** (`🕐`…`🕚`), uses `☀️` for noon, and
bookends the whole timeline with a **moon phase** glyph:

```ts
const char = (isCurrent && h !== 12) ? CLOCK_FACES[h % 12] : (h === 12 ? "☀️" : "─");
...
let result = `${moon}${timelineBody}${moon}`;
```

The renderer moved on; the test did not. The function's own docstring (line ~695) also
still advertises the old `(---◆---)` format and is stale in the same way.

**The moon bookend is the durable invariant** — it is present unconditionally, whereas the
clock face depends on the wall-clock hour and disappears entirely at noon. The test should
assert on the bookend, not on the hour marker.

---

## 3. The fork

The issue framed this as a choice between three directions. RC-0 collapses it: the
plain-script style is incompatible with *every* single-process runner, so "pick a runner"
is not the decision. The decision is **how a suite is isolated from its neighbours**.

| Direction | What it commits to | What it makes easier | What it pulls toward |
|---|---|---|---|
| **A. Process-per-suite driver** (`tests/run.ts`, `bun run test`) | A ~60-line runner we own | Keeps all 42 suites exactly as written; one place to enforce hermeticity (config, tmpdir, timeout) | Owning a small piece of test infrastructure; suites stay individually runnable |
| **B. Rewrite 34 suites to `describe`/`expect`** | bun's runner as the only entry point | Real per-assertion reporting, filtering, `.only` | A 34-file mechanical rewrite touching every test in the repo; suites stop being standalone scripts |
| **C. Stay on node, fix the `.js` specifiers** | node as runner | No new tooling | Still cannot run `git-guardrails-parity` at all; does nothing for RC-0/RC-4a; diverges test imports from how production imports `extensions/lib/serve/*.js` |

**Recommendation: A.** It is the only direction that makes `bun run test` mean something
today, and it is the only one that gives RC-4a a single fix site instead of 42. B stays
available afterwards — A does not block it, and a suite converted to `describe`/`expect`
keeps working under A unchanged (the driver invokes `bun test <file>`, which handles both
styles).

**Road not taken:** running suites in parallel. Several spawn wtft daemons, bind ports, and
share `/tmp` fixture paths. Serial is the honest default until those are isolated.

---

## 4. Proposed change

1. **`tests/run.ts`** — the declared runner.
   - Discovers `tests/*.test.ts`, sorted, runs each in **its own process** via `bun test <file>`.
     (`bun test` handles both the plain-script and `describe`/`expect` styles; per-file
     invocation makes `process.exit(0)` harmless.)
   - Serial. Per-suite timeout (180s). Aggregates exit codes.
   - **Hermetic env**: sets `XDG_CONFIG_HOME` to a fresh temp dir for every suite so no
     developer config can decide a result (RC-4a), and removes it afterwards.
   - Prints a one-line-per-suite PASS/FAIL table plus a final count; exits non-zero if any
     suite failed.
   - Accepts an optional substring filter: `bun run test wtft-title` runs matching suites.
2. **`package.json`** — add `"test": "bun tests/run.ts"`, and add
   `@earendil-works/pi-tui` to `devDependencies` (RC-3).
3. **`tests/wtft-title-layout.test.ts`** — pass `--cost` explicitly for the cost case
   (belt-and-braces with the runner's config isolation, and it documents intent), and
   replace the `◆` invariant with the moon-phase bookend (RC-4b).
4. **`extensions/lib/wtft-renderer.ts`** — correct the stale `(---◆---)` docstring to
   describe the glyphs the function actually emits. Comment only; no behaviour change.
5. **`docs/agents/build-and-toolchain.md`** — document `bun run test` as *the* way to run
   tests, why it is process-per-suite, and the rule that a suite must not depend on
   `~/.config`.

### Deliberately not in scope

- The 2 standing `TS7016` errors on `extensions/lib/serve/cloudflare.js` (needs a `.d.ts`
  or a `.ts` port — separate issue).
- Rewriting the 5 `.js` → `.ts` test specifiers. Under the declared runner they resolve
  correctly. Changing them is a follow-up worth doing only alongside a decision about
  whether `extensions/lib/serve/*.js` stays JavaScript.
- Suite-leaked `/tmp/wtft-*` fixture dirs. `wtft-title-layout` *does* `rmSync` its fixture;
  a lingering daemon recreates `wtft-tags/` inside it afterwards. Real, but a daemon
  lifecycle bug, not a test-runner bug. 12 such dirs were found on this machine.
- `wtft-daemon-lifecycle` — fixed by #157, passes on `main` today.

---

## 5. Spec gate — how this is verified

The success condition is a single command and a single number.

| # | Check | Expected |
|---|---|---|
| V1 | `bun run test` | All 42 suites PASS, exit 0 |
| V2 | `bun run test` suite count | Reports **42** suites, not 3 — guards RC-0 from regressing |
| V3 | `bun run test wtft-title` | Runs only matching suites, exit 0 |
| V4 | With `"tokens": true` set in the real user config, `bun run test wtft-auto-fit wtft-title-layout` | PASS — proves RC-4a hermeticity holds |
| V5 | Deliberately break one assertion in one suite, run `bun run test` | Exit non-zero, that suite listed FAIL, others still reported |
| V6 | `bun run typecheck` | No new errors beyond the 2 known `TS7016` on `cloudflare.js` |
| V7 | `bun run build` | Succeeds; no generated `.mjs` edited by hand |

V5 is the one that matters most: it is the direct test of the failure mode RC-0 describes
— a runner that reports success without having run the tests.

---

## 6. Open questions for Duppy

1. **Direction A confirmed?** Owning a ~60-line `tests/run.ts` versus rewriting 34 suites
   into `describe`/`expect` (B). A is reversible and does not block B.
2. **Config isolation in the runner, or in each suite?** Runner-level is one seam and
   covers all 42; suite-level is explicit but must be remembered 42 times. Proposal is
   runner-level, with `--cost` also made explicit in the one suite whose intent it clarifies.
3. **`@earendil-works/pi-tui` as `devDependency`, or stub it?** It is harness-provided at
   runtime, so it is not a real `dependency`. Proposal: `devDependencies` — it is published,
   and a stub would drift from the real API.

— 👑π🐱 Princess Pi
