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

// ---
// VERIFICATION (Step 4 gate)
// ---

1. `bun build.ts` exits 0; five `.mjs` produced, each with node shebang + GENERATED banner, executable.
2. `./bin/wtft.mjs --help` and `./bin/merge.mjs --help` answer.
3. `npm pack --dry-run` lists all five `.mjs` + `extensions/` + `skills/` (proves `files` beats `.gitignore`).
4. `bun run typecheck` (tsc 7, `--noEmit`) exits 0; a deliberately broken type is caught (canary), then reverted.
5. Follow-ups with Duppy (not this branch's gate): push → git-URL install test from GitHub; `deploy:local` re-link + live Pi `/tpm` + wtft widget smoke; first registry publish.

// ---
// ROADS NOT TAKEN
// ---

- **esbuild kept as devDep with node-based prepare** — would let git-URL installers skip bun,
  but re-adds the dependency this migration deletes.
- **`bun build --compile` single binaries** — no artifacts at all, but binaries don't belong
  in git and need a release pipeline; revisit alongside watu/cargo-dist work.
- **Extension type-checking** — blocked on pi API type availability; separate issue when taken.
