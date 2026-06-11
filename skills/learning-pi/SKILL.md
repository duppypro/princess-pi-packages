---
name: learning_pi_extension_api
description: Lessons learned regarding Pi's extension API, session context (CWD), lifecycle events, and Duppy's architectural preferences.
---

# Skill: Pi Extension API & Session Context

This skill serves as a memory bank of architectural lessons learned while developing the Princess-Pi Global Packages suite. It documents how the `@earendil-works/pi-coding-agent` framework handles context under the hood, and how to write extensions that align with Duppy's workflow preferences.

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