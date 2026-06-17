# Pi Packages Project Standard

This project contains custom extensions, skills, and documentation manifests for the Princess-Pi Coding Agent.

---

## 🛠️ Tech Stack & Directory Structure
*   **Runtime**: Node.js (TypeScript compiled to ES Modules).
*   **`extensions/`**: The raw `.ts` extension scripts loaded directly by the Pi Agent (e.g. `serve.ts`, `wtft.ts`, `smush.ts`).
*   **`tests/`**: Dedicated permanent test suites.
*   **`debug/`**: Ephemeral scripts for quick debugging (e.g., one-off log parsers).
*   **`research/`**: Prototypes and longer-term experimental code.
*   **`skills/`**: Standard markdown-based memory files and skill guides.
*   **`docs/`**: Flattened user specifications and documentation files.
    *   `docs/manifests/`: Command reference definitions (`.json` files) parsed dynamically by the `/serve` and `/wtft` extensions.

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
