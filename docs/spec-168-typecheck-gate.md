# Spec 168 — Typecheck goes green, and a gate makes it stay that way

**Issue:** #168
**Branch:** `168-typecheck-gate`
**State:** Code Approved

---

## 1. What was actually measured

On a clean checkout of `main` @ `ad91cdc`, no local changes, `node_modules` freshly installed
with `bun install`:

```
$ bun run typecheck
bin/serve.ts(21,81): error TS7016: Could not find a declaration file for module
  '../extensions/lib/serve/cloudflare.js'. ... implicitly has an 'any' type.
extensions/lib/serve/process.ts(6,59): error TS7016: Could not find a declaration file for module
  './cloudflare.js'. ... implicitly has an 'any' type.
$ echo $?
1
```

```
$ ./node_modules/.bin/tsc --noEmit --allowJs
$ echo $?
0
```

Two errors before, **zero** after, with no other module pulled into the program. Both numbers
come from running the compiler, not from reading the config.

---

## 2. Why exactly one module errors

`tsconfig.json` includes `bin/**/*.ts` and whatever those files transitively import. The CLIs
import a lot of `./x.js`, and under `moduleResolution: nodenext` almost every one of those
specifiers resolves to a real TypeScript file:

| Import in `bin/serve.ts` | Resolves to | Typed? |
|---|---|---|
| `../extensions/lib/serve/tui.js` | `extensions/lib/serve/tui.ts` | yes |
| `./domain.js` (from `process.ts`) | `extensions/lib/serve/domain.ts` | yes |
| `../extensions/lib/serve/cloudflare.js` | `extensions/lib/serve/cloudflare.js` | **no — genuinely `.js`** |

`extensions/lib/serve/cloudflare.js` is 25 KB of hand-written JavaScript with 9 exports and 14
JSDoc-annotated params. With `allowJs` unset, TS never opens it, so TS7016 fires at each of its two
consumers.

The two error lines are the visible cost. The real one is that `publishSubdomain`, `unpublishSubdomain`,
`updateSubdomainAllowlist`, `reapOrphans`, `parseAclFile`, `readSubdomainMap`, `loadCfEnv`,
`flattenSubdomainToLabel` and `aclEntriesToInclude` all cross into `bin/serve.ts` as `any` — the
Cloudflare edge-publishing path, which is the part of `serve` that mutates DNS records and an email
access allowlist. Every argument shape and return value on that path is currently unchecked.

---

## 3. The second half: a check nobody runs is not a gate

`tests/run.ts` discovers `tests/*.test.ts` and runs each in its own process. `typecheck` is a
separate `package.json` script that no suite invokes. Nothing in `bun run test` fails when `tsc`
does.

That is how two errors survived on `main` through a Step-5 "Code and Spec Approved" commit
(`ad91cdc`) without tripping anything: the Step-5 gate checks that specs match code, and the merge
gate checks commit wording. Neither runs the compiler.

This is the same shape as #159 — a check exists, and no gate makes it matter. Fixing the two errors
without adding the gate would leave the third error to be discovered the same way, by accident,
some months from now.

---

## 4. Direction chosen

**`allowJs: true` in `tsconfig.json`, with `checkJs` left at its default of `false`.**

TS reads `cloudflare.js` and infers types from its source and JSDoc. `checkJs: false` keeps errors
*inside* the JS unreported, which holds the scope where it belongs: the goal is typing the
**consumers** in `bin/`, not retroactively type-checking a file that was never written as TypeScript.

What it commits us to: the checker now reads `cloudflare.js` permanently, so an edit to that file
can newly break `bin/serve.ts`. That is the intended consequence — it is the only thing that makes
the DNS/allowlist path typed at all — but it means a `serve` change can now fail typecheck for a
reason that lives in a `.js` file.

### Roads not taken

**Hand-written `cloudflare.d.ts`.** Gives an explicit, stable declared surface, and keeps the
checker out of the `.js` entirely. Not taken: it creates a second source of truth sitting beside
the implementation with nothing binding them together. Drift between a declaration and the code it
describes is precisely the failure class this repo spent #158, #160 and #161 correcting, and adding
a fresh instance of it to close a typing gap trades one debt for a worse-shaped one.

**Convert `cloudflare.js` → `cloudflare.ts`.** Deletes the problem outright and is where this
should end up. Not taken here: it is a 25 KB production-code rewrite of the path that touches
Cloudflare DNS and the access allowlist, so it needs its own 5-step cycle with real
publish/unpublish testing — not a lane in a typecheck-baseline fix. `allowJs` leaves that road
open and makes the eventual conversion a smaller step, because the consumers will already be
typed against inferred shapes.

**Loosening `strict` or adding `// @ts-ignore` at the two import sites.** Not taken: both silence
the report without typing anything, and the domain standard is explicit that a TS7 objection is
fixed forward, never pinned back.

---

## 5. Verification criteria

