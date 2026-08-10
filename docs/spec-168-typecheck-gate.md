# Spec 168 — Typecheck goes green, and a gate makes it stay that way

**Issue:** #168
**Branch:** `168-typecheck-gate`
**State:** Spec Draft

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

| # | Criterion | How it is checked |
|---|---|---|
| V1 | `bun run typecheck` exits 0 on this branch | run it; assert exit code |
| V2 | The typecheck gate is a suite, discovered and run by `bun run test` like every other suite | `bun run test typecheck` selects it; it appears in the runner's suite count |
| V3 | The gate goes **red** when a real type error exists | negative control: introduce a deliberate type error in a temp copy, assert the suite fails; restore |
| V4 | The gate reports the compiler's own diagnostics on failure, not just a bare exit code | inspect failure output; it must contain the `error TS` lines |
| V5 | `allowJs` pulls no additional module into the program | compare `tsc --noEmit --listFiles` before/after; only `cloudflare.js` is added |
| V6 | No production behaviour changes | the diff touches `tsconfig.json`, `tests/`, and `docs/` only — no `extensions/` or `bin/` source, and `bun run build` output is unchanged |
| V7 | The full suite is still green | `bun run test` — 43 suites before, 44 after (the new one), all passing |
| V8 | The reason `allowJs` is on is readable at the setting itself | a comment in `tsconfig.json`, not only in this spec |

V3 is the one that matters most. A gate that cannot be shown to fail is indistinguishable from no
gate, and this issue exists because an unexercised check produced exactly that illusion.

---

## 6. Notes on running V7

This branch was developed while six sibling branches (#144/#145/#164, #148, #149, #159,
#160/#161/#162, #163) were being worked concurrently in their own worktrees. `tests/run.ts` states
that several suites spawn wtft daemons, bind ports and share `/tmp` fixture paths, and is serial
for that reason. Full-suite runs are therefore serialized across all worktrees; V7 is recorded
against a run made when no sibling run was in flight.

The new typecheck suite itself is exempt from that constraint — it invokes `tsc` and touches no
port, daemon or shared fixture path — so it is safe to run at any time.
