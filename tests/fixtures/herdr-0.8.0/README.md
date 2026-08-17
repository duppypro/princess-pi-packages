# Pinned herdr payloads — 0.8.0 / protocol 19

Captured live on **2026-08-16** from `herdr 0.8.0` on the VPS, by
`herdr pane list` / `herdr workspace list`, with only volatile fields removed
(`revision`, `scroll`, `terminal_id`, `terminal_title*`) and the agent session
id replaced with `<session-id>`. Nothing was reshaped: **absent keys are still
absent**, which is the point of the capture.

`tests/herdr-reap.test.ts` asserts the three facts `bin/herdr-reap` depends on,
so a herdr upgrade that changes any of them fails loudly here rather than
silently changing what gets closed:

1. **`cwd` carries the kernel's ` (deleted)` suffix inside a success payload.**
   No structured `cwd_exists: false` sits beside it — the state a consumer must
   act on is reachable only by inspecting the string. Filed upstream as
   herdrdev/herdr#2799 (open, `bug` + `maintainer-needed`). Consequence:
   `herdr-reap` stats the raw value and never matches the suffix, because a
   directory genuinely named `foo (deleted)` would false-positive on a suffix
   match and correctly pass a stat.

2. **The `agent` key is ABSENT on a bare-shell pane, not null.** `wt-new`
   creates bare-shell bookmark tabs, so this is the common case, and it is why
   the live-agent guard is written `select(.agent != null)` — which reads a
   missing key and an explicit null identically — rather than `has("agent")`.

3. **`foreground_cwd` is present and carries the same suffixed value.** On
   0.7.5 this key *disappeared entirely* when the directory was deleted. 0.8.0
   keeps it. `herdr-reap` reads only `cwd`, so it was never exposed to that
   difference — recorded here so the next reader does not have to rediscover
   which of the two fields is safe.

**Re-pin discipline.** Protocol moved 17 → 19 across a single minor release and
five pinned facts changed with it. When these fixtures are refreshed, re-verify
all three facts above by execution rather than from release notes, and update
the date on this file.
