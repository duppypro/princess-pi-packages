# Spec 158 — One declared test runner, and the six things hiding behind "the tests fail"

**Issue:** #158
**Branch:** `158-one-test-runner`
**State:** Spec Approved (Duppy, 2026-08-09)

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

The issue named four root causes. Measurement splits the fourth in two, adds RC-0 ahead of
all of them, and — during spec review — turned up RC-5 underneath RC-4a's fix. Counts below
(42 suites, "3 of 42") describe `main` @ `9b2a16e` as measured; the branch ends at 43 with
`config-persistence` added.

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

### RC-5 — the config WRITE path ignores `XDG_CONFIG_HOME` (found during spec review)

Duppy's review asked whether isolating `XDG_CONFIG_HOME` could leak, and whether passing
options as args might instead persist them. Chasing both produced a product bug that
undercuts RC-4a's fix:

`loadConfig` (read) resolves through `$XDG_CONFIG_HOME`. `getConfigPaths` (used by
`writeConfig` and `hasConfig`) hardcoded `homedir()/.config`. So reads and writes targeted
**different files** on any machine with XDG set. Two consequences:

1. **User-facing:** a setting persisted by `/wtft --cost` is written to `~/.config` but read
   back from `$XDG_CONFIG_HOME` — the preference appears not to stick.
2. **For this issue:** the runner's per-suite `XDG_CONFIG_HOME` protects reads but **not
   writes**. Any test reaching a `writeConfig` call rewrites the developer's real config,
   however carefully it isolated itself. Confirmed the hard way — an early draft of
   `tests/config-persistence.test.ts` flipped this machine's live `tokens` and added
   `disabledEmoji` before the gate existed.

Both paths now resolve through one `xdgConfigHome()` helper, read at call time.

The answers to the two review questions, measured:

| Question | Answer |
|---|---|
| Does the runner's `XDG_CONFIG_HOME` leak to other shells or agents? | **No.** It is set in the `env` option of `spawnSync`, so only that child process tree sees it. Parent `XDG_CONFIG_HOME` is unset before and after a run; temp dirs are removed (0 left behind). |
| Does passing options as args persist them as a side effect? | **Not through the CLI** — `bin/wtft.mjs` only reads config; verified byte-identical after `--cost`, `--tokens`, `-i 3h -l 7`. **Yes through the Pi extension** — `/wtft --cost`/`--tokens`/`--no-emoji` call `writeConfig` by design. |

So the two mechanisms are complementary, not alternatives, and both are kept: explicit args
state intent at the call site and make a suite correct standalone; runner isolation is what
stops a suite that reaches the extension's write path from destroying real settings.

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
   `@earendil-works/pi-tui` to `devDependencies` at the **`latest`** dist-tag, not a caret
   pin (RC-3). `@earendil-works` owns the harness, so `pi-tui` *is* the extension API and
   should track it; `^0.84.1` means `>=0.84.1 <0.85.0` for a `0.x` version, which would hold
   the repo on 0.84.x while the harness moved on — typechecking extensions against an older
   API than they run under. `bun.lock` still pins the resolved version; refresh with
   `bun update --latest @earendil-works/pi-tui`.
