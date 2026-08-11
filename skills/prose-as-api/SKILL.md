---
name: prose-as-api
description: Applies the Agent-First Output standard to a specific surface. Two directions. Designing — choose the machine-readable mode a tool ships (--json, --porcelain, exit codes, typed err.code, column-addressable records), sized so an agent extracts the answer in minimal tokens and zero reasoning steps. Auditing — find state inferred from human-facing prose (error messages, stderr, status text, log lines) where a structured contract belongs, graded by who owns the producer, and file the required bug against any producer shipping no machine-readable mode. Use when applying Agent-First Output, designing or reviewing a tool's output surface, writing code that shells out or handles errors, or on "check for prose parsing", "are we scraping human output", "audit output contracts".
---

# Prose as API

> **Where this file lives.** The copy in `princess-pi-packages/skills/prose-as-api/SKILL.md` is
> the **source of truth**. `~/.claude/skills/prose-as-api/SKILL.md` is a **deploy copy** — edit the
> repo copy, then copy it out. Never the reverse; the dotfile has no history to lose.

This is the working end of **Agent-First Output** (`~/git-projects/CLAUDE.md`): every artifact has
two readers, humans and agents, and neither surface is optional. That standard states the
obligation; this skill is how you meet it on a specific surface — *designing* the contract before
there is code, and *auditing* for the places prose ended up carrying state instead.

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
silently unpublishes it (princess-pi-brain #9; the fix is princess-pi-packages #181, which this
skill found from a cold grep before anyone connected the two).

This is the class that survives an "are we parsing JSON?" review, because the answer is yes.

**So check both layers:** is the container addressable, *and* is the predicate a declared marker
rather than a guess? The fix for a bad predicate is to make identity explicit — a PID file, a
well-known argv flag, an env var the process sets — not a better substring.

---

## Designing the contract — before there is code to audit

Agent-First requires every surface another program may read to have a machine-readable mode.
Shipping one is not the same as shipping a good one.

**Pick the smallest contract that answers the question.** Reach for the top of this table first;
most surfaces never need the bottom.

| the question | contract | not |
|---|---|---|
| Did it work? | exit code | a success sentence |
| What kind of failure? | typed code — `err.code`, HTTP status, documented exit code | message text |
| One fact about one thing | one line, or one key | a document |
| A list of things | one record per line, stable field order | a nested tree |
| Genuinely a tree | JSON, flattest shape that stays honest | prose summary |

**Budget the agent's tokens like you budget the human's attention.** Flat over nested, stable key
names, no decoration, no ANSI. A `--json` that costs 4k tokens to answer *"is it running?"* has met
the letter of the standard and missed the point. When the common question has an expensive answer,
give it a cheap dedicated path — `--quiet`, a bare exit code, a single-field flag — rather than
making every caller parse the whole document to reach one boolean.

**Zero reasoning steps is the bar, not "parseable".** If the agent must join two fields, infer from
absence, or know a convention you never wrote down, the surface still costs reasoning. Name the
thing it will actually ask for.

**Make the prose free.** The payoff of the structured mode is that human-facing copy becomes safe
to reword, retone, translate, and rewrap without a version bump. If a reword would still break
someone, the contract is not carrying its weight yet — find what they are parsing and add it.

**Say what you promise.** Field names, key names, and exit codes are API and are versioned. Prose
is not, and is explicitly disposable. State which is which in the tool's own docs, or the next
maintainer guesses — and guesses conservatively, which means treating the prose as frozen.

---

## Auditing an existing surface — where to look

Start mechanical and cheap. These seeds over-match by design; judgement happens on the hits.

Add `--glob '!node_modules' --glob '!*.mjs'` (or your generated-output equivalent), and exclude
`tests/` on the first pass — test assertions are the dominant false positive and are usually fine
(see *Not findings*).

```bash
# Equality against a prose-shaped literal. The space is MANDATORY — that is what
# separates a sentence from an enum token. Without it this matches every
# `=== "cumulative"` in the repo and the signal drowns.
rg -n --pcre2 '[=!]==\s*["`][a-z]+ [a-z ]+["`]'

# Error/output message matching — the most common instance
rg -n --pcre2 '\.(message|stderr|stdout|output|reason|body|text)\b[^\n]{0,40}\.(includes|match|indexOf|startsWith|endsWith|search|test)\('

# Regex literals that are sentences
rg -n --pcre2 '/[a-z]+ [a-z]+[a-z ]*/[gimsu]*\.test\('

# Shelling out, then reading the prose back
rg -n --pcre2 '(execSync|exec|spawnSync|\$\()[^\n]*\|[^\n]*(grep|awk|sed)\b'
rg -n 'grep -q'

# Structured mode available but unused. Keep the exclusion list HONEST — every
# declared-format flag belongs in it or the seed reports contracts as violations.
rg -n --pcre2 '\b(git (status|log|diff|branch)|docker|kubectl|systemctl|npm|gh)\b(?![^\n]*(--porcelain|--json|-z|--format|--pretty|--show-current|--quiet|--property))'

# HTTP: body text standing in for status
rg -n --pcre2 '(res|response|r)\.(text|body)[^\n]{0,30}\.(includes|match)\('
```

**Calibrate before trusting a seed.** Both of the seeds above carry a comment because the first
run of this skill against `princess-pi-packages` found each of them broken in opposite directions:
the equality seed had no mandatory space and returned 20 hits, 19 of them single-word enum
comparisons; the structured-mode seed omitted `--show-current` and `--pretty` and so reported five
correct, contract-using `git` calls as findings. A seed that over-reports gets muted, which is
worse than not running it. If a seed's hit list is mostly noise, fix the seed and say so in the
report — that is a finding about the audit, not a failure of it.

Then read each hit and apply the audit question. Most surviving hits are still innocent. The
skill's value is the few that are not.

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
→ Add the structured mode, designed per the section above: `--json`, `--porcelain`, a stable
exit-code table, a typed `code` field on thrown errors. Keep the prose for humans; it is now free
to change. If it cannot ship in this change, **file the issue against your own repo before moving
on** — an undeclared contract that everyone knows about is still undeclared.

**C. Third party, structured mode exists.** → Use it. `git --porcelain`, `docker --format`,
`systemctl --property`, `gh --json` all exist and most callers just never looked.

**D. Third party, genuinely no structured mode.** → Real, and the honest answer is not "don't".
Two obligations, both required:

1. **File a bug upstream, in this session.** Agent-First makes this unconditional and it is the
   only clause here that compounds — it is how the ecosystem grows structured modes instead of
   just our corner of it. A conditional version ("when practical") decays to never.
2. **Then contain the parse.** One adapter function, nothing else parses; a comment recording the
   exact tool version whose output was observed; a test against a captured fixture so an upgrade
   fails loudly instead of silently.

The parse remains a liability. It is now a *contained* one, with a tripwire and a filed path out.

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
