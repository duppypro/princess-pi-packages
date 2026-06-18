# Pi Packages Project Standard

This project contains custom extensions, skills, and documentation manifests for the Princess-Pi Coding Agent.

---

## 🛠️ Tech Stack & Directory Structure
*   **Runtime**: Node.js (TypeScript compiled to ES Modules).
*   **`extensions/`**: The raw `.ts` extension scripts loaded directly by the Pi Agent (e.g. `serve.ts`, `wtft.ts`, `smush.ts`).
*   **`bin/`**: Standalone, Pi-independent CLI ports of extensions whose logic doesn't actually need the Pi runtime (e.g. `merge.ts`, `serve.ts`, `yada.ts`). Invokable directly (`npx tsx bin/X.ts`) from any shell, including Claude Code's `!` prefix — Claude Code has no extension-dispatch mechanism that bypasses the model the way Pi's `registerCommand` does, so this is the practical substitute. Each such command also gets a same-named executable wrapper script at the repo root (e.g. `./merge`, `./serve`) calling `npx tsx bin/X.ts "$@"`.
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
To install the package globally so that it runs automatically across any directory:
```bash
pi install git:github.com/duppypro/princess-pi-packages@main
```

### 3. Hot-Swapping & Updates
When you make changes to files and push them, trigger a re-download and TUI compilation:
```bash
pi update --extensions    # Force-fetch and compile from the remote Git main cache
/reload                   # Inside the TUI: Hot-reload loaded extensions
```
