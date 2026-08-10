# Spec 159 — Nothing tests the artifact we ship: a pack-and-smoke suite, plus a staleness gate

**Issue:** #159
**Branch:** `159-pack-and-smoke`
**State:** Spec Draft

---

## 1. What was actually measured

Everything below was run against this branch at `main` @ `ad91cdc`, in the assigned worktree.
Not inferred from the issue text — the issue's own measurements (`npm pack --dry-run` clean,
staleness gate clean) turned out to be **only true because no one had run the actual install
side yet**. Re-measuring found two real, currently-shipping bugs.

### 1.1 The dev channel really is a full-tree symlink

```
$ readlink -f node_modules
/home/princess-pi/git-projects/princess-pi-packages/node_modules
```

`node_modules` in this worktree is a symlink into the main clone (per this org's own
worktree convention). `bin/wtft.mjs` et al. run unbundled against the full working tree via
`bun link` in normal dev use — confirmed by the issue, not re-litigated here.

### 1.2 Bug found: `docs/manifests/` was never in the `files` allowlist

`package.json` at `ad91cdc`:

```json
"files": [
  "bin/",
  "extensions/",
  "skills/"
]
```

Every one of the four bins reads its own command manifest at runtime for `--help`/`--version`/
`--why` (the manifest-driven CLI convention this repo documents in
`docs/agents/tool-conventions.md`):

```
bin/wtft.ts:170:   path.join(..., "docs", "manifests", "wtft-cmd.json")
bin/yada.ts:39:    "manifests",  (same pattern)
bin/merge.ts:20:   path.join(..., "docs", "manifests", "merge-cmd.json")
bin/serve.ts:33:   path.join(..., "docs", "manifests", "serve-cmd.json")
```

`docs/` was not shipped. Measured by packing the real tarball and installing it into a fresh
temp dir with plain `node`/`npm` (no bun on `PATH`) — the exact channel `bun link` cannot
exercise:

```
$ node_modules/.bin/wtft --version
❌ System Error: ENOENT: no such file or directory, open
   '.../node_modules/princess-pi-packages/docs/manifests/wtft-cmd.json'
exit=1

$ node_modules/.bin/yada --version
Error: ENOENT: no such file or directory, open
   '.../node_modules/princess-pi-packages/docs/manifests/yada-cmd.json'
    at Module.readFileSync (node:fs:440:20)
    at printVersion (file:///.../bin/yada.mjs:173:35)
Node.js v22.22.3
exit=1                                                          # uncaught — crashes, not a clean ❌ exit

$ node_modules/.bin/serve --version
⚠️ Failed to load command manifest: Error: ENOENT: ... docs/manifests/serve-cmd.json
exit=1
```

Three of four bins broken on the one channel that ships to consumers, invisible to `bun link`
because the symlink resolves into the full working tree — `docs/` included — every time.
This is the exact bug class #159 describes, not a hypothetical: found by building the check the
issue asked for, before the check itself was even written.

**Fix:** `"docs/manifests/"` added to `files`. Re-measured after the fix — all three now exit 0
and print the correct version (§5, V2).

Checked for other paths reachable the same way (`grep` for `readFileSync`/`existsSync` across
`bin/*.ts` with a `..`-relative join) — `docs/manifests/` is the only one. No broader `docs/`
fix needed.

### 1.3 Bug found: the bundler bakes the symlink's real path into committed output

Running `bun run build` in this worktree — before any fix — dirtied three bins that don't even
touch harness code:

```
$ bun build.ts && git status --short bin/
 M bin/serve.mjs
 M bin/wtft-daemon.mjs
 M bin/wtft.mjs

$ git diff bin/wtft.mjs | head -8
-// node_modules/clone/clone.js
+// ../../../princess-pi-packages/node_modules/clone/clone.js
```

`Bun.build` stamps a boundary comment on every bundled `node_modules` source, computed from
the file's **real** (symlink-resolved) path. Worktree `node_modules` resolves through the
symlink to the main clone, three directories further up than the worktree itself sits, so the
comment picks up a `../../../princess-pi-packages/node_modules/...` prefix that encodes *where
the build happened*, not the source. The main clone has no such symlink, so the exact same `.ts`
input builds clean there.

This is not cosmetic for #159: it means an **unpatched** staleness gate
(`bun run build && git diff --exit-code bin/`) would be red on every single worktree build —
which is the only place this org's own `CLAUDE.md` says development happens. A gate that is
always red in the actual dev environment is not a gate; it is noise everyone learns to ignore.

