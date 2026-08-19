# Development Workflow

## Ephemeral sandbox

Run Pi with local extensions loaded temporarily, without editing global settings:

```bash
pi -e ./       # Start a new session
pi -r -e ./    # Resume the last session
```

## Local install

Install CLI bins from the local clone's current branch for immediate testing:

```bash
./install-local
```

Runs `bun run build` then `bun link` — CLI bins on `$PATH` are symlinked to this repo's `bin/`.

**This covers the built commands only** — the five entries in `package.json`'s `bin` map:
`serve`, `wtft`, `yada`, `dedupwcount` (a second name for the same `yada.mjs`), and
`patch-pi-widgets` (the one handwritten `.mjs`, no `.ts` twin). The twelve **workflow shell scripts** (`pr-open`, `git-checkpoint`, `repo-gate`, …)
are not in that map and no symlink points at them — `install-workflow-tools` **copies** them to
`~/bin`. Editing `bin/git-overview` in a worktree therefore changes nothing about the
`git-overview` on your `$PATH` until you re-run the installer, which is the exact trap `--version`
(#178) exists to diagnose: it prints the resolved path of the copy that actually answered.

```bash
bin/install-workflow-tools           # deploy this clone's scripts to ~/bin
bin/install-workflow-tools --check   # report drift, write nothing
git-overview --version               # which copy is on $PATH right now?
```

## Hot-swap after push

After pushing changes, re-download and recompile extensions:

```bash
pi update --extensions
/reload                   # Inside the TUI: hot-reload loaded extensions
```
