# 👑 Princess-Pi Packages (Global Extensions)

This repository bundles Princess-Pi's custom extensions and tools into a single, cohesive, globally deployable package. Once installed, these capabilities are automatically loaded into your `pi` environment **regardless of which folder or project you launch `pi` from**.

---

## 🎯 Mission — Cross-Harness Tooling

The goal of this repo is **one implementation of each tool that works across coding-agent harnesses** —
today **Pi Coding Agent** and **Claude Code**, with room for others. Each capability is built to be:

- **Callable as a plain CLI** (`#!/usr/bin/env node` ESM JS) so any shell — and Claude Code via its
  `!` prefix or a single Bash call — can run it with **zero LLM reasoning turns** on the success path
  and a fix-instructing error on the failure path;
- **Usable as a Pi extension** (`/command` via `registerCommand`), optionally with a **live TUI widget**
  (e.g. `/wtft`'s turn-event cost tracker);
- **Driven by one shared manifest** (`docs/manifests/*-cmd.json`) so `--help` renders identically
  everywhere.

`merge` is the reference cross-harness tool; `wtft`/`serve` are being brought to the same bar (issues
#9, #10). **To build a new cross-harness tool, follow `skills/cross-harness-tool/SKILL.md`.**

---

## 📦 What's Included

| Extension | Command / Tool | Description |
| :--- | :--- | :--- |
| **`wtft.ts`** | `/wtft` | **Where The F\*\*\*ing Tokens?!** - A cost-auditing widget that hooks into turn-completion events to display running session costs in the TUI without wasting tokens. |
| **`ddg-search.ts`** | `search_web` (Tool) | High-speed, schema-validated web search tool using DuckDuckGo. Perfect for searching Svelte 5 runes and modern framework docs. |
| **`serve.ts`** | `!serve` (widget: `/serve`) | Spawns loopback HTTP dev servers with live-reload. Publishes Access-gated previews via Cloudflare Tunnel at `<subdomain>.princess-pi.dev`. The Pi extension is the live TUI widget only — ADR 0004. |
| **`github-issue-autocomplete.ts`** | (Automatic) | Enhances the terminal TUI by autocompleting GitHub issue numbers (starting with `#`) dynamically as you type. |
| **`system-clock.ts`** | (System Service) | Emits centralized 1s, 4s, and 60s tick events across the `pi` event bus to drive polling widgets smoothly. |
| **`cross-harness-tool`** | (Skill) | How to build or port a tool to the one-implementation-per-tool bar described above. Found in `skills/cross-harness-tool/SKILL.md`. |
| **`spec-reconcile`** | (Skill) | The **Code & Spec Approved** step, run before `pr-open`: find and **fix** every readable artifact that contradicts the code. Backtested against four frozen drifts (#163); corpus, prompts, and rubric in `research/spec-reconcile-backtest/`. Found in `skills/spec-reconcile/SKILL.md` — that copy is the source of truth, `~/.claude/skills/spec-reconcile/` is a downstream deploy copy. |

---

## 📖 [Full docs](docs/EXTENSIONS.html)

---

## 🚀 Installation & Setup

This repository is designed to be installed natively through Pi's built-in package manager. Do not manually copy the files into your local extensions folder.

To install or update the package globally, simply run:

```bash
pi install https://github.com/dproctor/princess-pi-packages
```

Once installed, Pi will automatically load the extensions and skills found in this package into every session.

### Cross-harness CLI install (Claude Code & any shell)

The same tools are exposed as standalone CLIs (no Pi runtime) for Claude Code and other
harnesses. Install them globally **from GitHub `main`** (not a local clone) with npm — the
`-g` flag makes this cwd-independent, so run it from anywhere (e.g. `~`):

```bash
npm install -g github:duppypro/princess-pi-packages
```

This puts **`serve`**, **`wtft`**, **`yada`** (alias `dedupwcount`) and **`patch-pi-widgets`**
on your `$PATH` as prebuilt `.mjs` CLIs — plain `node`, no build step at install time, no bun
required. In Claude Code, invoke one with the `!` prefix (e.g. `!serve dist/`) or let the agent
run it as a single Bash call: it spends **zero LLM reasoning turns** on the success path and
emits fix-instructing errors on the failure path. Requires **Node ≥ 18** (ESM). Re-run the
install to update.

> **The git-workflow scripts are a separate channel.** `git-checkpoint`, `git-overview`,
> `wt-new`, `pr-open`, `pr-merge`, `pr-reject`, `pr-cleanup`, `pr-threads`, `repo-gate`,
> `herdr-tab` and `herdr-reap` are shell scripts installed to `~/bin` by
> `bin/install-workflow-tools`, not by the npm package. They are not in `bin` above because
> they are host tooling for this workflow rather than a published library surface.

> **The `merge` CLI this section used to describe is gone.** `bin/merge` was replaced by
> `pr-open` in #201, and the Pi `/merge` command was deleted in #226 — nothing merges locally
> any more. See [ADR 0004](docs/adr/0004-workflow-tools-are-shell-first.md).

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

