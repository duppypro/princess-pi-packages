# Pi Packages Project Standard

This project contains custom extensions, skills, and documentation manifests for the Princess-Pi Coding Agent.

> **Repo goal — cross-harness tooling:** one implementation of each tool that works in **both Pi and
> Claude Code** (CLI + Pi extension + optional TUI widget, one shared manifest). See the mission in
> `README.md`. **To build or port a tool to this bar, follow the recipe in
> `skills/cross-harness-tool/SKILL.md`.** Reference implementation: `merge` (`bin/merge.mjs`, #8).

---

## 🛠️ Tech Stack & Directory Structure
*   **Runtime**: Node.js (≥ 18). Pi extensions are `.ts`; standalone CLI bins are being standardized to plain ESM JavaScript (`.mjs`) — see the cross-harness convention below.
*   **`extensions/`**: The raw `.ts` extension scripts loaded directly by the Pi Agent (e.g. `serve.ts`, `wtft.ts`, `smush.ts`). These remain the **typed twin** of any CLI bin.
*   **`bin/`**: Standalone, Pi-independent CLI ports of extensions whose logic doesn't need the Pi runtime. Invokable from any shell, including Claude Code's `!` prefix — Claude Code has no extension-dispatch that bypasses the model the way Pi's `registerCommand` does, so the CLI is the practical zero-token substitute. Each command also gets a same-named wrapper script at the repo root (e.g. `./merge`) execing the bin.
    *   **Cross-harness convention (why `.mjs`):** CLI bins should be **plain ESM JavaScript** with `#!/usr/bin/env node` — *not* `--experimental-strip-types` and *not* `npx tsx`. When installed globally for Claude (`npm install -g github:duppypro/princess-pi-packages`) the bin lives under `node_modules/`, where Node **refuses** type-stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) and an `npx tsx` shebang forces a per-environment network fetch. Plain `.mjs` needs zero deps and no build step. **Reference implementation: `bin/merge.mjs` (#8).** `wtft`/`serve`/`yada` are still `.ts` and don't yet run from a global install — tracked in #9 (wtft) and #10 (serve).
*   **`tests/`**: Dedicated permanent test suites.
*   **`debug/`**: Ephemeral scripts for quick debugging (e.g., one-off log parsers).
*   **`research/`**: Prototypes and longer-term experimental code.
*   **`skills/`**: Standard markdown-based memory files and skill guides.
*   **`docs/`**: Flattened user specifications (as `.html`) and documentation files.
    *   `docs/manifests/`: Command reference definitions (`.json` files) parsed dynamically by the `/serve`, `/merge`, and `/wtft` extensions (and their `bin/` CLI counterparts, where one exists).

---

## 📖 Manifest-Driven `--help` Convention
Any command backed by a `docs/manifests/*-cmd.json` file (read by both the Pi extension and, where applicable, its `bin/` CLI port) renders its `--help` text in this fixed order:
1.  **Title + tagline + description** (`name`, `tagline`, `description` fields).
2.  **Examples first** — a short list of realistic invocations with mock parameters already filled in (`examples[].args` + `desc`), so a reader sees working commands before wading into flag definitions.
3.  **Full flag enumeration last** (`usage[].flags` + `desc`).
Manifest `examples`/`usage` entries store only the trailing arguments/flags (`args`/`flags`), never a hardcoded command name — the renderer prepends its own `invokedAs` (e.g. `/merge` for the Pi extension, `./merge` for the CLI), since the same manifest must render correctly under both invocation forms.

---

## 🔄 Local Development & Testing Workflow
To test changes to extensions in this repository locally:

### 1. The Ephemeral Sandbox (Temporary Run)
To run Pi with your local directory's extensions temporarily loaded without editing your global settings:
```bash
pi -e ./         # Start a new session with local packages
pi -r -e ./      # Resume the last session with local packages
```

### 2. Global Install (From Remote Main)
**Pi** — load extensions globally across any directory:
```bash
pi install git:github.com/duppypro/princess-pi-packages@main
```
**Claude Code / any shell** — install the CLI bins on `$PATH` from GitHub `main` (the `-g` flag
makes this cwd-independent; pulls from the remote, not a local clone):
```bash
npm install -g github:duppypro/princess-pi-packages
```
Today only `merge` is a verified global CLI (plain `.mjs`); `wtft`/`yada`/`serve` await the
`.mjs` port (#9, #10). Re-run the command to update.

### 3. Hot-Swapping & Updates
When you make changes to files and push them, trigger a re-download and TUI compilation:
```bash
pi update --extensions    # Force-fetch and compile from the remote Git main cache
/reload                   # Inside the TUI: Hot-reload loaded extensions
```