| # | Criterion | How it is checked | Result |
|---|---|---|---|
| V1 | `bun run typecheck` exits 0 on this branch | run it; assert exit code | ✅ exit 0 |
| V2 | The typecheck gate is a suite, discovered and run by `bun run test` like every other suite | `bun run test typecheck-gate` selects it; it appears in the runner's suite count | ✅ suite count 43 → 44 |
| V3 | The gate goes **red** when a real type error exists | negative control: write a deliberate type error into `bin/`, assert the suite fails *on that file*; remove it | ✅ diagnostic names the probe; cleaned up |
| V4 | The gate reports the compiler's own diagnostics on failure, not just a bare exit code | inspect failure output; it must contain the `error TS` lines | ✅ |
| V5 | `allowJs` reaches `cloudflare.js` and widens the program no further | `tsc --noEmit --listFiles` must contain `extensions/lib/serve/cloudflare.js` **and no other repo `.js`** | ✅ |
| V6 | No production behaviour changes | the diff touches `tsconfig.json`, `.gitignore`, `tests/` and `docs/` only — no `extensions/` or `bin/` source, and `bun run build` output is unchanged | ✅ after §6's symlink fix |
| V7 | The full suite is still green | `bun run test` — 43 suites before, 44 after (the new one), all passing | ✅ 44 suites, 44 passed, 0 failed |
| V8 | The reason `allowJs` is on is readable at the setting itself | a comment in `tsconfig.json`, not only in this spec | ✅ |

### 5.2 The check that mattered most: does the gate catch *this* bug?

V3 proves the gate reacts to *a* type error — a synthetic one it wrote itself. That is not the same
as proving it would have caught #168. So the gate was run against the original defect directly, by
removing `allowJs` and re-running:

```
❌ V1: `bun run typecheck` exited 1, expected 0. Compiler said:
bin/serve.ts(21,81): error TS7016: Could not find a declaration file for module '.../cloudflare.js'
extensions/lib/serve/process.ts(6,59): error TS7016: ...
❌ V5: extensions/lib/serve/cloudflare.js is not in the checked program — allowJs is not reaching it.
```

Both of the issue's original error lines, reproduced. `allowJs` restored, suite green, `tsconfig.json`
diff empty. V5 firing independently of V1 is the useful part: it is a second signal with a different
mechanism, not an echo of the first, so a future change that silences the errors *without* actually
typing `cloudflare.js` would still be caught.

V3 is the one that matters most. A gate that cannot be shown to fail is indistinguishable from no
gate, and this issue exists because an unexercised check produced exactly that illusion.

### 5.1 How the negative control is made safe

Writing V3 forced a detail the draft had not settled: *where* the deliberate type error goes. A
synthetic project in a temp dir would prove that `tsc` reports errors — which was never in doubt —
without proving that **this repo's config** reports them. So the probe is written into `bin/`,
inside the real `include: ["bin/**/*.ts"]` glob, and the assertion checks that the diagnostic names
the probe rather than merely that something failed.

That puts a temporary broken file in the source tree, so the suite guards it three ways:

1. it refuses to run if the probe path already exists, rather than overwriting an orphan from an
   interrupted run;
2. it removes the probe in a `finally`, so an assertion failure still cleans up;
3. it re-checks for the file after cleanup and fails loudly if it survived.

The third guard is not redundant. A stray `bin/__typecheck_gate_probe__.ts` would fail every
subsequent suite in the run *and* — because `bin/` is in the package `files` allowlist — ship in
the tarball. The filename is deliberately unmistakable so that if all three guards are somehow
defeated, the orphan reads as debris rather than as source.

---

## 6. What V6 turned up: symlinked `node_modules` corrupts the build and evades `.gitignore`

V6 ("`bun run build` output is unchanged") failed on first run, and the cause had nothing to do
with `allowJs`. It is recorded here because it invalidates a worktree setup this repo will keep
reaching for, and because it would have made #159's staleness gate permanently red.

The seven worktrees for this round of work were each given `node_modules` as a **symlink** to the
main clone's, on the reasoning that bun already hardlinks and a second install is waste. Two things
follow, both bad:

**1. The build output changes.** `bun build` records each module's resolved path in a bundle
comment. Through a symlink that path escapes the worktree:

```diff
-// node_modules/wcwidth/index.js
+// ../../../princess-pi-packages/node_modules/wcwidth/index.js
```

Three tracked bins (`wtft.mjs`, `wtft-daemon.mjs`, `serve.mjs`) change on every build, for a
cosmetic reason, and the shipped artifact leaks the developer's local directory layout. A
`bun run build && git diff --exit-code bin/` staleness gate — exactly what #159 is adding — would
be red forever for anyone using a symlinked worktree, and the true positives it exists to catch
would be lost in that noise.

**2. `.gitignore` does not catch it.** The pattern was `node_modules/`, with a trailing slash,
which matches a **directory only**. A symlink is a file. So `git add -A` committed the symlink, and
by the time it was noticed it was tracked on four of the seven branches.

Fix, both halves:

- `.gitignore`: `node_modules/` → `node_modules`, so the pattern matches a symlink too. The comment
  above it records why, since a bare pattern looks like a typo of the conventional one.
- Every worktree gets a real `bun install`. It hardlinks from the global content-addressable cache,
  which is the documented reason this repo standardised on bun — the disk cost of the "waste" being
  avoided was approximately zero, and the correctness cost was not.

Verified after the fix: `bun install && bun run build` in this worktree leaves `git status` clean.

---

## 7. Notes on running V7

This branch was developed while six sibling branches (#144/#145/#164, #148, #149, #159,
#160/#161/#162, #163) were being worked concurrently in their own worktrees. `tests/run.ts` states
that several suites spawn wtft daemons, bind ports and share `/tmp` fixture paths, and is serial
for that reason. Full-suite runs are therefore serialized across all worktrees; V7 is recorded
against a run made when no sibling run was in flight.

The new typecheck suite itself is exempt from that constraint — it invokes `tsc` and touches no
port, daemon or shared fixture path — so it is safe to run at any time.