**Fix:** `build.ts` now canonicalizes the boundary comment before writing each `.mjs` (a regex
over lines matching `^// (\.\.\/|[\w.-]+\/)*node_modules\/`, collapsing any prefix down to
bare `node_modules/`). Re-measured after the fix:

```
$ bun build.ts && git status --short bin/ extensions/lib/harness/builtins.generated.ts
(clean)
```

Rebuild in this worktree now byte-matches the tree committed by a prior session in a different
environment — proof the fix generalizes across "where you built it," not just this one worktree.

### 1.4 Found, not fixed: `merge --version` fails for an unrelated reason

```
$ node_modules/.bin/merge --version
🔄 Running merge validation checks...
fatal: not a git repository (or any of the parent directories): .git
```

`merge` reads its manifest fine (docs/manifests/ fix covers it) but appears to run git-repo
validation before handling `--version` at all, in a plain `npm install` consumer dir with no
`.git`. This is a `merge`-specific control-flow bug, not a packaging bug — it is orthogonal to
#159 and out of scope here. Recorded in §8 rather than silently dropped.

### 1.5 No other broken paths

`rg -n 'path\.join\([^)]*"\.\."'` over `bin/*.ts` and `extensions/**/*.ts` found only the four
`docs/manifests` reads above and nothing else joins outside the current allowlist. `run-live-
server.js` stays `external` (loaded relative to the installed layout, already inside
`extensions/`) — unaffected by this issue.

---

## 2. Direction chosen

The issue offered three directions; this spec implements **direction 2, mechanical
pack-and-smoke**, exactly as the issue's own analysis concluded. Restated here because the
fork is real and worth naming, not because it needed re-deciding:

| Direction | What it commits to | Road taken? |
|---|---|---|
| 1. Reinstall from GitHub `main` on a cadence | Manual discipline that decays silently — the exact failure mode #159 is about | **Road not taken** |
| 2. Mechanical `pack-and-smoke` suite | The tarball becomes the tested artifact; nothing to remember, one suite added | **Taken** |
| 3. Registry-only, drop committed `.mjs` | A cleaner repo, at the cost of the early-adopter git-URL install path | **Road not taken** — this repo's own domain standard explicitly keeps bun-on-PATH permitted for git-URL installs; direction 3 would remove a supported channel to solve a testing gap, not a design flaw |

**What direction 2 commits the codebase to going forward:** every future top-level file/dir
under `bin/` or `extensions/lib/harness/` — and every future manifest under
`docs/manifests/` — is checked against the real npm tarball on every `bun run test` run, not
just the dev symlink. New harness or bin work that doesn't ship correctly now fails loudly
instead of shipping silently.

---

## 3. Proposed change

1. **`tests/pack-and-smoke.test.ts`** (new) — `npm pack` the repo (fires `prepare`; needs bun
   on `PATH`, which is fine — only the consumer side must be stock node), install the tarball
   into a fresh temp dir with a `PATH` that has **no bun on it at all**, and run real commands
   against the installed package:
   - `files`-allowlist coverage: every `bin/*.mjs`, every `extensions/lib/harness/*` file, and
     `docs/manifests/*` — enumerated from the real filesystem at test time, not hardcoded, so a
     **new** top-level file is caught the same way an existing one is (the exact #156 near-miss
     the issue names).
   - `wtft --version` and `yada --version` exit 0 and print the right version (catches §1.2's
     class of bug).
   - `wtft -s <fixture> --cost` renders a real cost figure from a synthesized minimal
     Claude-Code-shaped session (no existing fixture under `tests/fixtures`/`tests/data` is a
     session transcript — checked; those are nginx logs and pricing CSVs for other suites).
   - The known-limit disclaimer (§6) prints unconditionally, pass or fail.
2. **`tests/build-staleness-gate.test.ts`** (new) — `bun run build && git diff --exit-code
   bin/*.mjs extensions/lib/harness/builtins.generated.ts`, exactly as the issue proposed, plus:
   - A pre-flight that refuses to run if `bin/`, `extensions/lib/harness/`, or `build.ts`
     already has uncommitted changes — that state means a fresh build's diff cannot be honestly
     attributed to "stale" vs. "source mid-edit, not built yet," and restoring afterward would
     discard real work. Reports the exact dirty files and stops rather than guessing (§7 has the
     exit-code design call this forced).
   - A restore scoped to **only** the generated files (`bin/*.mjs` +
     `builtins.generated.ts`), never `bin/*.ts` or the harness source dirs.
