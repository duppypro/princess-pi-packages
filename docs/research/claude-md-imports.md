# Spike: does CLAUDE.md import another file's content? (#238)

**Subject:** Can a `CLAUDE.md` pull in another file's content so it is actually *loaded*,
not merely referenced — across Claude Code and Pi, across the project / domain / global
scopes?
**Decision:** **No — don't use `@import` to reach content that lives inside a repo
clone.** Claude Code's import mechanism is real and works as documented, but Duppy's
call (2026-08-11, mid-spike): "the import into CLAUDE.md is a bad idea because I want
the CLAUDE.md to work on machines where princess-pi-packages is not cloned." Tools such
as `pr-open` get installed to `~/bin` without a full clone; `CLAUDE.md` must hold to the
same bar. This settles #234 and #236 without needing #227's "installed artifact" detour.
**Method:** primary-source docs (`code.claude.com/docs/en/memory`), reading Pi's
`core/resource-loader.js` source, and a reproducible fixture at
`research/238-claude-md-imports/run-test.sh`.

---

## Answers to the seven questions

| # | Question | Claude Code | Pi | Status |
|---|---|---|---|---|
| 1 | Supports `@path` imports? | **Yes** | **No** | documented + measured |
| 2 | Which scopes? | User (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md`), and any ancestor-directory `CLAUDE.md` picked up by the directory walk (this is how `~/git-projects/CLAUDE.md` loads today) — same import parser everywhere | N/A — no import parser exists in any scope | documented + measured |
| 3 | Relative or absolute? | Both. Relative resolves **relative to the file containing the import**, not the cwd. Home-relative (`~/...`) works. | N/A | documented + measured |
| 4 | Recursion and depth? | Imports may recursively import; max depth **4 hops** | N/A | documented (not independently measured past 1 hop) |
| 5 | Missing-file behaviour? | **Silent.** No warning, no error, session proceeds normally | N/A | measured |
| 6 | Token accounting? | Imported content is **fully loaded at launch**, same as inline content — "doesn't reduce context, since imported files load at launch" (docs, verbatim). No token win over inlining. | N/A | documented |
| 7 | Does Pi support it? | — | **No.** `loadContextFileFromDir()` in `core/resource-loader.js` does `readFileSync(filePath, "utf-8")` and returns the raw string — no import regex, no expansion, anywhere in the load path. A literal `@./file.md` line is passed through as plain text. | measured (source read + empirical fixture) |

One more measured behavior not in the original seven, load-bearing for anything
resembling a per-host file: **external imports (path resolves outside the working
directory) require an interactive one-time approval dialog.** In headless/non-interactive
mode (`claude -p`, which is what background agents and Workflow subagents use) there is
no dialog to answer, so the import silently stays **disabled** and its content does not
load. An import-based design that depends on `~/.claude/CLAUDE.md` pulling in a file via
an external path would work in an interactive terminal session and silently lose content
in every headless run until a human runs one interactive session first to click through
the dialog. (Imports in *user*-scope files — `~/.claude/CLAUDE.md` importing a file the
same user wrote — skip the dialog per the docs, since Claude Code treats those as
self-authored; only imports from *project*-scope files pointing outside the working
directory trigger it. This still matters for anything that imports across a clone
boundary.)

## Reproduced evidence

The probe asks a fixed, generic question — never the sentinel itself — so a model can't
answer correctly just by re-reading the prompt; it has to have actually seen the
imported file. (Caught in review, PR #239: an earlier version embedded the token in the
question, which would read "yes" for any truthful model regardless of whether the
import expanded.)

```
$ research/238-claude-md-imports/run-test.sh
== Claude Code ==
-- basic relative import (expect: FLAMINGO42) --
FLAMINGO42
-- import of a missing file (expect: no error, session proceeds) --
OK.
-- external absolute-path import, headless/non-interactive (expect: NONE) --
NONE

== Pi ==
-- same basic-import fixture (expect: NONE) --
NONE
```

Re-run the script after either harness upgrades to re-check these still hold — this is
the same staleness class as #217 (a harness behavior recorded once and never
re-verified).

## Why "yes, imports exist" still isn't the answer to #234 and #236

The mechanism works exactly as advertised for Claude Code. It still isn't the right tool
for either issue, for two independent reasons, either of which is sufficient on its own:

1. **Cross-harness gap (question 7).** Pi reads `CLAUDE.md`/`AGENTS.md` raw. Anything
   moved behind a Claude-Code-only `@import` becomes invisible to Pi — a silent,
   harness-specific hole in guidelines that both harnesses are supposed to share. This is
   exactly the risk #238's own body flagged as "the one most likely to be missed."
2. **Cross-machine gap (Duppy's call, 2026-08-11).** `~/git-projects/CLAUDE.md` and
   `~/.claude/CLAUDE.md` must work on a machine that has never cloned
   `princess-pi-packages` — the personal laptop (#229, #233, princess-pi-brain#13) is
   exactly this case. `pr-open` and friends land there via `install-workflow-tools`
   copying scripts to `~/bin`, with **no full clone required**. An `@import` pointing at
   `princess-pi-packages/docs/dev-workflow-spec.md` — or even at a path #227 installs
   from that repo — makes the global/domain `CLAUDE.md` depend on this repo's presence in
   a way the rest of the toolchain deliberately doesn't. Reason 2 holds regardless of
   what #227 eventually decides about installed-artifact paths, so #227 is no longer a
   prerequisite for #234's parent-scope question — the answer is "don't point there via
   import, period," not "point there once there's a stable installed path."

Reason 2 does *not* rule out imports for content that is never repo-clone-relative to
begin with — e.g. `~/.claude/CLAUDE.md` importing a per-host `~/.claude/MACHINE.md` that
some future installer writes directly into the home directory (#236's design). Both
files live in the same guaranteed location on every machine; no clone is involved. But
reason 1 still applies there: Pi's global scope is a *different physical file*
(`~/.pi/agent/AGENTS.md` or `~/.pi/agent/CLAUDE.md`, confirmed to exist and be loaded
independently — see `docs/usage.md`'s "Context Files" section), so a Claude-Code-only
import into `~/.claude/CLAUDE.md` would still be invisible from Pi. Cross-harness parity
for that content needs either duplication (with an assertion test) or a plain filesystem
symlink between the two harnesses' global files — not an `@import`, and only if the
shared content contains no Claude-Code-specific import syntax itself (Pi would pass a
literal `@path` line through as inert text, which is harmless but not what's wanted for
content that's supposed to actually reach Pi's context).

## Recommendation

**#234:** Do not import `docs/dev-workflow-spec.md` into `~/git-projects/CLAUDE.md` or
`~/.claude/CLAUDE.md` in any form. Use the inline-vs-move test from #234's body (*can this
rule be violated in the agent's first tool call, before it has read anything?*) to decide
what stays inline in the thinned, tracked `princess-pi-packages/CLAUDE.md`, and accept
some duplication between that file and the spec for content that fails the test —
gated by a test asserting the duplicated text matches its source, so drift breaks the
build rather than accumulating silently. This was already the documented fallback in
#238's own body for the "imports unsupported or harness-asymmetric" case; both that
condition (Pi) and a second, independent one (cross-machine) now hold.

**#236:** The import mechanism doesn't block the per-host-file design one way or the
other — the real blocker stays what #236 already identified: whether `dotfiles-doctor`
has a per-host concept at all. If/when it does, prefer a plain symlink or an installer
that writes duplicate copies over a Claude-Code-only `@import`, so Pi keeps parity.

## Related

#234, #236, #227, #229, #233, princess-pi-brain#13.
