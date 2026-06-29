# SPEC — Secure Dynamic `/serve` via Cloudflare (Pages + Tunnel + Access) — #32

> Status: **Spec Approved** (zero-shot, 2026-06-29). Supersedes the oauth2-proxy + nginx
> `/live/` `auth_request` design (`infra/deploy/oauth2-proxy-*`, #38 F2). That stack is
> **retired** by this spec — see §12. The old `docs/SPEC_SECURE_DYNAMIC_SERVE.html` describes
> the superseded design and is kept only for history.

---

## 1. Why (the problem)

`/serve` must publish local web content under `princess-pi.dev` DNS, gated so only an
**allow-listed reviewer per directory** can see it, while **automated tests bypass the gate**
on loopback. The prior pure-nginx implementation hit a fatal nginx phase-ordering bug: per-slug
authZ used `if`/`return` on `$user_email` (an `auth_request_set` var), but nginx evaluates
`if`/`return` in the **rewrite phase** — *before* `auth_request` (access phase) populates that
var — so every non-token request was denied `403`. Rather than engineer around nginx phases,
we **buy** the gate from **Cloudflare Access**, which does per-path email allow-lists, multi-IdP
login, audit logging, and a non-interactive **service-token** bypass natively (free ≤50 users).

---

## 2. Scope — the three planes

| Plane | What | This spec? |
|---|---|---|
| 1 | **Public production** (e.g. `does-it-glider`) — CDN, no auth | ❌ Cloudflare Pages / Firebase, separate |
| 2 | **Gated previews** — dev branches, **uncommitted local files**, client betas | ✅ **this spec** |
| 3 | **End-user product sign-up** — application identity inside a site | ❌ deferred (Firebase Auth / Clerk per-site) |

**Plane 2 is perimeter auth** (who may *see* a pre-prod page) — not product identity. Do not
conflate with plane 3.

---

## 3. Architecture

```
                  ┌──────────────────────── Cloudflare ────────────────────────┐
 reviewer ──TLS──►│  Access (IdP login + per-host policy)  ──►  Tunnel (ingress) │──► 127.0.0.1:<port>
 (any IdP)        │   *.preview.princess-pi.dev (wildcard DNS → tunnel)         │      (local /serve)
 test (CI/Mac) ──►│  Access service-token (header creds, non-interactive) ──────┘
                  └─────────────────────────────────────────────────────────────┘
 test (on box) ───────────────────────────────────────────────────────────────────► 127.0.0.1:<port>
```

- **Production hosting stays managed** (Pages/Firebase). The VPS/laptop only runs the local
  `/serve` origin + a `cloudflared` Tunnel; the public surface is Cloudflare's.
- The VPS hardening from #38 (loopback binds, ufw, sudoers lockdown, honeypot) **remains** as
  origin defense-in-depth behind the Tunnel.

### 3.1 Per-machine model (multi-host: VPS **and** MacBook)

Each serving host is its own unit so machines never clobber each other's shares:

- A short **machine id** `M` (default: short hostname; override `PI_SERVE_MACHINE`) namespaces
  every hostname: `<label>.<M>.preview.princess-pi.dev` (e.g. `docs.vps.preview…`,
  `docs.mac.preview…`).
- Each machine runs **one** `cloudflared` Tunnel and owns **one** Terraform *machine* workspace.
- One shared **core** workspace owns the account-wide scaffolding (zone, wildcard DNS, IdP
  connections, the test service token). Machine workspaces consume core outputs via TFC remote
  state. The wildcard `*.preview.princess-pi.dev` covers every machine.

MVP/first test = a single machine; the machine segment is a config var, so adding the second
machine later is the same code path with a different `M`.

---

## 4. Naming — slug → DNS label

`getClientSlug()` yields paths like `princess-pi-packages/docs` (may contain `/`). DNS labels
can't. **`slugify(slug)`** = lowercase; replace any run of non-`[a-z0-9]` with `-`; trim
leading/trailing `-`; cap at 50 chars. `princess-pi-packages/docs` → `princess-pi-packages-docs`.

**Collision rule:** if two distinct slugs map to the same label, append `-<6-hex>` of a hash of
the full slug. The active mapping (label → {slug, dir, port, emails}) lives in the machine's
`serve-shares.auto.tfvars.json` (the desired-state input; gitignored, machine-local).

---

## 5. ACL model — cascade with hard isolation

A directory's **effective allow-list** = the **union** of every `.serve-acl` found walking
**from the served dir up to `$HOME` inclusive**.

- **Cascading defaults (downward):** an email in a parent `.serve-acl` grants access to all
  descendants. Put your own email in `~/.serve-acl` (cascade root → full access everywhere).
- **Hard isolation (sideways):** sibling subtrees do **not** share lists. A reviewer added only
  to `clients/acme/.serve-acl` is in Acme's union but **not** in `clients/beta/`'s union (a
  different subtree). Shared ancestors apply to both by design — so keep `~/.serve-acl` to
  *you only* and place client reviewers in their own subtree. This is enforced by Cloudflare
  (each share = its own Access app + policy), not by us.
- **No `"all"` token** (the old map had one) — a `~/.serve-acl` entry *is* "all" via cascade.
- Format unchanged: one email per line, `#` comments (whole-line or trailing), whitespace
  trimmed. Invalid email (no `@`/`.`) → hard error. Empty effective list → refuse to serve.
- `.serve-acl` stays globally git-ignored (existing behavior).

---

## 6. Terraform layout

```
infra/terraform/
  core/        # shared, applied once: zone data, wildcard DNS, IdP connections, service token
    main.tf  variables.tf  outputs.tf  backend.tf  terraform.tfvars.example
  machine/     # per serving host: tunnel, remotely-managed ingress, Access apps+policies
    main.tf  variables.tf  outputs.tf  backend.tf
    serve-shares.auto.tfvars.json   # GITIGNORED desired-state input, written by /serve
  README.md    # onboarding runbook (Part A) — see §10
```

- **Remote state: Terraform Cloud** (free), one workspace per layer/machine
  (`pi-serve-core`, `pi-serve-<M>`), giving shared state + locking across VPS and Mac.
- **`core`** creates: `*.preview.princess-pi.dev` wildcard CNAME → tunnel; Access IdP
  connections (Google + one-time-PIN now; GitHub/Apple/Twitch later, Apple/Twitch via generic
  OIDC; Discord is **not** OIDC-compliant → out of scope); one
  `access_service_token` (the test credential). Outputs: idp ids, service-token id, account/zone.
- **`machine`** input = `var.shares` (a map keyed by label). For each share it creates:
  - one ingress rule in the remotely-managed tunnel config:
    `<hostname> → http://127.0.0.1:<port>` (plus a terminal `http_status:404` catch-all),
  - one `access_application` bound to `<hostname>`,
  - one `access_policy` (`decision = allow`, `include { email = <effective list> }`),
  - the core **service token** is added as a second include on every app (so tests pass the
    edge non-interactively). Session duration + allowed IdPs are module vars.
- Provider: official `cloudflare/cloudflare`. Resource names use the current
  `cloudflare_zero_trust_*` family (Access application/policy/service-token, tunnel +
  tunnel config).

`var.shares` example (what `/serve` writes):

```json
{ "shares": {
    "princess-pi-packages-docs": {
      "hostname": "princess-pi-packages-docs.vps.preview.princess-pi.dev",
      "port": 8080, "dir": "/home/princess-pi/git-projects/princess-pi-packages/docs",
      "slug": "princess-pi-packages/docs",
      "emails": ["duppygro@gmail.com", "reviewer@acme.com"]
} } }
```

---

## 7. Command contracts

### `serve [dirs…] [-s|--static] [-f|--force]`
For each dir: resolve effective ACL (§5) → error if empty; pick free loopback port; start the
local server bound to `127.0.0.1:<port>` (unchanged); compute `label`/`hostname`; upsert the
share into `serve-shares.auto.tfvars.json`; run **`terraform -chdir=infra/terraform/machine apply -auto-approve`**.
On success print **both** URLs:
- gated: `https://<label>.<M>.preview.princess-pi.dev/`
- loopback test target: `http://127.0.0.1:<port>/`

### `serve --kill [port|dir|all…]`
Resolve targets (existing logic). For each: remove its share from
`serve-shares.auto.tfvars.json`; `terraform … apply` (Cloudflare destroys that app/policy/ingress);
then stop the local process via `killServerInstance` (#39 — kill by captured PID, confirm dead,
**fail loud**, never a silent no-op). `--kill all` clears all shares for this machine.

### Guards / degradation
- If `terraform`/`cloudflared`/state is not configured: `serve` still starts the **loopback**
  server and prints the local URL, but **warns** that the public gate was not provisioned and
  prints the planned hostname. (Lets dev/test proceed pre-onboarding; never silently implies a
  live gate.)
- `PI_SERVE_DRY_RUN=1` → write tfvars and run `terraform plan` only (no apply); for CI of the
  wiring itself.

---

## 8. Test bypass model

| Runner | Method | Auth |
|---|---|---|
| On the serving box | hit `http://127.0.0.1:<port>/` | none (loopback = trust boundary) |
| MacBook / CI → public URL | send `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers | Access **service token** |

This is the **only** bypass, and it is header-based + revocable + audited — replacing the old
`?token=duppy_live_token_777` URL secret (which leaked into logs).

---

## 9. Security properties (invariants)

1. Local origin binds **loopback only**; the public path is Cloudflare → Tunnel (no inbound
   ports opened on the host; #38 ufw stance preserved).
2. Per-share Access app + policy ⇒ **hard isolation** between sibling shares.
3. No secrets in URLs. Service token via headers; Cloudflare API token via env/`backend`.
4. Empty effective ACL ⇒ refuse to serve (fail closed).
5. `serve --kill` fails loud if a process or a Cloudflare resource is not actually torn down.

---

## 10. Human onboarding (Part A — Duppy, in `infra/terraform/README.md`)

1. Move `princess-pi.dev` nameservers to Cloudflare (zone active).
2. Cloudflare Zero Trust: create the **team domain**; add IdPs — **Google** + **One-time PIN**
   (GitHub/Apple/Twitch later).
3. Create a scoped **Cloudflare API token** (Zone DNS edit + Access edit + Tunnel edit + Account
   read) → export as `CLOUDFLARE_API_TOKEN`.
4. **Terraform Cloud**: create org + workspaces `pi-serve-core`, `pi-serve-<M>` (CLI-driven);
   `terraform login`.
5. Install `terraform` and `cloudflared` on each serving host.
6. `cd infra/terraform/core && terraform init && terraform apply` (one-time scaffolding).
7. `cd ../machine && terraform init` and run the tunnel (`cloudflared` as a service, token from
   core output). After this, `serve`/`serve --kill` drive everything.

---

## 11. Verification — Definition of Done (tests)

**Automated, Cloudflare-independent (run now, gate the code):**
- `acl-cascade`: union up to `$HOME`; sibling isolation (A∌ B-only reviewer); empty ⇒ throws;
  comment/whitespace/invalid-email handling.
- `slugify`: path→label rules; collision suffix determinism.
- `serve --kill`: existing #39 PID-based fail-loud tests still pass.
- `terraform -chdir=infra/terraform/{core,machine} validate` (once terraform installed).

**Manual / live (after Part A onboarding):**
- Reviewer on dir A's list → any IdP login → sees A; gets **403** on dir B. ✅ isolation.
- Remove reviewer from A's `.serve-acl` → `serve` re-apply → access revoked.
- On-box `curl http://127.0.0.1:<port>/` → 200, no auth.
- CI/Mac with service-token headers → 200; without → Access login redirect.
- `serve --kill` → hostname returns Cloudflare 404 (app gone) and local port closed.

---

## 12. Migration / retirement

Retire (after the live test passes): oauth2-proxy `:4182` + unit, the nginx `/live/`
`auth_request` block + `serve-acls.map`/`serve-ports.map`, the `?token=` bypass, and the
`updateNginxAcls/updateNginxPort/reloadNginx` code path. Keep: VPS hardening, honeypot, ufw,
sudoers lockdown, the loopback `/serve` origin. `infra/deploy/oauth2-proxy-*` and the nginx
`princess-pi.dev` vhost authZ are removed in the cutover commit, not before (no outage; token
keeps working until then).

---

## 13. Open questions (track, don't block)

- Apple private-relay emails complicate allow-listing a specific person — accept, or require a
  non-relay address?
- Ephemeral share TTL / auto-expiry of preview access (later).
- Per-client custom subdomains / white-label (`acme.review.princess-pi.dev`) — later.
- Whether to fold `core` IdP/service-token into the same TFC org as client work — yes for now.
