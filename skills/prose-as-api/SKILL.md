---
name: prose-as-api
description: Audit code for state inferred by matching human-facing prose — substring/regex against error messages, stderr, status text, or log lines used to drive control flow. Reports each finding graded by who owns the producer, with the structured contract that should replace it. Use when the user says "check for prose parsing", "are we scraping human output", "audit output contracts", during code review of anything that shells out or handles errors, or before shipping a tool whose output another program reads.
---

# Prose as API

**The rule.** A message written to be read by a human is not an API. Match on it and you have
created an undeclared interface with no stability promise — the producer can reword, retone,
rewrap, translate, or colorize it and will never call that a breaking change. Your control flow
breaks and no test fails.

**The audit question, applied to every candidate:**

> If the producer reworded this message for clarity tomorrow, would this code silently change
> behavior — and would the producer consider that a breaking change?

Silent behavior change + "no, that's just copy" = finding.

---

## The line: position-or-key vs. semantic match

The distinction is **not** JSON-vs-text. Plenty of plain text is a real contract.

**Structured — fine to consume.** The datum is addressable by *position or key* without
understanding any prose:

| shape | access | example |
|---|---|---|
| Headerless records, whitespace fields | column number | `ps aux`, `ls -l`, `df` → `awk '{print $2}'` |
| Machine modes | key | `git status --porcelain`, `--json`, `jq .pid` |
| NUL / delimiter separated | field index | `find -print0`, `cut -d: -f3` |
| Exit codes | integer | `if ! cmd; then` |
| Typed error codes | property | `err.code === "ENOENT"`, HTTP `res.status === 404` |

These survive rewording because nothing in them *is* wording. `ps aux` can change its header text
and column 2 is still the PID.

**Prose — avoid.** The datum is recovered by matching meaning inside a sentence:

```ts
err.message.includes("no such file")        // err.code exists. Use it.
stderr.match(/permission denied/i)           // exit code exists. Use it.
health.reason === "daemon not found"         // a display string as a control token
if (out.includes("up to date")) skipPush()   // --porcelain exists. Use it.
```

**Tell-tale shape for the grep pass:** a string or regex literal containing an internal space and
ordinary lowercase words, used in a conditional. Prose has spaces; contracts usually don't.

---

## The sharper edge: structured container, prose predicate

A finding can hide inside perfectly structured output. `ps aux` is column-addressable, but *what
you ask about the column* can still be a guess:

```
Discovered by parsing `ps aux` for `run-live-server` or `http-server` processes.
```

The container is fine. The **predicate** — "identity is whatever process has this substring in its
command line" — is an inference about meaning, and it fails the audit question: nobody renaming a
binary or adding a wrapper considers it a breaking change.

This repo already shipped the bug. `CONTEXT.md`'s *Server instance* entry defines discovery exactly
that way, and the entry three paragraphs down records the consequence: a systemd service tenant
matches neither substring, so `Reap` classifies it as an `Orphan` and the next `serve` invocation
silently unpublishes it (princess-pi-brain #9).

**So check both layers:** is the container addressable, *and* is the predicate a declared marker
rather than a guess? The fix for a bad predicate is to make identity explicit — a PID file, a
well-known argv flag, an env var the process sets — not a better substring.

---

## Where to look

Start mechanical and cheap. These seeds over-match by design; judgement happens on the hits.

```bash
# Error-message matching — the single most common instance
rg -n --pcre2 '\.(message|stderr|stdout|output|reason|body|text)\b[^\n]{0,40}\.(includes|match|indexOf|startsWith|endsWith|search|test)\('

# Equality against a prose-shaped literal (internal space, plain words)
rg -n --pcre2 '[=!]==\s*["`][a-z][a-z ]{6,}["`]'

# Regex literals that are sentences
rg -n --pcre2 '/[a-z]+ [a-z]+[a-z ]*/[gimsu]*\.test\('

# Shelling out, then reading the prose back
rg -n --pcre2 '(execSync|exec|spawnSync|\$\()[^\n]*\|[^\n]*(grep|awk|sed)\b'
rg -n 'grep -q'

# Structured mode available but unused — flag the call, then check the man page
rg -n --pcre2 '\b(git (status|log|diff|branch)|docker|kubectl|systemctl|npm|gh)\b(?![^\n]*(--porcelain|--json|-z|--format|--quiet))'

# HTTP: body text standing in for status
rg -n --pcre2 '(res|response|r)\.(text|body)[^\n]{0,30}\.(includes|match)\('
```

Then read each hit and apply the audit question. Most hits are innocent (assertions on help text,
logging, tests). The skill's value is the few that are not.

---

## Grade every finding by who owns the producer

The owner determines the fix, so report it:

**A. You own both sides** (same repo, same module or two of yours).
→ Export the contract as a symbol. A shared constant retires the typo; a **union type** is
stronger, because `tsc` then rejects a misspelled comparison instead of compiling it to an
always-false branch. Worked example: princess-pi-packages #179.

```ts
export type DaemonHealthReason = "not-found" | "not-started" | "session-removed" | "idle-timeout";
// display text becomes a lookup keyed off the token, never the token itself
```

**B. You own the producer, someone else consumes it** (your CLI, your library).
→ Add the structured mode and say so: `--json`, `--porcelain`, a stable exit-code table, a typed
`code` field on thrown errors. Keep the prose for humans; it is now free to change. This is the
standing practice — **any output another program is expected to read gets a machine-readable
option**.

**C. Third party, structured mode exists.** → Use it. `git --porcelain`, `docker --format`,
`systemctl --property`, `gh --json` all exist and most callers just never looked.

**D. Third party, genuinely no structured mode.** → Real, and the honest answer is not "don't".
Isolate it: one adapter function, nothing else parses; a comment recording the exact tool version
whose output was observed; and a test against a captured fixture of that output so an upgrade
fails loudly instead of silently. The parse is still a liability — it is now a *contained* one
with a tripwire.

---

## Not findings

Say so explicitly; a checker that cries wolf gets muted.

- **Assertions on prose as the deliverable.** A test asserting `--help` says the right thing is
  testing the copy *as copy*. Fine. The smell is inferring *state* from copy.
- **Logging, telemetry, display.** Reading a message to show or record it drives nothing.
- **Substring match on a genuinely stable identifier** inside a structured field — a UUID, a
  well-known path, a documented error code embedded in a larger string.
- **Column-addressable parsing with a declared predicate** — `ps` output filtered by a PID you
  wrote to a PID file is fine; filtered by "the command line looks like ours" is finding C/D above.

---

## Report

Per finding: file:line, the two sides (producer and consumer, if both are in reach), the grade
(A–D), the audit question's answer in one line, and the concrete replacement contract. Group by
grade — A findings are usually a single small commit, D findings are design work.

End with what was searched and what was deliberately not flagged, so the next run can tell a clean
result from an unrun one.