3. **`tests/wtft-title-layout.test.ts`** — pass `--cost` explicitly for the cost case
   (belt-and-braces with the runner's config isolation, and it documents intent), and
   replace the `◆` invariant with the moon-phase bookend (RC-4b).
4. **`extensions/lib/wtft-renderer.ts`** — correct the stale `(---◆---)` docstring to
   describe the glyphs the function actually emits. Comment only; no behaviour change.
5. **`docs/agents/build-and-toolchain.md`** — document `bun run test` as *the* way to run
   tests, why it is process-per-suite, and the rule that a suite must not depend on
   `~/.config`. Plus the `pi-tui` range rationale and the config read/write symmetry.
6. **`extensions/lib/config.ts`** — one `xdgConfigHome()` helper, read at call time, used by
   both `loadConfig` (read) and `getConfigPaths` (write) so they can never diverge (RC-5).
7. **`tests/config-persistence.test.ts`** (new) — covers the WRITE side of the config seam,
   which nothing covered before. Three properties: the CLI never writes; the extension does
   persist the flags documented as "Config-persistable"; `writeConfig` merges rather than
   clobbers. It sets its own temp `XDG_CONFIG_HOME` rather than trusting the runner's — a
   suite about config writes is the last place to rely on someone else's isolation — and it
   carries a **safety gate**: if the resolved write target is not inside that temp root, the
   write checks fail *unrun* with the reason, instead of mutating real settings.

### Deliberately not in scope

`wtft-daemon-lifecycle` — fixed by #157, passes on `main` today. Everything else set aside
is listed with its reason in §8.

---

## 5. Spec gate — verified

The success condition is a single command and a single number. Results below are from the
Code Approved commit `562f24f`, run against the code at `e0d8f20`.

| # | Check | Expected | Result |
|---|---|---|---|
| V1 | `bun run test` | All 43 suites PASS, exit 0 | ✅ 43 passed, 0 failed |
| V2 | `bun run test` suite count | Reports **43**, not 3 — guards RC-0 | ✅ 43 (bare `bun test` still stops at 3) |
| V3 | `bun run test <filter>` | Runs only matching suites, exit 0 | ✅ 1 suite matched, exit 0 |
| V4 | The two config-sensitive suites, standalone under the real user config, **no** runner isolation | PASS — proves RC-4a is fixed at the call site, not just papered over | ✅ all three exit 0 |
| V5 | Deliberate failing probe suite | Exit non-zero, that suite FAIL, others still reported | ✅ exit 1; 2 PASS + 1 FAIL, output dumped |
| V6 | `bun run typecheck` | No new errors beyond the 2 known `TS7016` | ✅ exactly those 2 |
| V7 | `bun run build` | Succeeds; no generated `.mjs` hand-edited | ✅ clean `git status` after |
| V8 | `md5sum ~/.config/princess-pi-packages/wtft.json` before/after a full run | **Identical** — the suite cannot mutate real settings (RC-5) | ✅ `e11a5502…` both times |
| V9 | Parent `XDG_CONFIG_HOME` before/after; `/tmp/pp-test-config-*` count | Unset both times; 0 left behind | ✅ unset, 0 |

V5 is the one that matters most: it is the direct test of the failure mode RC-0 describes
— a runner that reports success without having run the tests.

V4 came out stronger than specified. The live config at verification time carried
`"interval": "7t"`, `"limit": 17`, `"tokens": false` — a config differing from every suite's
assumption on all three axes — and all three suites still passed standalone, because each
states its mode explicitly rather than inheriting it.

`"7t"` is **valid**: `parseInterval` accepts a turn unit (`t`/`turn`/`turns`, #121, covered
by `tests/wtft-issue-121.test.ts`) alongside `m|h|d|w`. The manifest driving `--help`
documents only `<size><m|h|d|w>` and never mentions it — a documentation gap, noted in §8.

---

## 6. Review — questions and answers

**1. Direction A** — **confirmed** by Duppy, 2026-08-09.

**2. Config isolation: runner env, or explicit args?** — Duppy asked whether changing
`XDG_CONFIG_HOME` leaks into other agents or shells, and whether explicit args would instead
persist options as a side effect. Measured answers are in RC-5 above: **no leak** (it is a
`spawnSync` `env` option, invisible to the parent and to any other process), and **no
persistence through the CLI** (which is read-only) though **yes through the Pi extension**.

Resolution: **keep both, they are complementary.** Explicit args make a suite correct
standalone and state intent where a reader will look; runner isolation is the backstop for
any suite that reaches the extension's write path. Chasing the question also surfaced RC-5,
which had to be fixed for runner isolation to mean anything at all on the write side.

**3. `@earendil-works/pi-tui`** — Duppy: whichever option keeps extensions current with the
published latest from `@earendil-works`, the harness owner and therefore the extension API
owner. Resolution: **`devDependencies` at the `latest` dist-tag**, not a caret pin — see §4.2
for why `^0.84.1` would have frozen the repo inside 0.84.x. Not a stub: a stub would drift
from the real API, which is the opposite of the stated intent.

**4. Scope expansion into production code (flagged, not asked).** RC-5's fix touches
`extensions/lib/config.ts` — production code, and a behaviour change for anyone with
`XDG_CONFIG_HOME` set (writes move from `~/.config` to the XDG root, matching where reads
already came from). It is kept in this issue rather than split out because runner isolation
is a claim this repo cannot honestly make while the write path ignores XDG: without it, §4.1
is documentation of a protection that does not exist. No impact on this machine, where
`XDG_CONFIG_HOME` is unset and both paths resolve to `~/.config` either way.

## 7. Coverage still missing, named

- The extension write-path suite drives the `/wtft` handler with a permissive mock and wraps
  the call, because the render path after `writeConfig` needs a live Pi TUI. The assertion is
  what landed on disk, not how far the handler got. Rendering is covered by other suites, but
  no suite exercises the handler end-to-end.
- `serve` and `tpm` also call `writeConfig`. Only `wtft` is covered here.
- The 2 `.test.sh` suites are not driven by `tests/run.ts` (they need sudo or a live nginx).
  The runner prints their names at the end of every run so the gap stays visible rather than
  reading as coverage.

---

## 8. Follow-ups this issue found but did not fix

| Finding | Why not here |
|---|---|
| **`--help` omits the turn interval unit.** `parseInterval` accepts `<n>t` / `<n>turn` / `<n>turns` (#121), but `docs/manifests/wtft-cmd.json` documents `-i, --interval <size><m\|h\|d\|w>` only, so `--help` never reveals it. A working feature is invisible. | Manifest copy, orthogonal to the test runner. Found via V4's live config carrying `"interval": "7t"` — which I first misread as invalid *because* the help text says it is. |
| **2 standing `TS7016`** on `extensions/lib/serve/cloudflare.js`. | Needs a `.d.ts` or a `.ts` port. |
| **5 test files import `.js` specifiers into `.ts` sources.** | They resolve under the declared runner. Worth changing only alongside a decision about whether `extensions/lib/serve/*.js` stays JavaScript. |
| **Leaked `/tmp/wtft-*` fixture dirs.** `wtft-title-layout` *does* `rmSync` its fixture; a lingering daemon recreates `wtft-tags/` inside it afterwards. 12 found on this machine. | Daemon lifecycle bug, not a test bug. |
| **Parallel suite execution.** | Several suites spawn daemons, bind ports, and share `/tmp` fixture paths. Serial (~40s total) until those are isolated. |

---

## 9. Reconciliation record (Step 5)

Blast radius: every source file this branch touched — `extensions/lib/config.ts`,
`extensions/lib/wtft-renderer.ts`, `package.json`, `CLAUDE.md` — and every readable
artifact asserting behaviour about anything in them. Produced by hand; the
`spec-reconcile` skill was written from this run.

| Artifact | Claim | Contradicted by | Test-covered? | Action |
|---|---|---|---|---|
| `wtft-renderer.ts:694` (docstring) | timeline renders `(---◆---)` | clock faces, `☀️` at noon, moon bookends — `:744` | ✅ `wtft-title-layout` | Fixed, `ce3c51d` |
| `tests/wtft-title-layout.test.ts` (header) | `◆` is the timeline invariant | same | ✅ same suite | Fixed, `ce3c51d` |
| `docs/manifests/wtft-cmd.json:114` | `--interval <size><m\|h\|d\|w>` | `parseInterval` also accepts `t`/`turn`/`turns` — `wtft-renderer.ts:157` | ✅ `wtft-issue-121` | Filed **#160** — manifest copy, out of this branch's scope |
| `config.ts` (`getConfigPaths` docstring) | global path is `~/.config/...` | now resolves via `xdgConfigHome()` — `:119` | ✅ `config-persistence` | Fixed, `e0d8f20` |
| `docs/agents/build-and-toolchain.md`, `CLAUDE.md` | no test command documented | `bun run test` is the declared runner | ✅ V1–V3 | Fixed, `ce3c51d` / `e0d8f20` |
| This spec, §5 and §8 | "`7t` is an **invalid** interval unit" | `parseInterval` accepts it — `wtft-renderer.ts:157` | ✅ `wtft-issue-121` | Corrected, `7656373` — the claim came from `--help`, not the parser |
| `docs/EXT_WTFT.html` | flag reference | none possible — it `fetch`es the same manifest the CLI reads (`:317`) | n/a | Tier-1 shared source. Structure gap filed **#161** |
| `CONTEXT.md` | — | no `Language — WTFT` section exists; only `Language — Serve` | n/a | Gap recorded, filed **#162**. Not papered over with invented terms |

Zero contradictions left standing in this branch. Three are carried as filed issues rather
than fixed here, because each needs its own 5-step cycle: #160 edits a manifest, #161
restructures a doc, #162 requires domain-modeling judgment about vocabulary.

No row is marked `reconciled-against-untested` — every behavioural claim corrected here had
a test behind the code it now matches.

— 👑π🐱 Princess Pi
