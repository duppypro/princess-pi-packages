# Spec: bun build + TS7 typecheck + artifacts out of git + dual-channel distribution (#97)

// ---
// WHY
// ---

Three problems, one migration:

1. **Agents edit generated files.** `bin/{serve,wtft,merge,wtft-daemon}.mjs` are esbuild
   output committed to git (required because `npm install -g <git-url>` runs no build without
   a `prepare` script). Nothing marks them generated, and `bin/` mixes them with handwritten
   `patch-pi-widgets.mjs` — so agents edit them and lose work on the next build.
2. **esbuild is the repo's only dependency** — bun's built-in `Bun.build` covers it, making
   the repo zero-runtime-dependency.
3. **No type-checking exists at all.** TypeScript 7 (native compiler, stable `7.0.2`) is
   adopted as the *first* checker. Policy (Duppy, 2026-07-13): if TS7 objects, **fix the
   repo forward** — never pin back to an older TS.

// ---
// DESIGN
// ---

**Two distribution channels, one source of truth:**

| Channel | Mechanism | Toolchain required |
|---|---|---|
| git URL (`npm i -g github:duppypro/princess-pi-packages`) | `prepare: bun build.ts` builds on install | **bun on PATH** (early-adopter channel) |
| npm registry (future `npm publish` / `npx`) | tarball ships prebuilt `.mjs` via `files` allowlist; `prepare` runs at publish, not consumer install | stock node only |

**Build (`build.ts`, replaces `build.mjs` + esbuild):** `Bun.build` per target,
`target: "node"`, `format: "esm"`, output `bin/<name>.mjs`. Post-process each artifact:
strip source shebang → prepend `#!/usr/bin/env node` + GENERATED banner → `chmod 755`.
`yada` joins the build targets (its `node --experimental-strip-types` shebang needs
node ≥ 22.6 — unsafe for public bins; `dedupwcount` aliases it).
SKILL.md validation ports over unchanged.

**Type-check (TS7):** devDeps `typescript@^7` + `@types/node`; minimal strict `tsconfig.json`
scoped to `bin/**` (extensions need `@earendil-works/pi-coding-agent` types — not on the
registry; extension checking is a follow-up road, not taken here). `typecheck` script stays
OUT of `prepare` — installers need bun only, never the checker.

**Artifacts out of git:** `.gitignore` lists the five generated files BY NAME
(`bin/*.mjs` would wrongly ignore handwritten `patch-pi-widgets.mjs`); `git rm --cached`
the four currently tracked. `files` allowlist in package.json is **mandatory** — npm falls
back to .gitignore for tarball exclusion, which would silently drop the built bins from
publishes.

**package.json:** bin entries → all-built `.mjs`; `files: ["bin/", "extensions/", "skills/"]`;
`engines.node >= 18`; `repository`; esbuild dependency deleted; `deploy:local` simplified
(`npm link` now auto-runs `prepare`; `npm cache clean --force` dropped — link doesn't hit
the cache).

**Installer = `bun install` (the disk-savings half of the migration).** `package-lock.json`
is deleted; `bun.lock` is committed as the source of truth. This is the piece that pays off
the original driver ("disk space saving first, then speed"): bun installs from a global
content-addressable cache (`~/.bun/install/cache`) and **hardlinks** each package version into
`node_modules` instead of copying — mechanically the same win as pnpm's store. A package
version cached once is shared by every repo that needs it (verified: sample file shows
`links=3`). `bun install` also runs the root `prepare`, so a fresh clone builds on install with
no extra step. Note the split: bun is now BOTH the **build tool** (`Bun.build`) AND the
**installer** — but the *consumer* side is untouched (registry tarball ships prebuilt `.mjs`;
`npx`/stock-node consumers never run bun). `deploy:local` keeps `npm link` deliberately — it
registers global bins and runs `prepare`; it is orthogonal to which tool populated devDeps.

// ---
// VERIFICATION (Step 4 gate) — ALL PASSED (2026-07-13/14, recorded in #97)
// ---

1. ✅ `bun build.ts` exit 0; five `.mjs` produced, each with node shebang + GENERATED banner, executable. (Zero-shot: passed on first post-Code-Draft run.)
2. ✅ `wtft`/`merge`/`yada`/`serve` `--help` all answer from the built `.mjs`.
3. ✅ `npm pack --dry-run` lists all five gitignored `.mjs` + `extensions/` + `skills/` (`files` beats `.gitignore`); `prepare` auto-ran at pack time.
4. ✅ `bun run typecheck` (tsc 7.0.2 native) exit 0 after fix-forward; deliberate-break canary caught (10 errors), reverted, clean again.
   TS7's first pass found real bugs: missing `execSync` import in wtft-renderer (live ReferenceError on tmux/tput width paths), duplicate `Bin`/`IntervalConfig` type defs, duplicate `fileURLToPath` import in serve.ts, `sessionNameSuffix` missing from the render options type, untyped daemon state. `nginx.js` stays JS with a hand-written `nginx.d.ts`.
5. ✅ git-URL channel: `npm install github:duppypro/princess-pi-packages#97-bun-build-ts7` in a scratch dir built via `prepare`+bun at install time (GENERATED banner present in installed bins — impossible unless built on install); all six bins linked and answering.
6. ✅ `deploy:local` re-link + live Pi smoke (`/tpm`, wtft widget) passed — redone after a concurrent-session branch stomp was recovered via `git merge --ff-only origin/97-bun-build-ts7` (the first smoke had unknowingly run pre-#97 code).
7. Deferred: first registry publish (separate decision); `wtft --tokens` terminal-width overflow seen during smoke is a pre-existing renderer bug → #99.
8. ✅ Installer swap verified (#102, 2026-07-14): `rm -rf node_modules && bun install` → 250ms, auto-ran `prepare`; `node_modules` 36M with sample file `links=3` (hardlinked to `~/.bun` cache, not copied); `bun run typecheck` exit 0; built bins keep node shebang. The `bun.lock`-committed / `package-lock.json`-deleted state shipped in `ff063a7` under #97 but was documented as a distinct decision here.

// ---
// ROADS NOT TAKEN
// ---

- **esbuild kept as devDep with node-based prepare** — would let git-URL installers skip bun,
  but re-adds the dependency this migration deletes.
- **`bun build --compile` single binaries** — no artifacts at all, but binaries don't belong
  in git and need a release pipeline; revisit alongside watu/cargo-dist work.
- **Extension type-checking** — blocked on pi API type availability; separate issue when taken.
