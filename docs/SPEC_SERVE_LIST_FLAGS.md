# Spec: `serve` listing flags + no-default-dir (#117)

Status: **SPEC DRAFT** · Issue: #117 · Supersedes the `public/`+`docs/` default and the `--log` flag.

## Why

`serve` with no args defaulted to `public/ docs/`. Across many project layouts that pair
rarely exists, so bare `serve` usually warns twice and serves nothing. The listing flag
`--log` also mis-signals ("show logs") when it means "list running servers", and there was
no box-wide view. This change makes bare `serve` a **safe, informative no-op** and adds an
all-repos listing.

## Behavior (the spec = these observable states)

### 1. `--log` → `--list` (`-L` unchanged)
- `serve --list` / `serve -L` → list servers whose dir is inside the current repo (cwd subtree),
  identical output to the old `--log`.
- `--log` is **removed**. It no longer routes to the list handler; it falls through to the start
  path where it is treated as a (non-existent) directory name and warns — an acceptable clean break.

### 2. `--list-all` (`-A`) — new
- Lists **every** discovered `serve`/`http-server` process on the machine (no `isInsideRepo`
  filter). Scope is "all processes on the box" — on this single-user VPS that is exactly "this
  user's servers". No per-OS-user filtering.
- Empty state: `No servers are currently running for this user.`

### 3. No `public/`+`docs/` default
- Bare `serve` (zero args) **or** `serve` with only flags and no directory (e.g. `serve --static`):
  1. prints the `--list` (repo-scoped) view, then
  2. prints `buildNoDirHint()` — a suggested **agent prompt** to locate a servable dir plus a
     pointer to `--list-all`.
  3. **Starts nothing.** Serving requires an explicit `<dir>`.
- `serve <dir>` and `serve <dir> --as <slug>` are unchanged.

## Design — pure seams (unit-tested)

All in `extensions/lib/serve/` (shared by both `bin/serve.ts` CLI and `extensions/serve.ts` Pi):

- `selectServers(servers, cwd, scope: "repo"|"all")` → filtered `ServerInstance[]`
  (`domain.ts`; `"repo"` = `isInsideRepo`, `"all"` = passthrough).
- `buildListSummary(servers, cwd, scope)` → string (header + empty-state + `• dir @ url (Logs: …)`
  lines) (`tui.ts`).
- `buildNoDirHint()` → the agent-prompt suggestion + `--list-all` pointer string (`tui.ts`).

CLI prints via `console.log`; Pi prints via `ctx.ui.notify`. Same seams, same text.

## Manifest (`docs/manifests/serve-cmd.json`)

- Remove the `public/`+`docs/` framing from `description`, the `""` example, and the default-dirs
  `why` scenario.
- `usage`: replace `-L, --log` with `-L, --list`; add `-A, --list-all`; update `[dirs...]` desc
  (no default; bare `serve` lists + hints).
- `examples`: drop the `""`→public/docs example; add a `--list-all` example.
- `why`: the `--log` scenario → `--list`; add "see everything I'm serving box-wide" → `--list-all`.

## Verification

- `tests/serve-117-list.test.ts` (offline, `npx tsx`): `selectServers` repo vs all; `buildListSummary`
  both scopes incl. empty; `buildNoDirHint` contains the agent-prompt guidance + `--list-all` pointer.
- `bun run typecheck` (TS7) clean; `bun run build` regenerates `bin/serve.mjs`.
- Manual: bare `serve` → list + hint, no process spawned (`serve --list` right after shows nothing new);
  `serve --list-all` shows a server started in another repo; `serve dist/` still serves.

## Roads not taken

- **Per-OS-user filtering for `--list-all`** — deferred; single-user VPS makes "all processes" ≡
  "this user" today. Revisit if the box ever hosts multiple accounts.
- **Auto-scanning the FS for candidate dirs** — chose an agent-prompt suggestion over `serve` walking
  the tree itself (keeps `serve` from doing FS discovery; the agent is better at judging "servable").
