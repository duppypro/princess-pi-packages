# Spec — #181: serve discovers its servers from a registry, not from a `ps` substring

**Issue:** [#181](https://github.com/duppypro/princess-pi-packages/issues/181)
**Status:** Code and Spec Approved
**Related:** #180 (the `prose-as-api` skill that found it), #179 (same family), #39, #66, #119,
princess-pi-brain #9

---

## 1. The bug — the predicate, not the parse

`extensions/lib/serve/process.ts:38`:

```ts
exec("ps aux | grep -E 'http-server|run-live-server' | grep -v grep", …)
```

The **container** is fine. `ps aux` is headerless, whitespace-delimited and
column-addressable — exactly the shape the Agent-First standard carves out as already
machine-readable. The **predicate** is the bug:

> *a server instance is any process whose command line contains one of these two substrings.*

That is an inference about **identity** from free text. Nobody adding a wrapper, renaming a
binary, or launching through a different entry point would call it a breaking change — so
there is no contract, only a guess that has held so far.

### What the guess actually costs

Both directions are wrong, and they are not equally bad:

| | What happens | Severity |
|---|---|---|
| **False positive** — a foreign process whose cmdline contains the substring | It is listed as ours, and `serve --kill all` **kills it by the PID read out of `ps`** (`bin/serve.ts:127` → `killServerInstance`) | destructive |
| **False negative** — one of ours launched via a wrapper or renamed binary | Invisible to `--list`, unkillable by `--kill` | leaks processes |

The false positive is the one that matters. `--kill all` is documented as *"Instantly
terminate every active dev server across all worktrees"* and reaches for `SIGKILL`. The set
it operates on is defined by a substring match against every process on the box.

## 2. Correction — brain #9 and this repo's own glossary are both stale

The issue, `CONTEXT.md`, and **princess-pi-brain #9** all say the same thing:

> `reapOrphans()` decides whether a published tenant is still alive by matching
> `run-live-server` or `http-server` in `ps aux`. A service tenant matches neither … the
> next `serve` invocation silently unpublishes every service tenant on the box.

**That is not what the shipped reaper does.** `reapOrphans()` (`cloudflare.js:509`) never
calls `discoverServers()`. It gates on two independent facts:

1. the hostname is fronted by a `serve `-prefixed Access application (`#66` Finding 2 —
   ownership), and
2. `isPortLive(port)` — a **TCP connect to `127.0.0.1:<port>`**.

A systemd service tenant listening on its loopback port passes both, and is kept. `git log
-S isPortLive` confirms the port probe has been there since `reapOrphans` was first written
(`8ae6fde`, Phase 6B) — the `ps`-based reaper the issue describes never shipped in this form.

**The residual risk is real but different, and smaller.** `isPortLive` is a single probe with
a 500 ms timeout. A service tenant that is *momentarily* down — a `systemctl restart`, a
deploy swap — looks dead for that instant, and a `serve` invocation landing in that window
does unpublish it. The window is seconds, not permanent, and it is a **liveness-timing** bug,
not an **identity** bug.

Both corrections landed. The glossary, the tenancy standard's §11 table and brain's `_index.md`
now state the mechanism correctly, and §4.4 narrows the timing window. Getting this right
mattered more than usual — brain #9 was filed as *"the highest-severity known gap"* in that
table, and a severity rating built on the wrong mechanism mis-ranks everything under it. #9
drops from highest severity because the identity half of it was never real; the timing half
survives, narrowed.

## 3. Direction — identity is declared, liveness is measured

The issue offered three directions. Taking **registry as truth**, per @duppypro:

> *even though the ps column is stable it is fragile to other tools injecting processes with
> similar names. Don't rely on ps names, register the PID.*

We spawn every server we own. That means identity is a fact we **have** at spawn time, and
everything after is bookkeeping. The `ps` scan exists only because we were throwing that fact
away and re-deriving it.

```
spawn ──► registry record   (identity: declared, exact)
              │
              ├─► liveness   (pid, startTicks) still matches ──► ours, alive
              └─► ps scan    ONLY to warn about processes we did NOT start (advisory)
```

The `ps` heuristic does not disappear — it is **demoted**. It stops deciding what we kill and
becomes an advisory that reports what it cannot account for (§3.3). A guess is fine when its
output is a sentence to a human; it is not fine when its output is a `SIGKILL` target.

### 3.1 Why `(pid, startTicks)` and not `pid` alone

A bare PID registry moves the bug rather than fixing it. **PID reuse:** our server dies, the
kernel recycles its PID onto an unrelated process, and the registry now claims a stranger is
ours — with `--kill` pointed at it. Same destructive failure, new mechanism.

The corroborating field must be **exact, not a name**. Checking the recycled PID's cmdline
against `http-server` would be corroborating a declared fact with a guessed one — strictly
worse than checking nothing, because it looks rigorous.

`/proc/<pid>/stat` **field 22** (`starttime`) is the process's start time in clock ticks since
boot. It is an integer, it is assigned by the kernel, and a recycled PID cannot reproduce it.
`(pid, starttime)` is the canonical Linux answer to *"is this still the same process"* — the
identity pidfd and systemd use.

Parsing note: field 2 (`comm`) is parenthesised and may itself contain spaces and parens, so
the only safe split is **after the last `)`**. Verified on this box: `pid 1` → `52` ticks,
a live node process → `231512470`.

Verification is therefore three-way, because "recycled" deserves its own name:

| Verdict | Condition | Action |
|---|---|---|
| `live` | PID exists **and** `startTicks` matches | it is ours, it is running |
| `dead` | PID does not exist | prune the record |
| `recycled` | PID exists, `startTicks` differs | prune the record, **never touch the PID** |

Where `/proc` is unavailable (non-Linux), `startTicks` is `null` and verification degrades to
PID-existence. Recorded as a known weaker mode rather than pretended away; this repo's target
is a Linux VPS.

### 3.2 What the registry holds

`~/.config/princess-pi-packages/serve/servers.json`, alongside the existing sub-domain map:

```json
{
  "version": 1,
  "servers": [
    { "pid": 12345, "startTicks": 231512470, "port": 8080,
      "dir": "/home/princess-pi/git-projects/x/dist", "kind": "live",
      "subdomain": "x-preview", "startedAt": "2026-08-10T18:29:39Z" }
  ]
}
```

Flat, one record per server, stable keys. Writes are temp-file + `rename` (atomic) — two
`serve` invocations can race, and a torn registry is worse than a stale one.

This **subsumed** the `ps` column-parse entirely. `port`, `dir`, `kind` and `subdomain` used
to be re-derived from cmdline text on every discovery — a port regex, an index walk skipping
flag values, and a `--subdomain` regex. All of it is gone: we knew every one of those values
at spawn time.

### 3.3 The advisory scan (@duppypro's answer to Q3)

> *kill -all should report human and agent readable versions of warnings listing 'server-like'
> processes that it has no memory of starting. warning/info only*

`scanUnclaimedServerLike()` keeps the heuristic, with its status changed:

- Runs `ps -eo pid=,args=` — headerless, two columns, no shell pipeline. The old
  `| grep -E … | grep -v grep` is gone; the `grep -v grep` existed only to undo the shell
  pipeline's own footprint, so removing the pipeline removes the need for it.
- Matches the same two substrings, **explicitly labelled a heuristic in the source.**
- Subtracts every PID in the registry.
- Returns typed records; **kills nothing, lists nothing as ours.**

`--kill all` prints what it could not account for and moves on. This is the honest version of
what the substring was doing all along — the difference is that the guess now produces a
warning instead of a signal.

### 3.4 Consequence, accepted deliberately

Discovery narrows to **servers `serve` started**. A hand-started `npx http-server` no longer
appears in `--list` and is no longer killed by `--kill all` — it appears in the advisory
instead. Confirmed with @duppypro as the wanted safety property: `--kill all` should not be
able to kill something it never started.

Servers started by a `serve` from *before* this change have no registry record and become
advisory entries. One-time, self-clearing, and the advisory tells the user exactly which PIDs
to deal with.

## 4. Scope

### 4.1 New — `extensions/lib/serve/registry.ts`

`ServerRecord`; `readProcessStartTicks()`; `registerServer()`; `unregisterPid()` /
`unregisterPort()`; `verifyRecord() → "live" | "dead" | "recycled"`; `liveServers()`
(verify + prune + write back); atomic write.

### 4.2 `process.ts`

`discoverServers()` reads `liveServers()` and builds `ServerInstance`s from record fields —
no `ps`, no cmdline regexes. Sub-domain still falls back to the sub-domain map for
publish-after-start (#119). New `scanUnclaimedServerLike()`.

### 4.3 `bin/serve.ts` + `extensions/serve.ts`

Register after spawn; unregister on kill; advisory warning on `--kill all`; **`--json` for
`--list` and `--kill`** — serve has no machine-readable mode at all today, so the standard's
"required of everything we ship" is unmet before this issue even starts. Schema in §5.

### 4.4 `cloudflare.js` — the residual timing window from §2

`isPortLive()` gained a small retry (3 probes over ~1.5 s) before reporting dead, split over a
new single-shot `probePortOnce()`. Cheap, and
it is the actual residual risk behind brain #9 once the mechanism is stated correctly. Full
kind-aware liveness (ask systemd for a `kind = "service"` tenant) stays a brain concern —
this only narrows the window.

### 4.5 Port selection — an unplanned consequence, found by the smoke test

Not in the spec draft. Found only when the CLI was run end-to-end against a real directory:
`serve` picked port 8080, which rogue-aix prod had held since Aug 05, and the spawn died on
`EADDRINUSE` with no message.

The cause is a dependency nobody had written down. Port allocation read:

```ts
while (activeServers.some(s => s.port === startPort)) startPort++;
```

That only ever worked because `discoverServers()` returned **every server-like process on the
box**. Narrowing discovery to servers we started removed the one thing keeping `serve` off
other people's ports.

**The narrowing did not cause this — it exposed it.** "Is this port free" was always the
question, and answering it by scanning a process table for name-alikes was the *same*
infer-from-a-proxy mistake as the substring predicate, one layer down. It happened to work
while the proxy was wide enough to cover the real answer.

Replaced with `isPortFree()` / `findFreePort()` in `process.ts`: bind a probe socket to
`127.0.0.1:<port>`, close it, take `EADDRINUSE` for an answer. Bounded to a 100-port window so
a saturated range fails loudly rather than spinning.

Worth recording as a method note: the unit suite was fully green when this bug was live. It
took running the actual command against the actual box to surface it, because the failure was
in an *interaction between a change and an unstated assumption* — precisely the class a test
written from the same mental model as the change cannot see.

### 4.6 Documentation

- `CONTEXT.md` — *Server instance*, *Discovery*, *Orphan*, *Reap* rewritten off the
  mechanism; new *Server registry* and *Unclaimed process* entries; the "Known bug this
  vocabulary exposes" note replaced with what is actually true.
- `princess-pi-brain` — tenancy glossary `Reap` row, standard §11 table (two rows), and
  `_index.md` #9 entry corrected on branch `9-reap-mechanism-correction` (`c42b466`).
  **Not pushed:** brain is private and the `princess-pi-bot` token holds only `public_repo`.
  Awaiting @duppypro. The comment on brain #9 is drafted but unposted for the same reason —
  posting it would mean using @duppypro's own credentials, which is his call, not mine.
- `docs/manifests/serve-cmd.json` — `--json`; `docs/EXT_SERVE.html` index row.

**Out:** kind-aware (`.tenant.toml`) liveness in reap — brain's, not this repo's. Migrating
the sub-domain map into the registry — they have different lifetimes (a sub-domain outlives
the process that published it) and merging them is its own cycle.

## 5. The `--json` contract

One flat record per server, stable keys, no decoration.

```json
{"schema":"serve/list@1","servers":[
  {"pid":12345,"port":8080,"dir":"/abs/dir","kind":"live","subdomain":"x-preview",
   "url":"https://x-preview.princess-pi.dev/","localUrl":"http://127.0.0.1:8080","title":"Index Page"}
]}
```

```json
{"schema":"serve/kill@1",
 "killed":[{"pid":12345,"port":8080,"dir":"/abs/dir","subdomain":"x-preview","confirmed":true}],
 "failed":[{"pid":12346,"port":8081,"reason":"not-confirmed-dead"}],
 "unclaimed":[{"pid":9001,"port":3000,"command":"node /opt/x/http-server.js"}]}
```

`reason` is a code, not a sentence — #179's ruling, applied at the point of writing rather
than retrofitted.

Exit codes: `0` success (an empty result set is success), `1` operation failed, `2` usage
error. Documented in the manifest so it is a contract rather than an observation.

`unclaimed` is present in `--json` **whenever** it is printed to a human, so the two surfaces
never disagree about what was found.

## 6. Verification

`tests/serve-181-registry.test.ts` — **39 assertions, 0 failures.**

| # | Check | Result |
|---|---|---|
| V1 | **PID reuse produces no false claim.** A record whose `startTicks` disagree with a live PID verifies `recycled`, is pruned from disk, and the PID is never returned — asserted alongside "the impostor process is still alive", so the test proves we did not simply kill it. `dead` (PID gone) is distinguished from `recycled` (PID reused). | pass ×7 |
| V2 | **A listener `serve` did not start is not ours.** A real loopback listener is absent from `discoverServers()`; a decoy named `run-live-server.js` appears in `unclaimed`, keeps running, and leaves the advisory the moment it is registered. | pass ×7 |
| V3 | **The false-negative half.** A server under a name the old predicate could not match (`totally-unrelated-name.js`) is discovered, with `dir` and `kind` recalled from the record. The same test asserts the substring heuristic is blind to it — the old failure, demonstrated. | pass ×4 |
| V4 | **No `ps` predicate in control flow.** Comments are stripped before scanning, so the assertion reads executable code (the comments deliberately quote the old pipeline). Exactly one `ps` invocation in the module, inside `scanUnclaimedServerLike`; `discoverServers` contains no `exec` at all. | pass ×6 |
| V5 | **`--json` is a contract.** Parses as one document, versioned `schema` key, `pid`/`kind`/`dir`/`subdomain` recalled from the record; the human `--list` names the same port. Empty registry → exit 0 with a valid empty document; bare `--kill` → exit **2**, still a valid `serve/kill@1`. | pass ×12 |
| V6 | **Reap tolerates a restart window.** A port that binds ~700 ms late reads live under the 3-probe budget, and the shipped `isPortLive` is asserted to carry that retry. | pass ×3 |
| V7 | Full suite | **53/53** |

Also run: `bun run typecheck` (clean) and `bash tests/serve-no-sudo-nginx.test.sh` (ZERO-SIDE-EFFECT PROOF PASSED) — the hand-run shell suite, because this branch changes the serve start/kill cycle it strace-audits.

### 6.1 The red-proof lives in the suite

V2 does not merely assert the new behaviour — it runs the **original** predicate
(`ps aux | grep -E 'http-server|run-live-server' | grep -v grep`) against its own decoy and
asserts that it *does* match. The bug is reproduced in-suite, not described in a comment. If
it ever stops reproducing, the contrast this whole suite rests on has changed and the test
says so.

### 6.2 Live end-to-end result

Run against this box, with five pre-registry servers already up:

```
$ ./serve --kill all --json
{"schema":"serve/kill@1",
 "killed":[{"pid":623879,"port":8084,…,"confirmed":true}],
 "failed":[],
 "unclaimed":[{"pid":3572038,"port":8080,"command":"… rogue-aix/prod --subdomain rogue-aix …"},
              {"pid":3572096,"port":8081,"command":"… rogue-aix/dev …"}, …]}
```

`--kill all` terminated the one server it started and **left rogue-aix prod and dev
running**. Under the substring predicate all five would have been SIGKILLed — including a
production tenant — by a command aimed at dev servers. That is the bug this issue is about,
observed being absent.

### 6.3 Migration note

Servers started by a pre-#181 `serve` carry no registry record, so they become `unclaimed`:
listed by the advisory, not by `--list`, and not killed by `--kill all`. Self-clearing on
next restart, and the advisory names the exact PIDs. On this box that is the five above.

---

— 👑π🐱 Princess Pi
