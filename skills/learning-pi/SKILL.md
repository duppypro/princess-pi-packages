---
name: learning_pi_extension_api
description: Lessons learned regarding Pi's extension API, session context (CWD), lifecycle events, and Duppy's architectural and workflow preferences.
---

# Skill: Pi Extension API, TUI Rendering, & Duppy's Standards

This skill serves as the **primary, high-priority memory bank** of architectural lessons, TUI rendering constraints, and workflow guidelines developed with Duppy. 

> 💡 **Princess-Pi Guideline:** When searching for how Pi works, or how Duppy prefers to structure or configure tools, **ALWAYS read this skill first**. Only search the broader Pi documentation or the web if the explanation is not found here.

---

## 1. Directory Context: `ctx.cwd` vs `process.cwd()`
**The Lesson:** By default, `ctx.cwd` (provided to extension command handlers) is a **static snapshot** of the directory where the session originally launched.
- If you build a command like `/cd` to dynamically change directories mid-session (`process.chdir()`), extensions relying on `ctx.cwd` will silently fail by searching the old path.
- **Duppy's Standard:** Always use `process.cwd()` instead of `ctx.cwd` inside command handlers to ensure extensions (like `/serve`, `/merge`, and `/wtft`) resolve paths relative to the *live* physical workspace, especially after a `/cd` pivot.

## 2. The Session Lifecycle & Cache Busting
**The Lesson:** Pi binds project-specific context (`.pi/settings.json`, local `AGENTS.md`) and fires `session_start` only when the session boots.
- **The Catch:** If you permanently migrate a session to a new project using `/mv-session`, the agent's internal "brain" (prompt instructions) and any background extensions that preloaded data on `session_start` (like the `github-issue-autocomplete` fetching from the old remote) will be stale.
- **Duppy's Standard:** Use explicit UI warnings to remind the user to run `/reload` after major workspace shifts. Executing `/reload` safely flushes the old local guidelines, rehydrates the new directory's configurations, and forces `session_start` events to re-fire (busting the autocomplete caches).

## 3. TUI Widget State Persistence
**The Lesson:** TUI widget visibility (like toggling the `/serve` port list with `--hide` or `--show`) is lost if the user runs `/reload`.
- **The Solution:** Use `pi.appendEntry("my-feature-state", { ... })` to write arbitrary JSON state into the session's chat history. On `session_start`, read this state back via the context to decide whether a widget should be rendered, making UI choices survive reloads.

## 4. Failing Fast & User Trust
**The Lesson:** Agent commands should never leave the system in a partial or corrupt state.
- **Duppy's Standard (Option A - Fail Fast):** Commands like `/cd` and `/mv-session` must heavily validate inputs before making OS-level mutations. If a path doesn't exist, throw a clean TUI notification immediately rather than allowing the command to crash midway.

## 5. Background Execution & Cleanup
**The Lesson:** Extensions that spawn child processes (like `/serve`) can easily create zombie processes or connection leaks if not managed during the Pi lifecycle.
- **Duppy's Standard:** Always hook into the `session_shutdown` event to warn the user about lingering background servers, and manage event-listener teardown (e.g., `pi.events.on("clock:tick")`) to prevent memory leaks across `/reload` invocations.

## 6. GitHub Authentication: PAT vs. `gh auth login`
**The Lesson:** While `gh auth login` (OAuth) is the most convenient choice for day-to-day interactive development on a VPS, there are specific scenarios where using a Fine-Grained Personal Access Token (PAT) is the smarter, more secure choice.
- **Principle of Least Privilege:** `gh` OAuth requests broad permissions across all your repos. A PAT allows strictly limiting access (e.g., only read/write issues in a single repository). Use a PAT for isolated scripts or extensions to minimize the blast radius if the token leaks.
- **Headless Automation:** `gh` OAuth requires interactive browser approval. A PAT can be passed silently as an environment variable (`GITHUB_TOKEN`), making it required for cron jobs, CI/CD, and background automation.
- **Direct API Usage:** `gh` OAuth forces you to shell out to `gh api ...`, adding overhead. A PAT allows direct, fast HTTP requests (e.g., using `fetch` or `axios`) via an `Authorization: Bearer <TOKEN>` header.
- **Duppy's Standard:** If a Human (or an interactive Agent) is driving, use `gh auth login`. If a Machine is driving (Cron, Scripts, CI/CD) OR you need strict security boundaries, generate a Fine-Grained PAT.
- **Current Mode:** Currently I am using pi mostly in my VPS in interactive mode so I use the `gh auth login` method.

---

## 7. TUI Rendering & Color Flattening (The `notify` vs `setWidget` Split)
**The Lesson:** Custom ANSI escape sequences (e.g., `\x1b[38;5;120m`) behave differently depending on the TUI window component used.
- **`ctx.ui.notify()`**: Text displayed via notifications is rendered inside styled modal alert popups. To enforce the theme's aesthetic, Pi's notification component **strips or flattens** custom ANSI escape codes, mapping all text to a uniform theme foreground color (e.g., flat pale green/teal).
- **`ctx.ui.setWidget()` / `ctx.ui.custom()`**: Panels and overlay widgets directly wrap standard Blessed elements. These **fully preserve and render raw ANSI escape sequences**, allowing for high-contrast, multi-colored visual bars, borders, and charts (such as `/wtft` or `/serve`).
- **Duppy's Standard:** 
  - For simple, plain text alerts, use `ctx.ui.notify()`.
  - For rich, color-coded diagnostic summaries or reports, use `ctx.ui.setWidget()` to render a widget, or instruct the user to run the analysis in a clean terminal shell (e.g., executing a raw node script in their background tmux shell) to see un-flattened colors.

---

## 8. Duppy's Workflow & Directory Hygiene
This section documents Duppy's exact preferences for how he drives the Princess-Pi Coding Agent and organizes the workspace. These habits and rules are not documented anywhere on the web:

### A. Non-Production Workspace Hygiene
To keep project directories clean and organized, all non-production files must be explicitly compartmentalized. No "one-off" or temporary debug files are permitted in the repository root:
1.  **`tests/`**: Dedicated solely to permanent, structured, and repeatable test suites that gate code quality (e.g. `tests/yada.test.ts`, `tests/benchmark.ts`).
2.  **`debug/`**: For ephemeral, "quick-and-dirty" scripts written by Princess-Pi to verify assumptions, run diagnostic parsing, or answer one-off telemetry questions (e.g., `debug/parse_histogram.cjs`, `debug/probe_colors.cjs`).
3.  **`research/`**: For prototypes, longer-term experimental code, or architectural draft calculations that may have value for reference but are not yet production-ready.

### B. High-Contrast & Differentiable Visualizations
- When rendering complex logs, charts, or category breakdowns, Duppy has a strong preference for **high-contrast, highly differentiable color schemes** (such as Synthwave or highly neon color ramps) to make different categories instantly distinguishable at a single glance.
- To achieve this, Princess-Pi should always write verification scripts to test local terminal color rendering before deploying colors, ensuring they don't flatten over nested `ssh` or `tmux` boundaries.
