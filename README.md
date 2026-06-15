# 👑 Princess-Pi Packages (Global Extensions)

This repository bundles Princess-Pi's custom extensions and tools into a single, cohesive, globally deployable package. Once installed, these capabilities are automatically loaded into your `pi` environment **regardless of which folder or project you launch `pi` from**.

---

## 📦 What's Included

| Extension | Command / Tool | Description |
| :--- | :--- | :--- |
| **`wtft.ts`** | `/wtft` | **Where The F\*\*\*ing Tokens?!** - A cost-auditing widget that hooks into turn-completion events to display running session costs in the TUI without wasting tokens. |
| **`ddg-search.ts`** | `search_web` (Tool) | High-speed, schema-validated web search tool using DuckDuckGo. Perfect for searching Svelte 5 runes and modern framework docs. |
| **`serve.ts`** | `/serve` | Spawns secure HTTPS/SSL local servers, auto-provisions certificates in `~/.pi-certs/`, and manages active connections via a live TUI widget. |
| **`merge.ts`** | `/merge` | Safety-centric git branch merger for multi-worktree repositories. Enforces strict compliance with Step 5 "Code and Spec Approved" commit guidelines before merging to `main`. |
| **`github-issue-autocomplete.ts`** | (Automatic) | Enhances the terminal TUI by autocompleting GitHub issue numbers (starting with `#`) dynamically as you type. |
| **`system-clock.ts`** | (System Service) | Emits centralized 1s, 4s, and 60s tick events across the `pi` event bus to drive polling widgets smoothly. |
| **`learning_pi_extension_api`** | (Skill) | Memory bank documenting Pi's extension API, lifecycle events, and CWD caching rules. Found in `skills/learning-pi/SKILL.md`. |

---

## 🚀 Installation & Setup

This repository is designed to be installed natively through Pi's built-in package manager. Do not manually copy the files into your local extensions folder.

To install or update the package globally, simply run:

```bash
pi install https://github.com/dproctor/princess-pi-packages
```

Once installed, Pi will automatically load the extensions and skills found in this package into every session.

### Managing Extensions

You can toggle specific extensions and skills on or off at any time using the built-in Pi Configuration interface:

```bash
pi config
```

To uninstall the package entirely:
```bash
pi remove git:github.com/dproctor/princess-pi-packages
```

---

## 🔄 Testing Your Installation

1. Start a new `pi` session (or type `/reload` in your active session).
2. Run `/wtft --show` to activate the live token cost tracker widget.
3. Test the search tool:
   ```bash
   /wtft
   ```
4. Enjoy your globally supercharged Princess-Pi terminal!


## 🤖 Agent Instructions (CLAUDE.md)
We standardize on `CLAUDE.md` for all AI coding agent instructions. Even when using Pi Coding Agent or other harnesses, we adopt this naming convention to ensure cross-ecosystem compatibility (e.g., with Claude Code) without duplicating rules or managing symlinks.

