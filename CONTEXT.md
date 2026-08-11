# Princess Pi Packages

Multi-tool repo for the Princess Pi coding agent: development server, cost tracking, git workflow, and CLI utilities.

## Language — Serve

> **Companion:** `princess-pi-brain/vps-tenancy/vps-tenancy-glossary.md` owns the VPS *deployment*
> vocabulary (Tenant, Zone, Gate, Job, Lane, Release dir, State root). **This file is authoritative
> for the `serve` tool's own internals; that one for deployment meaning.** Where they touched, four
> terms have been sharpened — see "Rulings from the tenancy glossary" at the end of this section.

**Server instance**:
A running process **that `serve` started** to serve a local directory on a loopback port.
Identified by its registry record, not by what its command line looks like (#181) — a process
`serve` did not spawn is never a server instance, however much it resembles one.
_Avoid_: Service, daemon, listener

**Live server**:
A server instance running the native Node.js `run-live-server.js` process. Injects SSE client scripts into HTML, watches files for changes, and pushes live-reload events. This is the default mode — no flag needed. `--static` overrides it.
_Avoid_: Dev server, hot-reload server

**Static server**:
A server instance running `npx http-server`. Serves files as-is — no injection, no watchers, no live-reload. Opted into with `--static` / `-s`.
_Avoid_: Production server, plain server

**Sub-domain**:
A short, URL-safe name that identifies a published preview. Passed via `--pub <subdomain>` (`--as` is a legacy synonym). The public URL is `https://<subdomain>.princess-pi.dev/`. Recorded in the server registry for servers started with `--pub`, and in `~/.config/princess-pi-packages/serve/subdomains.json` for servers published after start. (It is still *passed* to the runner on the cmdline so the live-ACL watcher can see it — but nothing reads it back from there any more, #181.)
_Avoid_: Slug, label, hostname, alias

**Publish**:
Creating the Cloudflare resources for a sub-domain: a Tunnel ingress rule (`<subdomain>.princess-pi.dev → 127.0.0.1:<port>`) and a per-subdomain Access application gated by email OTP. Done by `publishSubdomain()` in `cloudflare.js`. Writes to the sub-domain map. Multiple sub-domains can point to the same port — one directory can have several public URLs.
_Avoid_: Deploy, expose, register

**Alias**:
Adding a new public URL to an already-running server instance. Running `serve <dir> --pub <new-name>` on a directory that's already being served publishes an additional sub-domain pointing to the existing port — no new process spawned. The sub-domain map accumulates sub-domains per port.
_Avoid_: Republish, rename, reassign

**Unpublish**:
Removing the Cloudflare ingress rule and Access application for a sub-domain. Done by `unpublishSubdomain()` on `--kill`. Removes the entry from the sub-domain map. Idempotent — safe to call on already-unsub-domains.
_Avoid_: Takedown, deregister, remove

**Sub-domain map**:
Persistence file at `~/.config/princess-pi-packages/serve/subdomains.json` mapping port numbers to arrays of sub-domains. Written on publish, read during server discovery, cleaned on unpublish. Exists so `--list` can show the public URL for servers published after they started. Deliberately **not** merged into the server registry: a sub-domain outlives the process that published it, so the two have different lifetimes.
_Avoid_: Port registry, sub-domain cache

**Orphan**:
A Cloudflare Tunnel ingress rule pointing at a loopback port that nothing is listening on. Created by crash-without-kill. Reaped on every `serve` invocation by `reapOrphans()`. Note the definition is about the **port**, not about any process identity — reap asks "does anything answer here", never "is this one of ours".
_Avoid_: Stale rule, dangling ingress, zombie

**Reap**:
Scanning Cloudflare Tunnel ingress rules and deleting those that are **serve-owned** (fronted by a `serve `-prefixed Access application, #66) **and** whose port fails a TCP probe — three attempts over ~1.5 s, so a restarting origin is not mistaken for a dead one (#181). Also cleans the local subdomain→port map and any stale advisory lock. Best-effort — failure does not block serving.
_Avoid_: Cleanup, sweep, GC

**Access application**:
A Cloudflare Access resource created per sub-domain. Carries the email allow-list from the served directory's `.serve-acl` file. Authenticates visitors via email One-Time-PIN before they reach the origin.
_Avoid_: Auth app, OAuth app, gate

**Serve ACL**:
The `.serve-acl` file in a served directory. One email per line. Parsed by `parseAclFile()` and fed into the Access application's allow policy on publish.
_Avoid_: Allow-list file, email list

**Loopback**:
The address `127.0.0.1` that all serve processes bind to. No server listens on external interfaces — public access is exclusively through Cloudflare Tunnel.
_Avoid_: Localhost, local-only, internal

**Edge**:
Cloudflare's network. Handles TLS termination (HTTPS), Tunnel ingress routing, and Access authentication. The local serve process never touches certificates or encryption.
_Avoid_: Cloudflare, CDN, proxy

**Discovery**:
Reading the server registry and returning the records that are still running (`discoverServers()` in `process.ts`). Runs on session start, on a 4-second tick for the widget, and on every `--list` / `--kill` invocation. Reads the registry and the sub-domain map — **never `ps`** (#181).
_Avoid_: Scan, enumeration, detection

**Server registry**:
`~/.config/princess-pi-packages/serve/servers.json` — one flat record per server `serve` started, holding `pid`, `startTicks`, `port`, `dir`, `kind`, `subdomain`, `startedAt`. Written at spawn, pruned on discovery, entries removed on confirmed kill. It is the **only** answer to "is this process ours"; `port`/`dir`/`kind`/`subdomain` used to be re-derived from cmdline text on every discovery and are now simply recalled.
_Avoid_: PID file, process table, server list

**Process identity** (`(pid, startTicks)`):
The pair that says a registry record still refers to the process it was written for. `startTicks` is `/proc/<pid>/stat` field 22 — the kernel's start-time-since-boot in clock ticks. A PID alone is not an identity: the kernel recycles them, so a dead server's PID can land on an unrelated process. Verification is three-way — `live`, `dead`, or **`recycled`** (PID exists, ticks differ), and a recycled PID is pruned and never signalled.
_Avoid_: PID (alone), handle, process id

**Unclaimed process**:
A process whose command line *looks* server-like (contains `http-server` or `run-live-server`) but which the registry has no record of starting. Found by `scanUnclaimedServerLike()`. **Advisory only** — reported by `--kill all` in both human text and the `unclaimed` array of `--json`, and never killed. This is the old discovery predicate, demoted: the same guess, now allowed to produce a sentence instead of a SIGKILL target.
_Avoid_: Foreign server, rogue process, orphan (reserved for the ingress sense above)

**Health check**:
An HTTP GET to a server's URL to determine if it's online. Used in `--kill` to report before/after status. Returns `[+] Online (200 OK)` or `[-] Offline (<reason>)`. Human-facing text — anything programmatic reads `--json` instead.
_Avoid_: Probe, ping, status check

**JSON mode**:
`--json`, valid alongside `--list` and `--kill` (#181). Emits one document — `serve/list@1` or `serve/kill@1` — flat, one record per server, stable keys. It is the contract; the Card and Table renderings are copy and may change freely because it exists. Exit codes: `0` success (an empty result set is success), `1` operation failed, `2` usage error.
_Avoid_: Machine mode, porcelain, raw output

**Card**:
A box-drawn status display for a single server instance. Used post-start (shows URL + type + log path), post-kill (shows URL + before/after health status), and on republish. Dynamic-width with gray borders. Rendered by `formatServerCard()` / `formatServerCardKilled()` in `tui.ts`.
_Avoid_: Box, panel, block

**Table**:
An aligned-column status display for multiple server instances. Columns: `SERVED DIRECTORY`, `PORT`, `TYPE`, `URL`. Bold magenta ANSI coloring. Used by `--list` and the Pi TUI widget. Rendered by `formatServerTable()` in `tui.ts`.
_Avoid_: List view, grid, rows

**Widget**:
The Pi TUI panel that displays the server table below the editor. Registered as `serve-ports`. Visible/hidden via `--show` / `--hide` (Pi only). Updated on session start, on a 4-second tick, and after every serve/kill operation.
_Avoid_: Panel, sidebar, status bar

### Rulings from the tenancy glossary

Four `_Avoid_` entries above were written before the VPS gained long-running systemd tenants. None
are reversed — each is **narrowed**, because the avoided word turned out to have one legitimate home.
Source: `princess-pi-brain/vps-tenancy/vps-tenancy-glossary.md` @ `78ccd6c`, 2026-08-09. If this
disagrees with brain, brain wins — the sha is here so `git log` in brain answers "is this stale."

**Service** — *Server instance* avoids it, correctly. Narrowed: **Service** is reserved for a
systemd-supervised long-running process (`kind = "service"` in a tenant manifest). A static tenant is
never a service; a service is never a "server instance." The word is not banned, it is *spoken for*.

**Gate** — *Access application* avoids it, correctly. Narrowed: **Gate** is the declared *policy*
(`"access"` or `"public"`); the **Access application** is the Cloudflare *resource* implementing
`gate = "access"`. A public tenant has a gate and no Access application. Never use "gate" for the
Cloudflare object.

**Slug** — *Sub-domain* avoids it, correctly, **but only for the URL label.** A generated URL-safe
string used for a filename, directory, article path segment or id **may still be called a slug** —
that is its correct general sense. Test: ask what the string *identifies*. A tenant at the edge →
sub-domain. Anything else → slug is fine.

**Origin** — here it means the loopback service behind the edge. In any repo serving browsers it is
the CORS sense: scheme + host + port of the calling page. Both are load-bearing. **In deployment
prose say "loopback service"** and reserve bare *origin* for CORS.

> **Correction — what the earlier "Known bug" note said, and what is actually true (#181).**
> This block used to read: *Server instance* is defined by a `ps aux` match, a **service tenant**
> matches neither substring, so `Reap` classifies it as an `Orphan` and the next `serve` invocation
> silently unpublishes it. **That mechanism was never in the shipped reaper.** `reapOrphans()`
> does not call `discoverServers()` at all — it gates on two independent facts: the hostname is
> fronted by a `serve `-prefixed Access application (ownership, #66 Finding 2), and its port fails
> a TCP probe. A systemd service tenant listening on its loopback port passes both and is kept.
> `git log -S isPortLive` shows the port probe has been there since `reapOrphans` was written
> (`8ae6fde`). The note was describing a coupling that did not exist.
>
> **What is true.** Two separate things, previously conflated:
>
> 1. *Identity* — the `ps` substring was real, and it was in `discoverServers()`, where its cost
>    was that `--kill all` could SIGKILL a process `serve` never started. Fixed by the **Server
>    registry** above (#181).
> 2. *Liveness timing* — reap's port probe was a single 500 ms attempt, so a service tenant that
>    is momentarily down (a `systemctl restart`, a deploy swap) looked dead for that instant and
>    could be unpublished. Narrowed to three probes over ~1.5 s (#181 §4.4). Not eliminated:
>    correct liveness for a `kind = "service"` tenant is a systemd question answered from the
>    manifest's `unit` key, which stays a **princess-pi-brain** concern.
>
> Tracked as **princess-pi-brain #9**, re-scoped accordingly; the other three tenancy gaps are
> **#10**. Getting this right matters beyond the wording — #9 is filed as *"the highest-severity
> known gap"* in the tenancy standard's §11 table, and a severity built on the wrong mechanism
> mis-ranks everything under it.

## Language — WTFT

> **Daemon vs. log parser — two registers, not a winner.** These named the same thing in two
> layers: `daemon` throughout the code (131× in `extensions/lib/wtft-daemon-lib.ts`, 12 filenames),
> `log parser` in user-facing text and, as it turned out, in 28 runtime strings and comments too.
> The first ruling (#162, 2026-08-09) picked **daemon** outright and put `log parser` on the
> `_Avoid_` list. **Reversed 2026-08-10** by Duppy: a single word could not serve both a reader
> meeting the process for the first time and a variable name. The standing ruling is the
> two-register rule in the `Daemon` entry below — **"log parser daemon"** to explain, **"daemon"**
> to refer. What stayed from the first ruling: bare **"log parser"** is still avoided.
>
> *Why the reversal is worth recording.* The original count was taken over docs only, so the
> ruling was made against 13 occurrences when the real surface was 69. `wtft --cleanup` printing
> `Cleaned up 0 log parser(s).` — a runtime string no issue's scope had covered — is what exposed
> both the miscount and the fact that one word was doing two jobs. The sweep is
> [#165](https://github.com/duppypro/princess-pi-packages/issues/165). See
> `docs/spec-160-161-162-wtft-spec-surfaces.md` §4.1 for the original count table and its
> correction.

**Daemon**:
The persistent background process (`bin/wtft-daemon.ts` / `wtft-daemon.mjs`, driven by
`extensions/lib/wtft-daemon-lib.ts`) that watches a session's `.jsonl` file, classifies each
interaction, and writes pre-computed entries to a tag file so the CLI and Pi widget don't
re-parse the whole log on every read. Spawned on `session_start`, auto-revived on idle-timeout
death, auto-replaced on a version bump. Health is exposed via `checkDaemonHealth()` and rendered
via `renderDaemonStatus()`.

*Two registers, one concept.* Say **"log parser daemon"** in high-level user-facing prose — doc
headings, the first mention in any `--help` or manifest description, anywhere a reader is meeting
the process for the first time. Say **"daemon"** as the shorthand everywhere the referent is
already established: code, variable and file names, inline comments, terse operational output
(`Cleaned up 3 daemons.`), and secondary explanations. The long form teaches what it does; the
short form is what you call it once you know. Neither is a synonym to be swapped freely — pick by
whether the reader needs teaching.

*Tie-break, when "first mention" is ambiguous.* Scope it to **the surface a reader sees in one
screen**, not to the file. A `--help` block whose header already says "Log parser daemon" has
established the referent, so its flag lines say "daemon". A manifest `desc` string is
independently addressable — `--why` and per-flag lookups render it with no header above it — so
each one carries the full form itself. Same rule, opposite outcomes, because the unit of reading
differs.

*When the long form does not fit.* Fixed-width surfaces — ASCII box diagrams, aligned help
columns, the title-line status indicator — take the shorthand, and the surrounding prose does the
teaching. Never widen a box or truncate a word to force the long form in. `wtft-daemon` in a
diagram needs no gloss at all when the section heading above it already says "Log parser daemon";
the parenthetical `(log parser)` that used to sit there existed only to bridge two unreconciled
names, and reconciling them retired it.
_Avoid_: bare "log parser" (always promote to "log parser daemon"), watcher, background process,
session parser

**Daemon health reason** (the code) / **status text** (the sentence):
Two different things, deliberately (#179). A **health reason** is one of six machine-readable
codes on the `DaemonHealthReason` union — `not-started`, `starting`, `waiting-session`,
`not-found`, `idle-timeout`, `restart-failed`. It is the contract: control flow compares codes,
and `tsc` rejects a typo'd comparison. **Status text** is what the user sees, looked up from
`DAEMON_REASON_TEXT` by `daemonReasonText()` and rendered only inside `renderDaemonStatus()`.
Reword the text freely — nothing reads it. Renaming a code is a breaking change.

Say "health reason" (or "the code") when you mean the value a program branches on; say "status
text" when you mean the words in the indicator. They were one `string` field until #179, which is
what let a rename in #165 nearly regress #124's startup grace window.
_Avoid_: using "reason" alone for the displayed sentence; "status string" for the code

**Interval**:
The user-specified size+unit that decides how interactions are grouped — the `-i, --interval`
value (e.g. `4h`, `5t`), parsed by `parseInterval()` into an `IntervalConfig`. An interval is a
*request*; a bin (below) is the concrete result of applying one.
_Avoid_: Bucket (see the Bin/Bucket split below), window, period

**Bin**:
The concrete time-or-turn slot an interaction is grouped into, computed by `getBinInfo()` from
an `IntervalConfig` and a timestamp — e.g. "the `22:00` bin" or "turn-bin `000010`". Binning
happens identically regardless of render mode; every render bins first, then decides how to
display each bin's total.
_Avoid_: Bucket — reserved for the render mode, not the grouping unit. This split is intentional:
`getBinInfo()` never returns anything the code itself calls a "bucket," but comments and prose
sometimes use "binned"/"bucket" as loose synonyms for this concept. They are not the same word
in the type system (`IntervalConfig`, `mode: "bucket" | "cumulative"`) and should not be treated
as interchangeable in new prose.

**Bucket (mode)**:
One of the two render modes, set by `-b/--bucket` (the other is `-c/--cumulative`, default):
shows each bin's own discrete total rather than a running sum. `mode: "bucket" | "cumulative"`
in `wtft-renderer.ts`/`wtft.ts`. Not a grouping concept — see Bin above. Also overloaded once,
harmlessly: `wtft-renderer.ts:1292` has an unrelated local variable named `buckets` (a `Map`
used only for same-column marker tie-breaking inside *cumulative*-mode rendering) — it is not
the `-b/--bucket` flag and should not be confused with it when reading that function.
_Avoid_: Bin (see above), interval

**Cumulative (mode)**:
The default render mode (`-c/--cumulative`): each bin's bar shows the running sum of cost up to
and including that bin, not just that bin's own total. Guarantees monotonically non-decreasing
bar widths (#106).
_Avoid_: Running mode, total mode

**Session**:
One coding-agent conversation's append-only `.jsonl` log — the unit wtft parses, classifies, and
renders costs for. Identified by a UUID-bearing basename (Claude Code) or a
timestamp-prefixed UUID basename (Pi); see `isSessionIdBasename()`.
_Avoid_: Chat, conversation, log (ambiguous with "tag file", below), transcript

**Sidechain**:
A subagent's own interaction stream within the *same* session file — marked
`Interaction.isSidechain`, excluded from prevCtx recache-signature tracking because it does not
share the parent turn's context window. Distinct from a subagent session (below): a sidechain is
inline entries in one file; a subagent session is a separate file.
_Avoid_: Sub-thread, branch, fork

**Subagent session**:
A separate `.jsonl` log for a spawned subagent, stored under `<session-id>/subagents/` (Claude
Code). wtft recursively discovers and blends these chronologically into the parent's timeline
(Recursive Subagent Rollup). Distinct from a sidechain (above), which lives inline in the parent
file rather than as its own file.
_Avoid_: Child session, nested session

**Tag file**:
The per-session output file the daemon writes classified entries to:
`wtft-tags/<session>.wtft-tag.v{N}.jsonl`. One tag file per source session, versioned so a
daemon upgrade can detect and replace a stale one. Read by `readClassifiedTagFile()`.
_Avoid_: Cache file, index file

**Tags dir**:
The `wtft-tags/` directory itself — one per project/session root, holding every tag file for
sessions discovered there. `wtft-parser.ts` explicitly excludes it from session discovery
("`wtft-tags` is our own output") so the daemon never treats its own writes as a session to
parse.
_Avoid_: Tag cache, output dir

**Surge (window / pricing)**:
DeepSeek's peak-valley pricing: specific UTC hour ranges (01:00–04:00 and 06:00–10:00) billed at
a 2× multiplier. `getSurgeLocalHours()` converts the UTC windows to the display timezone;
`checkSurgeProximity()` reports whether the current time is inside, approaching (≤20 min), or
ending (≤20 min) a window. Rendered as the SURGE Timeline badge and orange segments.
_Avoid_: Peak pricing, rush hour, premium window

**Category** (the classification vocabulary):
The `Category` union (`extensions/lib/wtft-parser.ts`) an interaction is classified into:
`plan`, `spec`, `research`, `web`, `grep`, `code`, `tests`, `git`, `agents`, `prompt`,
`compaction`, `interrupted`, `overhead`, `other`. Display labels differ from the type names for
the Phase-3 overhead trio: `compaction` → **Cmpct**, `interrupted` → **Waste**, `overhead` →
**Ovrhd** (`CATEGORY_STYLE` in `wtft-renderer.ts`). Use the type name in code/tests, the display
label only in UI-facing prose.
_Avoid_: Type, tag, class, bucket (see Bin/Bucket — a category is not a bin)

**Overhead vs. waste vs. compaction** (the Phase-3 trio, #52):
Three distinct causes of cost that isn't the model doing requested work, each its own category:
- **Overhead** (`Ovrhd`) — a full-context recache: the 1h cache tier rewrote, driven by a
  recache signature the parser detects from raw usage.
- **Waste** — a turn the user killed (`interrupted: true`); its whole cost is discarded work,
  not overhead from re-priming.
- **Compaction** (`Cmpct`) — a turn immediately following a compact summary
  (`afterCompaction: true`); its cache-write component is specifically the compaction bill.
_Avoid_: Using "overhead" as an umbrella term for all three — each has a different cause and a
different fix; conflating them was the exact ambiguity #52 Phase 3 resolved.

**Thinking level**:
A *signal* — the model's current reasoning-depth setting, read from a harness event
(`thinking_level_change`) and carried on `Interaction.thinkingLevel`. Describes what happened.
_Avoid_: Thinking budget (see below — a different concept, not a synonym)

**Thinking budget**:
A *CLI input* — the `--thinking-budget <n>` flag, a token budget used only to compute a
utilization percentage in `--tokens`/`--by-model` output. Not read from the session; supplied by
the caller. Describes a ceiling to compare against, not what happened.
_Avoid_: Thinking level (see above)

**Harness**:
The coding-agent runtime a session log came from — `pi` or `claude-code`, selected via
`--harness <pi|claude-code|auto>` (default `auto`). Determines which session-discovery and
parse adapter (`extensions/lib/harness/<id>/`) wtft uses. Not the same as "widget" (below) —
harness is about which agent produced the log; widget is about how wtft displays it.
_Avoid_: Agent, client, platform

**Widget**:
The persistent TUI panel wtft renders below the editor inside the Pi harness — auto-shown on
session start if config exists, toggled via `-S/--show` / `-H/--hide`. Distinct from the CLI
(below): the widget only exists inside Pi.
_Avoid_: Panel, sidebar (reserved for `serve`'s widget in this repo's `Language — Serve` section)

**CLI**:
Running `wtft` (or `./wtft`, or the npm-global install) directly from the host shell, outside
Pi — reuses the same classification engine as the widget but prints to stdout. Supports modes
the widget does not (`--other` histogram, `-p` pager, `--watch`).
_Avoid_: Standalone mode, binary (the binary is `bin/wtft.mjs`; "CLI" names the usage mode)

**Pager**:
`-p/--pager` — a fullscreen, interactive, scrollable TUI overlay for browsing expanded cost
history. A CLI-only feature (not available inside the Pi widget itself, which is not
fullscreen).
_Avoid_: Scroll mode, viewer

**Watch mode**:
`--watch` (`-W`) — a companion-terminal mode that tails a session file and re-renders in
real-time as new interactions are logged, until `Ctrl+C`/`q`. Distinct from the widget's own
periodic refresh (which lives inside Pi); watch mode is a standalone CLI process meant to run in
a separate pane.
_Avoid_: Live mode, tail mode
