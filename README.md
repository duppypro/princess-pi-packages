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

### Method 1: Global File Copying (Recommended)
This installs the files directly to your global `~/.pi/agent/extensions/` directory. This is the cleanest setup because it supports auto-discovery and **instant hot-reloading with `/reload`**.

Run the installer script:
```bash
./install.sh
```

---

### Method 2: Native Pi Package Link (Developer Mode)
If you are modifying these extensions locally and want your edits to reflect instantly, link this directory as a local Pi Package.

Run this native command from your terminal:
```bash
pi install /home/princess-pi/git-projects/princess-pi-packages
```

---

## 🔄 Syncing Changes

If you make live edits to your extensions directly inside the `~/.pi/agent/extensions/` folder and want to back them up to this repository, or if you pull changes from GitHub and want to apply them globally, you can use the included `sync.sh` script:

```bash
# Pull changes from ~/.pi/agent/extensions/ INTO this repository
./sync.sh --pull

# Push changes from this repository INTO ~/.pi/agent/extensions/
./sync.sh --push
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
