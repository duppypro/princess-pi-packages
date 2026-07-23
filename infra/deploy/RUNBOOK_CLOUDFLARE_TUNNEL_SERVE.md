# Runbook: Cloudflare Tunnel + Access for `/serve` previews

> **Lifecycle status: Phase 6A is CODE AND SPEC APPROVED (Step 5 `99c8cd4`, PR #108 merged
> 2026-07-22; infra teardown APPLIED + verified on the live VPS 2026-07-22 — evidence in
> `phase6-teardown/APPLY_RUNBOOK.md`). Phase 6B (per-slug automation, #66) is SPEC DRAFT.**
> Replaces the retired nginx `/live/` + oauth2-proxy `:4182` gate (see #32, #38, #59) with
> `cloudflared` Tunnel → loopback `/serve` servers, fronted by Cloudflare Access. Spec
> approved by Duppy 2026-07-07 (`999decb`); Phases 1–4 executed by Claude Cowork; Phase 5
> verified 2026-07-07 (see verification log below). Post-teardown live-gate re-check
> 2026-07-22: `https://preview.princess-pi.dev` → 302 to the Access login at
> `princess-pi.cloudflareaccess.com` (gate intact at the edge, org + app unchanged).
> Scope settled with Duppy 2026-07-07 (issue #64): full automation, two sequential arcs —
> 6A teardown (#64), 6B automation (#66).
>
> **Phase 5 verification log (2026-07-07 UTC, Claude Cowork + Duppy; origin = bare
> `python3 -m http.server 8080 --bind 127.0.0.1` to isolate the edge gate):**
> 1. Gate renders — `GET https://preview.princess-pi.dev` → Cloudflare Access challenge
>    (not the origin); OTP offered. PASS
> 2. Positive path — OTP to `duppypro@gmail.com` → origin "gate test ok" at
>    `https://preview.princess-pi.dev/`. PASS
> 3. Deny path — non-allow-listed `sadie@agentic-arts.ai` refused a code by policy
>    `allow-duppy`. PASS
> 4. Loopback — on the VPS, `curl http://127.0.0.1:8080/` → HTTP 200, no auth
>    (gate lives only at the Cloudflare edge). PASS
> Final config: OTP sole IdP; app `preview princess-pi` → `preview.princess-pi.dev`;
> policy `allow-duppy` = `duppypro@gmail.com`; org label `princess-pi.cloudflareaccess.com`.

## Goal
`serve <dir>` on a loopback port, reachable at a **named subdomain** of princess-pi.dev,
gated by **Google sign-in** (+ email OTP), and only openable by **allow-listed emails**.
This is the go-forward replacement for the token-bypass gate we removed in #59.

## Why this shape (decision already settled — not re-litigated here)
- **Buy, not make.** Cloudflare Access natively does per-hostname email allow-lists,
  multi-IdP (Google + OTP now), and service-token test bypass — free at our scale (≤50 users).
  This retires the hand-built nginx `auth_request` + oauth2-proxy stack and its phase-ordering
  bugs. (See the `cloudflare-platform-decision` note.)
- **Outbound-only tunnel = no inbound ports.** `cloudflared` dials *out* to Cloudflare, so
  the origin needs **zero** open inbound ports. This is why it pairs cleanly with the UFW
  deny-all-inbound we just enabled (#38 F4) — we open nothing new.
- **Origin is the loopback serve server** (the #38 F1 fix), so even the tunnel's origin is
  defense-in-depth: not directly reachable from the internet.
- **Subdomain-per-slug**, not path-based `/live/<slug>/`. Gives hard per-client isolation and
  makes relative asset links work at the domain root (closes the motivation for #37).

## Prerequisites
- A Cloudflare account with **Zero Trust** enabled (free plan; pick a team name → your
  `<team>.cloudflareaccess.com`).
- **princess-pi.dev DNS on Cloudflare** — see Phase 0. It is currently on Hover
  (`ns1/ns2.hover.com`); nothing past Phase 0 can complete until this flips.

---

## Phase 0 — Move princess-pi.dev DNS to Cloudflare (HARD prerequisite)
Same safe pattern as the email-MTA runbook's Phase 2. princess-pi.dev currently serves the
live site (nginx on the VPS), so the goal is **change who answers DNS without changing any
answer**.

1. Cloudflare dashboard → **Add a site** → `princess-pi.dev` → Free plan → let it auto-scan.
2. Compare scanned records against Hover's DNS. **Critically confirm the `A`/`AAAA` records
   for `princess-pi.dev` (and `logger.`) still point at the VPS IP**, and any `MX`/`TXT`
   (SPF/DKIM/DMARC) are present. Add anything missing before proceeding.
3. Set the live `A`/`www`/`logger` records to **DNS-only (grey cloud)** for now — we are not
   proxying the apex through Cloudflare in this phase, only moving DNS authority.
4. Note the 2 Cloudflare nameservers.
   **STOP:** show Duppy the record comparison + the 2 nameservers before touching Hover.
5. Hover → princess-pi.dev → Edit Nameservers → replace with the 2 Cloudflare NS → save.
6. Wait for the Cloudflare zone to show **Active**.
   **STOP:** confirm `dig +short NS princess-pi.dev` returns the Cloudflare nameservers and
   the live site + `logger.` still load before continuing. Mail/site are UNCHANGED — only DNS
   authority moved.

---

## Phase 1 — Install & authenticate cloudflared on the VPS
Duppy runs these in his SSH session. (Headless-safe: `login` prints a URL you open on your
laptop browser — no localhost callback.)

```bash
# Install from Cloudflare's apt repo
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
cloudflared --version

# Authenticate: prints a URL → open on your laptop → pick princess-pi.dev.
# Writes ~/.cloudflared/cert.pem
cloudflared tunnel login
```
**STOP:** confirm `~/.cloudflared/cert.pem` exists before continuing.

---

## Phase 2 — Create the tunnel, config, and service
```bash
cloudflared tunnel create serve-preview
#   → prints a Tunnel UUID and writes ~/.cloudflared/<UUID>.json (credentials)
cloudflared tunnel list        # note the UUID
```

Write `/etc/cloudflared/config.yml` (service runs as root by default; loopback origin):
```yaml
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json   # or copy the json here; see note below
ingress:
  # MVP: one fixed preview hostname → one fixed serve port.
  - hostname: preview.princess-pi.dev
    service: http://127.0.0.1:8080
  # everything else 404s (no catch-all origin)
  - service: http_status:404
```
> Note on credentials path: `cloudflared service install` runs as root and reads
> `/etc/cloudflared/config.yml`. Copy the credentials json to where the config points
> (`sudo cp ~/.cloudflared/<UUID>.json /root/.cloudflared/` or adjust `credentials-file`).
> Alternatively run the tunnel as the `princess-pi` user via a user systemd unit pointing at
> `~/.cloudflared/`. Pick one; keep config + creds path consistent.

Install + start:
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
cloudflared tunnel info serve-preview     # expect a healthy/registered connection
```
**STOP:** confirm `cloudflared tunnel info serve-preview` shows an active connection (4
edge connections is normal) before continuing. No inbound port was opened — verify with
`sudo ufw status` (still only 22/80/443).

---

## Phase 3 — Route the preview hostname to the tunnel
```bash
cloudflared tunnel route dns serve-preview preview.princess-pi.dev
#   → creates a PROXIED CNAME  preview → <UUID>.cfargotunnel.com
```
**STOP:** `dig +short preview.princess-pi.dev` should return Cloudflare IPs (proxied). Don't
test in a browser yet — without Access it would be open; add the gate first (Phase 4).

---

## Phase 4 — Cloudflare Access application + policy + IdP (Zero Trust dashboard)
This part is dashboard work — Claude Cowork can drive it, or do it manually.

1. **IdP setup** — Zero Trust → **Settings → Authentication → Login methods**:
   - **One-time PIN** — enable it (zero config; Cloudflare emails a 6-digit code). Gets you
     gated access *immediately*.
   - **Google** — Add → needs a Google OAuth client (Google Cloud Console → Credentials →
     OAuth client ID → Web application). **Authorized redirect URI:**
     `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Paste the client ID/secret
     into Cloudflare. (This is the same Google-client step the old oauth2-proxy needed, now
     pointed at Cloudflare instead.)
2. **Access application** — Zero Trust → **Access → Applications → Add → Self-hosted**:
   - Application domain: `preview.princess-pi.dev`.
   - Session duration: your call (e.g. 24h).
3. **Policy** — Add a policy on that app:
   - Action: **Allow**.
   - Include → **Emails** → `duppypro@gmail.com` (the allow-list — this is what
     `serve-acls.map` used to hold; it now lives here).
   - Leave login methods as configured (Google + OTP). Access keys on the **verified email**,
     so any configured IdP satisfies the same allow-list.
**STOP:** confirm the app shows the policy and the allowed email before testing.

---

## Phase 5 — Verify end-to-end
1. On the VPS: `serve <some_dir>` and confirm it's listening on **127.0.0.1:8080** (match the
   ingress port; adjust one to fit the other).
2. Browser (your laptop): visit `https://preview.princess-pi.dev` →
   - redirected to Cloudflare Access → sign in as `duppypro@gmail.com` (Google or OTP) →
     **see the preview**. ✅
3. Negative test: try an email NOT on the list → **denied**. ✅
4. **Test bypasses** (replaces the removed `?token=` backdoor):
   - On the VPS itself: `curl http://127.0.0.1:8080/` → 200, no auth (loopback, per policy).
   - Mac/CI automated tests: create an Access **Service Token** (Zero Trust → Access →
     Service Auth) and send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
     Revocable + audited — the sanctioned successor to the shared URL token.

---

## Phase 6 — Retire the nginx/oauth2-proxy gate + build per-slug automation
> **Spec status: 6A APPROVED (2e2d626, 2026-07-07) + code reviewed (PR #108) · 6B DRAFT.** Scope settled 2026-07-07:
> full automation now, not teardown-only. Two arcs, landed **in order** as separate commit
> pairs — 6A tracked in #64, 6B split to #66. 6B Spec Approved is blocked on the 6B.0
> wildcard-proxy verification (see VERIFY FIRST below).
> WHY two arcs: each is independently testable, and teardown-first means 6B is built on a
> serve that no longer touches /etc or sudo — no entanglement of old and new failure modes.

### Settled decisions (grilled 2026-07-07 — not re-litigated here)
- **Hostnames: `<slug>.princess-pi.dev` (flat, one label).** Universal SSL already covers
  `*.princess-pi.dev` one label deep — zero cert cost. Explicit records (`www`, `logger`,
  MX) always beat the wildcard, so infra names are safe; a **reserved-label blocklist**
  (below) protects them from slug collisions at the serve layer too.
- **Tunnel ingress via Cloudflare API remotely-managed config.** serve PUTs ingress rules
  through the API; no local `/etc/cloudflared/config.yml` rewrite, no reload, **no sudo**.
  WHY: a local-file rewrite would need a root grant — recreating the exact sudoers privilege
  Phase 6A deletes. One-time migration of the tunnel to remote-managed config required (6B.0).
- **Token: `~/.config/princess-pi/cf.env`** (mode 0600), holding `CF_API_TOKEN`,
  `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID`. serve sources it at start; if absent or
  unreadable it fails the Cloudflare programming step with a clear message (the local
  loopback server still starts). Same convention as the `cf-allowlist` skill.
- **Standing-privilege trade — stated plainly:** 6A deletes a passwordless-root sudo grant;
  6B adds a standing account-scoped API token. A `cf.env` leak = control of **all** tunnel
  ingress + **every** client's Access allow-list. Smaller blast radius than root, revocable
  in seconds, audit-logged at Cloudflare — but it is **not** "no standing privilege": the
  credential problem moves and shrinks, it does not vanish. Mitigations: 0600 + owner-only
  home, minimal scopes, rotate on any suspicion, periodic CF audit-log review.
- **Sequencing: 6A before 6B; inside 6A, code before infra** — strip nginx calls from serve
  first, then tear down maps/units/sudoers, so serve never fires `sudo nginx -s reload` at a
  deleted grant.

### Phase 6A — Teardown (serve → plain loopback origin)
> **Reconciled to as-shipped (Step 5, PR #108).** The bullets below now describe what
> actually landed, not the pre-build plan. Two items were **outside the issue #64 task list**
> and caught by a sweep during Code Draft (both squarely in-scope — "strip nginx machinery"):
> the extension-flavor serve (`extensions/serve.ts`) duplicated the whole nginx path, and
> `process.ts` built the dead `/live/<slug>/` display URL. A later **review round (PR #108,
> reviewer = princess-pi-bot)** added three fixes — F-A, F-B, F-C — folded in below.

**Code (this repo — sources are `bin/serve.ts` + `extensions/lib/serve/*`; since #97 the
generated `bin/serve.mjs` is untracked — build via `bun build.ts` / `npm run build`):**
1. `bin/serve.ts` **and `extensions/serve.ts`** (the Pi-extension flavor — sweep catch #1,
   it duplicated the entire nginx path): remove the `parseAclFile → updateNginxAcls →
   updateNginxPort → reloadNginx` sequence from start and stop/`--kill`, plus the kill-path
   map cleanup; drop the `nginx.js` import. The `.serve-acl`-must-exist validation goes
   dormant with it (6B reintroduces `.serve-acl` as the Access allow-list source).
2. `extensions/lib/serve/run-live-server.js`: remove the live-ACL watcher (the
   `.serve-acl`-change → `import("./nginx.js")` → reload branch in the `fs.watch` handler).
3. `extensions/lib/serve/process.ts` (sweep catch #2): the discovered-server public URL was a
   dead `https://princess-pi.dev/live/<slug>/` string. Now `port === 8080 ?
   https://preview.princess-pi.dev/ : localUrl` — only the MVP ingress port has a public URL
   until #66 adds per-slug publishing.
4. Delete `extensions/lib/serve/nginx.js` (nothing imports it after 1-3). **F-B (review):
   also delete the orphaned `extensions/lib/serve/nginx.d.ts`** — a type-decl for the now-gone
   `.js`. Rebuild.
5. **Fold in #60 (same files, one pass):**
   - **F1 traversal** (`run-live-server.js`, request handler): the bare
     `!filePath.startsWith(targetDir)` became `filePath !== targetDir &&
     !filePath.startsWith(targetDir + path.sep)` (kills the `/a/bc` vs `/a/b` prefix bug),
     hardened with an `fs.realpathSync` containment check so a symlink inside the root can't
     serve a target outside the REAL root.
   - **F2 XSS** (`generateDirectoryIndex()`): an `escapeHtml` helper wraps the *visible text*
     — `requestPath`, `entry.name`, `err.message`. **F-A (review) — escape alone was
     insufficient for the `href`:** a filename like `javascript:alert(1)` survived text-escape
     and rendered as a live scheme link. Fixed by building the anchor href as `"./" +
     encodeURIComponent(entry.name)` (+ trailing `/` for dirs) — the leading `./` forces
     relative resolution so no filename can parse as a URI scheme, and `encodeURIComponent`
     keeps `#`/`?`/space filenames from breaking the path. Text stays `escapeHtml`'d.
6. serve becomes: spawn loopback origin, done. The tunnel keeps statically routing
   `preview.princess-pi.dev → 127.0.0.1:8080` throughout 6A.

**6A Code Approved test list — as-shipped (tests live in `tests/`, run AFTER the "ready for
test" Code Draft commit):**
- **Zero-side-effect proof — `tests/serve-no-sudo-nginx.test.sh`** (asserted, not eyeballed;
  a negative is not provable by inspection): a PATH-shim dir first in `PATH` whose `sudo`/
  `nginx` write a marker + exit 97 → no marker after a full start/kill cycle; `strace -f -e
  trace=execve` over one traced start+kill run → no execve of `sudo`/`nginx`; before/after
  hash of `/etc/nginx` → unchanged. Also asserts serve starts with **no `.serve-acl`
  present**. **F-C (review):** header carries a precondition — on a fresh clone run
  `npm install` (+ build) first, or the `npx tsx bin/serve.ts` fallback fails on missing deps
  (`wcwidth`, #103), not on a real defect.
- **#60 acceptance — `tests/serve-60-security.test.ts`** (5 cases): in-root file serves 200
  (over-block guard); F1a sibling-dir traversal (`/a/b` → `/a/bc`) → 403; F1b symlink escape
  → 403; F2 crafted `<img …>` filename renders HTML-escaped in the index; **F-A (review):
  `javascript:alert(1)` filename renders as an inert `./`-relative encoded href and still
  serves 200 when followed.**
- **Retired `tests/serve-live-response.test.ts`** (sweep catch — deleted): it asserted the
  nginx `/live/` gate denial on local `:443`, which 6A removes. The auth boundary moved
  off-host to Cloudflare Access; its live equivalent is the gate check in the APPLY_RUNBOOK
  (`preview.princess-pi.dev` challenges → allow-listed passes → non-listed denied).
- Remaining serve tests (e.g. `serve-kill` / #39 regression) still pass.

**Infra (VPS — APPLIED by Duppy, verified 2026-07-22; verification evidence lives in the
`infra/deploy/phase6-teardown/APPLY_RUNBOOK.md` header. Checklist kept as the historical
record of what was staged→applied):**
1. nginx: remove `/live/` + `/oauth2/` blocks from `sites-available/princess-pi.dev`
   (staged copy + diff; apply = install, `nginx -t`, reload).
2. `sudo systemctl disable --now oauth2-proxy-live-serve` (+ `:4180/:4181` instances if
   unused); remove units + cfg.
3. Delete `/etc/nginx/serve-acls.map`, `serve-ports.map`.
4. Drop the `PI_NGINX` sudoers grant → delete `/etc/sudoers.d/princess-pi`. **Highest-value
   item** (standing passwordless-sudo privilege). Verify: `sudo -l` shows no nginx entry.
5. Remove `infra/deploy/README-live-serve.md` (dead oauth2-proxy standup) — this one is a
   repo file, deleted in the 6A commit, not staged.
6. Post-apply verify: `nginx -t` clean, `journalctl -u nginx -u cloudflared` clean,
   Cloudflare preview still gates + serves, `curl http://127.0.0.1:8080/` → 200 on-VPS.

### Phase 6B — Per-slug automation (`extensions/lib/serve/cloudflare.js` replaces `nginx.js`)
**6B.0 One-time migration (Duppy, per prod-edit rule):**
- Convert tunnel `serve-preview` to **remote-managed configuration** (dashboard: Zero Trust →
  Networks → Tunnels → migrate; or API PUT of current ingress). Existing static
  `preview.princess-pi.dev` rule carries over.
- ~~Create wildcard DNS: `*.princess-pi.dev` → `<UUID>.cfargotunnel.com`, **proxied**.~~
  **ALREADY DONE (discovered 2026-07-22):** the proxied wildcard record exists and routes
  to the tunnel — `zzz-not-a-slug.princess-pi.dev` resolves to Cloudflare edge IPs and
  returns the tunnel catch-all `http_status:404`. Explicit records confirmed unchanged
  (apex/`www` → VPS IP direct, `logger` proxied, MX at Hover).
  **VERIFIED (Duppy flag 2026-07-07 → answer recorded 2026-07-22):** proxied wildcard
  records are now available on **all Cloudflare plans, including Free** (Cloudflare policy
  change, per Duppy) — and empirically proven on this very zone (above). **Chosen path:
  wildcard; token scope stays `DNS:Read`.** Road not taken: per-slug DNS records
  created/deleted by serve, which would have grown the token to `DNS:Edit` (a leaked token
  could then also rewrite zone records) — the fallback is moot now.
- Create the API token (scopes: Account → Cloudflare Tunnel:Edit, Access: Apps and
  Policies:Edit; Zone → DNS:Read) → `~/.config/princess-pi/cf.env`, 0600.

**6B code — on `serve <dir>` start:**
1. Flatten slug → DNS label: lowercase; `[^a-z0-9-]` → `-`; collapse repeats; trim to 63
   chars. ERROR (skip dir, keep others) if the label collides with (a) a **live zone record** —
   serve GETs the zone's DNS records at start (Zone DNS:Read) and refuses any label
   matching an existing explicit record of any type (`www`, `logger`, MX hosts, `_dmarc`,
   …) or an Access app it doesn't own; (b) a different **active** slug's label. A minimal
   hardcoded list (`www`, `mail`, `logger`) remains only as a **fail-closed backstop**: if
   the zone read fails, refuse to publish (loopback still starts). WHY zone-derived: a
   hand-maintained denylist drifts; the zone is the source of truth.
2. Read `.serve-acl` emails (parser returns; validation gate is live again — no file, no
   publish).
3. API: upsert ingress rule `<label>.princess-pi.dev → http://127.0.0.1:<port>`
   (catch-all `http_status:404` stays last) under a **cross-process lost-update guard**:
   the full-config PUT is last-writer-wins, so two independent serve invocations doing
   read-modify-write would silently drop a rule. All writers live on this one VPS by
   construction (serve runs where the origin runs), so hold an advisory `flock` on
   `~/.config/princess-pi/tunnel-config.lock` across the whole GET → mutate → PUT →
   verify-GET cycle; after PUT, re-GET and assert our rule + the catch-all are present,
   jittered retry on mismatch. If the configurations endpoint supports ETag/`If-Match`
   conditional PUT (verify at implementation), layer it on. Cross-host writers: out of
   scope (single-VPS deployment) — documented limit.
4. API: upsert Access application `serve <label>` for `<label>.princess-pi.dev` + Allow
   policy with the `.serve-acl` emails. Per-slug app = hard isolation (client A's reviewer
   cannot reach client B).
5. Live-ACL watcher (reintroduced): `.serve-acl` change → update the Access policy only.

**On `serve --kill`:** remove the ingress rule + the Access app for that label.

**Orphan reaping** — a crash without `--kill` leaves an ingress rule + an Access app with a
stale email allow-list **live at the edge**: security drift, not clutter. 6B ships
**reap-on-start**: under the same lock, delete any serve-owned entry (Access apps are named
`serve <label>`; only those are touched) whose port has no live listener, before publishing
new state. **KNOWN GAP (named, deferred):** nothing reaps between a crash and the next
serve run; periodic/TTL GC is a follow-up issue to file at 6B kickoff.

**6B Code Approved test list:**
- Unit (no network): flattening rules, reserved-list rejection, active-collision rejection,
  cf.env missing → clear error + loopback server still starts.
- Live (Duppy, VPS + laptop): `serve <dir>` → `https://<label>.princess-pi.dev` gates via
  Access, allow-listed email passes, non-listed email denied; `.serve-acl` edit propagates;
  `serve --kill` → hostname 404s and the Access app is gone; `www`/`logger`/mail unchanged.

### 5-step governance + merge-eligibility (unambiguous)
- Tracking: **6A = #64**, **6B = #66** (split 2026-07-07). #60 closes in the 6A Code
  Approved commit.
- Each arc runs its **own full 5-step cycle**: Spec Approved commit before its Code
  Approved commit; Code Draft commit says exactly **"ready for test"** and lands *before*
  tests run; Code Approved commit lists the exact tests run; only Step 5 commits merge.
- **6A is merge-eligible at its own Step 5 while 6B is mid-flight.** The arcs are
  independently testable and independently mergeable; 6B starts only after 6A Code
  Approved and builds on merged 6A.

---

## MVP → full (subdomain-per-slug, per-client isolation)
This runbook stood up **one** hostname/port to prove the pattern (Phase 5, green
2026-07-07). The full build is now **specced as Phase 6B above** — with one amendment to
the original sketch: hostnames are `<slug>.princess-pi.dev` (flat), not
`<slug>.preview.princess-pi.dev` (two labels — outside Universal SSL; see Roads not taken).

## Roads not taken
- **`<slug>.preview.princess-pi.dev` (nested wildcard)** — the original MVP→full sketch.
  Two labels below the apex → not covered by Universal SSL; requires Advanced Certificate
  Manager (~$10/mo) or Total TLS. Flat `<slug>.princess-pi.dev` + reserved-label blocklist
  gets the same isolation at zero cert cost. Revisit only if the flat namespace gets crowded.
- **Local `/etc/cloudflared/config.yml` rewrite for per-slug ingress** — needs a root grant
  for edit+reload, recreating the sudoers privilege Phase 6A deletes. API remote-managed
  config does it with a scoped token and no sudo.
- **oauth2-proxy / nginx `auth_request`** — the retired hand-built gate (#32/#38). Throwaway
  vs. Cloudflare; kept only until Phase 6 removes it.
- **TryCloudflare quick tunnels** (`*.trycloudflare.com`) — ephemeral, no named domain, no
  Access. Fine for a throwaway demo, not for gated client previews.
- **Path-based `/live/<slug>/`** — subdomain-per-slug chosen for hard isolation + root-relative
  assets. (Retires the need for #33/#37.)
- **Tailscale (Funnel / Serve)** — evaluated and declined for client previews: Funnel gives the
  outbound tunnel but no email gate and only a `*.ts.net` URL (no vanity domain, ~3 ports/machine
  → forces path-based routing); Serve gates only tailnet members, not arbitrary external clients.
  Cloudflare does both jobs (tunnel + external-email allow-list on our own domain) at once. Kept
  as a possible orthogonal internal-ops layer only. See `docs/research/WHY_NOT_TAILSCALE.md`.