3. **`package.json`** — add `"docs/manifests/"` to `files` (§1.2's fix).
4. **`build.ts`** — canonicalize the bundler's `node_modules` boundary comments so build output
   is identical regardless of whether `node_modules` is a real dir or a worktree symlink
   (§1.3's fix); correct a stale comment claiming generated bins are gitignored (they are
   tracked — the actual `.gitignore` comment already said so; `build.ts`'s comment had drifted).

Both suites run the same way as every other suite: `bun run test` discovers `tests/*.test.ts`
via `tests/run.ts` (#158) and runs each in its own process. No changes to the runner itself.

### Deliberately not in scope

Fixing `merge --version` (§1.4) — a distinct, unrelated bug, not a packaging defect.

---

## 4. Design decision: pre-flight and post-flight report as FAIL, not a silent SKIP

Both suites can hit a state that is not really "the packaging is broken" but also cannot
honestly report "verified fine" — pre-existing uncommitted changes in the exact paths the
suite is about to rebuild-and-restore. `tests/run.ts` (#158) only has two states per suite,
PASS or FAIL by exit code, and **only dumps the captured output of FAILED suites** in the final
report. An inconclusive state that exits 0 would be counted PASS and its explanation would be
silently swallowed — never seen unless someone re-runs that one suite by hand. That is a worse
outcome than a FAIL whose message is legible at a glance ("pre-flight: bin/ already has
uncommitted changes — not a staleness defect, commit or stash and re-run").

So: **inconclusive reports as FAIL, loudly labeled as distinct from a genuine defect.** This is
a design call, not dictated by the issue text — recorded here so a future reader knows it was
chosen deliberately, not missed. A real three-state (PASS/FAIL/SKIP) runner would remove the
need for this compromise; out of scope for #159 (see roads not taken).

---

## 5. Spec gate — verification criteria

| # | Check | Expected | Status |
|---|---|---|---|
| V1 | `tests/pack-and-smoke.test.ts` exists, follows the suite conventions in `tests/run.ts` (own process, `bun test <file>`-runnable, prints a `Results: N passed, M failed` line, exits non-zero on any failure) | Present | Written, not yet run — see §7 |
| V2 | Tarball install, plain node/npm (no bun on `PATH`): `wtft --version` and `yada --version` exit 0 and print `1.1.0` | Pass, after the §1.2 fix | Manually verified via raw `npm pack` + `npm install` + restricted-`PATH` `spawnSync`, reproduced below the fix; suite itself not yet run (§7) |
| V3 | `files`-allowlist coverage assertion is generic (reads `bin/`, `extensions/lib/harness/`, `docs/manifests/` off the filesystem at test time), not a hardcoded list | Present in suite | Code review — see suite source |
| V4 | `wtft -s <fixture> --cost` renders a `$`-figure, no error banner, exit 0 | Pass | Manually verified with an equivalent fixture against the installed tarball (§1.2 evidence) |
| V5 | `tests/build-staleness-gate.test.ts` exists, follows suite conventions | Present | Written, not yet run — see §7 |
| V6 | Fresh `bun run build` in THIS worktree matches the tree committed by a prior (non-worktree) session | Clean diff, after the §1.3 fix | Manually verified: `bun build.ts && git status --short bin/ extensions/lib/harness/builtins.generated.ts` → clean |
| V7 | Negative control: `files` allowlist missing `extensions/` → tarball is missing `extensions/lib/harness/session-cwd.ts` | Confirmed absent | Manually reproduced (§7.1), not yet run through the suite itself |
| V8 | Negative control: hand-edit a committed `bin/*.mjs` without touching its `.ts` source → `git diff --exit-code` on that file is non-zero | Confirmed non-zero | Manually reproduced (§7.2), not yet run through the suite itself |
| V9 | Both suites restore the tree — `git status --short` clean on `bin/`, `extensions/lib/harness/`, `package.json` (minus this branch's own intentional edits) after every manual reproduction above | Clean | Confirmed after each manual step in this session |
| V10 | Every bin/*.mjs and extensions/lib/harness/* file present in a real (unmutated) tarball | Present | Manually verified via `tar -tzf` against the real tarball post-fix |
| V11 | The known-limit disclaimer (git-URL channel not covered) prints in the suite's own output, unconditionally | Present | Code review — see suite source, printed before AND after the check body |

---

## 6. Known limit, stated per the issue's requirement

A tarball test does **not** cover the git-URL install channel, because that channel runs
`prepare` and therefore requires bun on `PATH`. That is a documented, accepted constraint
(domain standard: *"bun-on-PATH may be required only for the git-URL install channel, never for
the registry channel"*). **"pack-and-smoke is green" is a narrower claim than "every install
channel is green."** Both suites print this disclaimer in their own output, not just in this
doc, per the issue's explicit ask — see `tests/pack-and-smoke.test.ts`'s `KNOWN_LIMIT` constant,
printed before the checks run and again beside the final tally.

---

## 7. Negative-control evidence — measured directly, suite execution deferred

The issue and the general engineering standard both ask for negative-control verification
(temporarily break the thing, confirm red, restore) with evidence recorded **at Code Approved**
— not at Code Draft. My task instructions for this branch carry a harder, more specific rule
that governs this exact moment: *do not run `bun run test` or any test suite before the Code
Draft commit* — the pre-test state is committed deliberately to measure zero-shot accuracy, and
running the suite (including for negative controls) before that commit pollutes the
measurement. That rule wins here; the two asks are reconciled by doing the negative-control
**mechanics** by hand (not through the suite files) to validate the design before committing,
and leaving the suite-level negative-control run itself for the Code Approved step.

### 7.1 Files-allowlist negative control (measured by hand, not via the suite)

```
$ python3 -c '... files = ["bin/", "skills/", "docs/manifests/"] ...'   # drop "extensions/"
$ npm pack --pack-destination $T --silent
$ tar -tzf $T/*.tgz | grep extensions/lib/harness/session-cwd.ts
(no output — absent)
```

This is exactly the condition `tests/pack-and-smoke.test.ts`'s harness-coverage `check()` block
asserts against (`missing.length === 0`); with `extensions/` dropped, `missing` would be
non-empty and that `check()` would report FAIL. Restored `package.json` from backup immediately
after; `git status --short package.json` confirmed clean.

### 7.2 Staleness-gate negative control (measured by hand, not via the suite)

```
$ cp bin/wtft.mjs /tmp/wtft.mjs.bak
$ echo "// hand-edited, source not touched" >> bin/wtft.mjs
$ git diff --exit-code -- bin/wtft.mjs; echo "exit=$?"
exit=1
```

This is exactly the command `tests/build-staleness-gate.test.ts` runs after `bun run build`
(scoped per-file rather than the whole tree, per §3's fix); a non-committed hand-edit produces
exit 1, which the suite's `check()` turns into a labeled FAIL with a `git diff --stat` summary.
Restored `bin/wtft.mjs` from backup immediately after; `git status --short bin/` confirmed clean.

### What is NOT yet done

Actually invoking `tests/pack-and-smoke.test.ts` and `tests/build-staleness-gate.test.ts`
themselves — including running them once against a deliberately broken `files`/hand-edited
`.mjs` to see the suite's own PASS/FAIL output, not just the underlying mechanics — is left for
the Code Approved step, along with the rest of `bun run test`. Recorded as an open item in the
structured task output, not silently dropped.

---

## 8. Follow-ups this issue found but did not fix

| Finding | Why not here |
|---|---|
| `merge --version` fails with `fatal: not a git repository` when installed and run outside a git working directory (§1.4). | A `merge`-specific control-flow bug, unrelated to packaging. Worth its own issue. |
| A three-state (PASS/FAIL/SKIP) test runner would remove the FAIL-for-visibility compromise in §4. | Would mean editing `tests/run.ts` (#158's surface), out of scope for a testing-the-artifact issue. |

---

## 9. Roads not taken

- **Reinstalling from GitHub `main` on a cadence** (issue's direction 1). Manual discipline
  that decays silently — the precise failure mode #159 exists to close.
- **Registry-only, dropping committed `.mjs`** (issue's direction 3). Removes the git-URL
  install channel entirely rather than testing it accurately; the domain standard already
  permits bun-on-PATH for that one channel deliberately.
- **A real SKIP exit state for the pre-flight/post-flight guards** (§4). Correct in principle;
  requires changing the shared runner's report loop, which is #158's surface, not #159's.
- **Fixing `merge --version`'s git-repo requirement inline.** Unrelated bug, filed as a
  follow-up (§8) instead of scope-creeping this branch.

---

*Built by the AI Princess Pi. Inspired by her human, Duppy (github.com/duppypro)*
