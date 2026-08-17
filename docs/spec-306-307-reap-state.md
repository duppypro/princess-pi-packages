# Spec — #306 / #307: two `serve` clocks become state checks

**Issues:** [#306](https://github.com/duppypro/princess-pi-packages/issues/306), [#307](https://github.com/duppypro/princess-pi-packages/issues/307) — label `race-sleep-audit`
**Status:** Code Approved (tests green), spec reconciled
**Related:** #181 (server registry — the second fact), #66 (reap-on-start), #308 (same audit, wtft), princess-pi-brain #9

---

## 1. The principle

Same as #308: a clock is not a fact. Both findings came from the 2026-08-17 sweep for arbitrary
sleeps standing in for race-condition fixes. #306 was ranked HIGH because its failure mode is
destructive and outward-facing; #307 MEDIUM because it misreports.

## 2. #306 — reap-on-start

**Was:** `reapOrphans()` deleted a serve-owned tunnel ingress rule (and its Access app) on one
fact — `isPortLive(port)`: 3 TCP probes over ~1.5 s failed. A systemd service tenant mid-`restart`,
or a server taking >1.5 s to bind, was unpublished; and the tenant losing its edge was not the one
running `serve`. The code's own comment said it: *"This only narrows the timing window, which is
the real residual risk."*

**Is:** the probe stays **necessary**, and stops being **sufficient**. The second fact is the #181
registry — the record `serve` wrote at spawn for every process it owns, verified against the
kernel by `(pid, startTicks)`:

| probe | registry verdict for the port | decision | why |
|---|---|---|---|
| answers | — | `keep-live` | still serving |
| silent | `dead` / `recycled` | **`reap`** | our process is verifiably gone — the crash-without-kill the reaper exists for |
| silent | `live` | `keep-starting` | our process is alive and not answering yet — starting or wedged, not gone |
| silent | no record | `keep-unverified` | serve never spawned it (a service tenant, or a pre-#181 orphan) — not ours to delete on a probe; **reported**, not silent |

`classifyReapCandidate({port, probeLive, evidence})` in `extensions/lib/serve/cloudflare.js` is
that table, pure and exported. `reapOrphans({evidence, onReaped, onUnverified})` takes the
evidence by **injection**: `cloudflare.js` must stay plain-node importable (`run-live-server.js`
loads it) and the registry is TypeScript, so callers pass
`readRegistry().map(r => ({port: r.port, verdict: verifyRecord(r)}))`. Omit `evidence` and every
silent port is unverified — nothing is reaped (fail-safe for a legacy caller). `onReaped` lets
the caller `unregisterPort` the record that served as evidence; `onUnverified` prints
`⚠️ <host> → 127.0.0.1:<port> is not answering, but serve has no record of spawning it — left
published … Use --unpublish if it is gone.`

**Registry pruning rule changed to make the evidence survive.** `liveServers()` used to prune
every dead record from disk, and the widget calls it every 4 s — so a crashed *published* server's
record was gone before the next `serve` invocation's reap ever read it, leaving reap only the clock.
Now a dead record **with a `subdomain`** is kept until reap consumes it (or `registerServer`
replaces it on port reuse). Unpublished dead records prune as before. `liveServers()` still returns
only live records; discovery is unchanged.

**What this does not do.** Correct liveness for a `kind = "service"` tenant is still a systemd
question from its manifest `unit` (princess-pi-brain #9) — no `.tenant.toml` exists on any host
yet, so there is nothing to read. Until then such a tenant is `keep-unverified` here: never
unpublished by reap, visible in the warning, removed only by an explicit `--unpublish`.

## 3. #307 — the 1200 ms after spawn

**Was:** `bin/serve.ts` and `extensions/serve.ts` slept a flat 1200 ms after `spawn()` and then
read the registry to print the summary. Cold `npx` → *"No active directories are currently being
served"* while the server came up 2 s later; a spawn that died at 1.3 s reported as running.

**Is:** `awaitServerUp({port, child, ceilingMs})` in `extensions/lib/serve/process.ts` polls
state (100 ms):

- `up` — the port accepts a connection → in the summary.
- `exited` — the child is gone → `❌ Server for "<dir>" exited with code N / on SIGNAL before
  answering on 127.0.0.1:<port> (after N ms).`, and the registry record is retired.
- `pending` — 10 s ceiling with the child alive and the port silent → `⏳ … started but is not
  answering … yet — it may still be booting; check with --list.` Excluded from the summary,
  never called failure or success.

Measured: a static dir now starts and reports in **0.68 s** wall (previously ≥1.2 s by
construction).

## 4. Verification

`tests/serve-306-307-reap-state.test.ts` (26 assertions):

- A. `classifyReapCandidate` — all seven cells of the table above, incl. evidence for a different
  port and no evidence at all.
- B. `liveServers()` keeps a dead **published** record and prunes a dead unpublished one; the
  evidence adapter yields `reap` for the survivor. Real processes, SIGKILLed.
- C. `awaitServerUp` — late-binding listener (700 ms) → `up` under 1.5 s; child `exit(3)` →
  `exited` with code, promptly; alive child + silent port → `pending` at ceiling; SIGKILLed child →
  `exited` naming the signal.
- D. source pins — no `setTimeout(r, 1200)` in either caller; both call `awaitServerUp` and pass
  `evidence` to `reapOrphans`; `reapOrphans` routes through `classifyReapCandidate`.

`bun run test serve`: 9/9 suites green (incl. `serve-181-registry` V6, whose "probe tolerates a
restart window" pin still holds — the probe is unchanged, only its authority is). `tsc --noEmit`
clean. End-to-end: `serve <tmpdir>` against the live tunnel — pantograph (port answering) kept,
new server reported at 0.68 s, `--kill` clean.

## 5. Roads not taken

- **Ask systemd generically** (any unit `activating` → skip reap this run). Type=simple units are
  `active` the instant they exec, seconds before the app binds — the state doesn't cover the
  window that matters. Manifest `unit` + `systemctl is-active` is the right check when manifests exist.
- **Two-sighting reap** (persist "seen dead at", reap on the second sighting ≥N min later). Still a
  clock, just longer.
- **Return `{reaped, unverified}` from `reapOrphans`.** Kept the `string[]` return for the two
  existing callers and used callbacks; a shape change here would ripple into `--json` consumers for
  no gain.
