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

## Hot-swap after push

After pushing changes, re-download and recompile extensions:

```bash
pi update --extensions
/reload                   # Inside the TUI: hot-reload loaded extensions
```
