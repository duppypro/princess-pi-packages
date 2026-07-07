# Runbook: Cloudflare Tunnel + Access for `/serve` previews

> **Lifecycle status: SPEC APPROVED (Step 2 — approved for execution, not yet tested).**
> Replaces the retired nginx `/live/` + oauth2-proxy `:4182` gate (see #32, #38, #59) with
> `cloudflared` Tunnel → loopback `/serve` servers, fronted by Cloudflare Access. Spec
> approved by Duppy 2026-07-07; ready to hand to Claude Cowork for execution. Mark Step 4
> (Code Approved) only after Phase 5 verification passes on the live VPS.

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

## Phase 6 — Retire the old nginx/oauth2-proxy gate (AFTER Phase 5 passes)
Only once the Cloudflare path is proven end-to-end:
- Remove the nginx `/live/` + `/oauth2/` blocks from `sites-available/princess-pi.dev`
  (stage + `nginx -t` + reload, per the prod-edit rule).
- `sudo systemctl disable --now oauth2-proxy-live-serve` (and the `:4180/:4181` instances if
  unused); remove their units + cfg.
- Delete `/etc/nginx/serve-acls.map`, `serve-ports.map`.
- Drop the `PI_NGINX` sudoers grant → the whole `/etc/sudoers.d/princess-pi` file can be
  deleted (serve no longer reloads nginx).
- Update `/serve` code: replace `nginx.js` (map writes + `nginx -s reload`) with the Cloudflare
  Access/DNS programming path; remove `README-live-serve.md` (oauth2-proxy standup, now dead).

---

## MVP → full (subdomain-per-slug, per-client isolation)
This runbook stands up **one** hostname/port to prove the pattern. The target end state:
- **Wildcard DNS** `*.preview.princess-pi.dev` + a tunnel ingress rule per active slug
  (`<slug>.preview.princess-pi.dev → 127.0.0.1:<that slug's port>`). Because serve assigns
  **dynamic** ports, the `.serve-acl` cascade resolver rewrites the tunnel ingress (and
  reloads it) + programs a **per-slug Access application** with that slug's own email
  allow-list via the Cloudflare API/Terraform. Per-slug apps give **hard isolation**: client
  A's reviewer cannot reach client B.
- The resolver replaces both the old `serve-acls.map` (→ Access policies) and the tunnel
  ingress management. That automation is the next build after this MVP is green.

## Roads not taken
- **oauth2-proxy / nginx `auth_request`** — the retired hand-built gate (#32/#38). Throwaway
  vs. Cloudflare; kept only until Phase 6 removes it.
- **TryCloudflare quick tunnels** (`*.trycloudflare.com`) — ephemeral, no named domain, no
  Access. Fine for a throwaway demo, not for gated client previews.
- **Path-based `/live/<slug>/`** — subdomain-per-slug chosen for hard isolation + root-relative
  assets. (Retires the need for #33/#37.)
