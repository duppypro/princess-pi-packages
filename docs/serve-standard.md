# Serve Standard

**Status: Spec Approved** (Duppy, 2026-08-15). Normative rules for the `serve` contract — placement,
tenant declaration, ports, deploy, health checks, and publishing to the edge.

**Scope.** This standard is bound to the **`serve` tool**, not to any host. It holds on the VPS and on
a laptop, because a tenant is either loopback-only or published-with-a-gate everywhere, and that
choice is about intent rather than machine. Split from the former VPS Tenancy Standard by
**ADR 0002**.

**Companions.** Vocabulary: `tenancy-glossary.md`. Handing a service tenant to an init system:
`unit-authoring-standard.md`. Scheduled work, including backups of tenant state:
`scheduled-work-standard.md`.

**How to read it.** **MUST** is a rule whose violation has produced, or would produce, a real
failure — each carries its one-line reason. **SHOULD** is a strong default with named exceptions.
Rules marked **⚠ NOT YET ENFORCEABLE** state the intent but depend on tooling that does not exist;
they are collected in §8 so nothing is planned against them.

---

## 1. Placement

1.1 Code **MUST** live in a **Workspace** (`~/git-projects/<repo>`) and **MUST NOT** be served or
deployed from there. *Why:* the workspace holds uncommitted edits, scratch, and `node_modules`; a
served workspace publishes whatever a half-finished edit left behind.

1.2 A deploy **MUST** write only to the **release dir** (`~/.local/share/<app>/<env>/`), via
`rsync --delete`.

1.3 Anything written at runtime — databases, logs, uploads — **MUST** live in the **state root**
(`~/.local/state/<app>/<env>/`). *Why:* `rsync --delete` destroys everything in the release dir on
every deploy. Splitting the roots makes that loss impossible rather than remembered.

1.4 A deploy **MUST NOT** read, write, or delete anything under the state root.

1.5 Logs **MUST** go to the state root, never `~/.config/`. *Why:* config is not state. (Existing
drift: `serve`'s access logs are in `~/.config/…` today — #291.)

1.6 The four roots **MAY** be used by things that are not tenants. `~/.local/state/big-thoughts-discord/`
predates any manifest and is correct. *Why:* the placement rules protect irreplaceable data, and that
concern does not begin at the moment something becomes published.

---

## 2. Tenant declaration

2.1 Every tenant **MUST** carry a `.tenant.toml` **manifest** in its release dir declaring `kind`,
and — for a service — `port` and `unit`.

2.2 `gate`, `zone` and `subdomain` are **optional**. Their absence means **loopback-only**: the
tenant is reachable at `127.0.0.1:<port>` and is not published. *Why:* publishing is an intent, not a
property of the machine — the same contract has to describe a laptop preview and a live API.

2.3 A **published** tenant **MUST** declare all three, and **MUST NOT** be published without a
`gate`. *Why:* `gate = "public"` is itself a gate value meaning *open, and owns its own auth* — so
there is no such thing as a published tenant with no declared access policy. Saying a tenant is
"ungated" is a category error; say `gate = "public"`.

2.4 The key is `subdomain`, never `slug`. *Why:* in a URL the label before the zone is a sub-domain;
*slug* is a shape of string, not a role. The code already agrees — `--subdomain`, `subdomains.json`,
`publishSubdomain()`.

2.5 The manifest **MUST** be excluded from rsync (`--exclude '.tenant.toml'`), exactly as
`.serve-acl` is. *Why:* a build must never be able to change a tenant's gate, port or zone. Not
theoretical — `vite build` deleting `.serve-acl` locked a client out of a live site (rogue-savvy #19).

2.6 A tenant's identity **MUST** be readable from its release dir alone. *Why:* `rm -rf` the release
dir and the tenant is fully described-and-gone; no central registry to leave stale.

---

## 3. Ports

3.1 A **service tenant MUST** declare a pinned port. *Why:* the unit's `ExecStart` and the tunnel
ingress rule both reference it, and a restart must land on the same port or ingress points at nothing.

3.2 A **static tenant MUST NOT** declare a port; `serve` allocates first-free from 8080.

3.3 The allocator **MUST** treat declared service ports as reserved. **⚠ NOT YET ENFORCEABLE** (§8).

3.4 Every tenant **MUST** bind `127.0.0.1` only. *Why:* public reach is exclusively via the tunnel; a
tenant on an external interface bypasses the entire perimeter.

---

## 4. Platform

4.1 On **macOS**, `serve` supports `kind = "static"` only. A `kind = "service"` tenant **MUST NOT**
be declared there. *Why:* a service tenant is a supervised long-running process, and every
supervision rule in `unit-authoring-standard.md` is systemd-specific while macOS uses launchd.
Tracked as a future feature — #287.

4.2 Every other rule in this standard **MUST** hold identically on both platforms. *Why:* one
contract is the point; a per-host fork of the serve rules is the shape ADR 0002 exists to remove.

---

## 5. Secrets — policy

*(The mechanism — `EnvironmentFile=`, the `%h` path, and why `Environment=` literals are forbidden —
lives in `unit-authoring-standard.md` §3. The rules below are platform-independent policy and stay
here.)*

**A note on placement, since it is inherited rather than argued.** §5.3–§5.5 are not about `serve`:
their subjects are harness config files, shell rcs, and dotfiles under management. They are here
because ADR 0002 split secrets into *policy* (this section) and *systemd mechanism*
(`unit-authoring-standard.md` §3), and gave them no third home. If a fourth rule of this shape
appears, that is the signal to lift all of them into an operator-secrets standard of their own.
Recorded so the next reader knows this is a holding position, not a claim that leaking a credential
into `~/.viminfo` is a serving concern. (#295)

5.1 A secrets file **MUST** be per-`Env`. **MUST NOT** be one file shared across envs. *Why:* the
moment dev and prod need different credentials, a shared file hands the **live** key to the dev unit
— a silent failure pointing the wrong way (dev traffic against production money).

5.2 Where one app serves several brands, variables **MUST** be namespaced per brand. *Why:*
isolation that is a naming convention is at least visible; isolation that is nothing is not.

5.3 Secrets **MUST** live in a dedicated namespace — `~/.config/secrets/` — rather than being
protected file by file. *Why a namespace and not a list:* a per-file list silently rots, and the
seventh credential is the one nobody remembers to add. A directory the operator controls turns every
downstream control — agent read-denies, backup and dotfile-manager exclusions, shell-read guards —
into **one anchored rule that already covers files that do not exist yet**. Matching a *name* pattern
instead is a heuristic, and a measured-poor one: `.env` covers three of the six credential files
observed on this box and misses **both of the ones that actually leaked**.

5.4 That namespace **MUST NOT** hold non-secret configuration. *Why:* the guarantee *"everything in
here is a credential"* is exactly what lets one anchored rule replace the per-file list §5.3 rejects.
A single convenience file weakens every control built on it. The prior layout demonstrated the cost —
`~/.config/princess-pi/` mixed credentials with `default-acl`, `wtft.json` and
`authenticated-emails.txt`, all of which tooling has legitimate reason to read.

5.5 A secret **MUST NOT** be written into a file that other tooling has reason to open — a harness
`settings.json`, a shell rc, a dotfile under management. *Why:* the observed failures were not misuse.
They were tools faithfully persisting what they were designed to persist. One credential in a harness
config reached **74 files** through version snapshots, session transcripts and command history, with
nobody doing anything wrong. Editor state counts too: a yanked value lands in `~/.viminfo` by default,
which **no filename-based control will ever match**.

5.6 Consumers **MUST** be updated **before** a secret file is relocated. *Why:* moving first breaks
the consumer silently, and the breakage surfaces at the next run rather than at the change — so the
failure arrives detached from the edit that caused it.

---

## 6. Deploy

6.1 A release **MUST** contain only exact commits from the remote. Enforced **procedurally** by
script guardrails, not structurally by permissions — a known limit, recorded so it is not mistaken
for a boundary.

6.2 Promotion **MUST** follow `main → dev → prod`, fast-forward only, refusing a dirty tree.

6.3 The deploy sequence **MUST** be: checkout env branch → build → rsync (excluding `.serve-acl` and
`.tenant.toml`) → read manifest → *if service:* restart the unit and wait for active → health check.

6.4 A deploy **MUST** fail loudly on a failed health check. **MUST NOT** downgrade any failure to a
warning.

---

## 7. Health check contract

7.1 For a **published** tenant the success condition **MUST** be read per-tenant from `gate`.
**MUST NOT** be assumed globally.

| `gate` | Success | Loud failure |
|---|---|---|
| `"access"` | `302` to `cloudflareaccess.com` | bare `200` — reachable and **unprotected** |
| `"public"` | `200` | `302` to Access — a gate was created by mistake and browsers are blocked |

*Why both directions are loud:* a deploy that silently succeeded into an unprotected tenant is the
failure that would actually hurt.

7.2 For a **loopback-only** tenant the check **MUST** be a `200` on the loopback address. *Why:* with
no `gate`, the table above has no applicable row; without this the check would be undefined rather
than simple.

7.3 A `gate = "public"` health check verifies **reachability, not authorization**. The tenant owns
its own auth and therefore owns testing it. *Why:* a green health check on a public tenant stays
green if the app's member auth breaks open and starts serving member-only routes to guests. Nothing
at the edge can see that.

7.4 A service tenant's health endpoint **SHOULD** return the **deployed commit sha**, and the deploy
**SHOULD** assert it matches. *Why:* without it, a failed restart leaves the old process serving and
the check passes — a deploy that reports success while changing nothing.

7.5 A health endpoint that claims a datastore is healthy **MUST** actually probe it, and **MUST**
probe every datastore it fronts. *Why:* a static `"ok"` reports healthy with a missing or corrupt
database.

7.6 A `gate = "access"` check **MUST** be made by a client carrying no Access session — `curl -sI`
from any host, or a browser profile that has never signed in. It **MUST NOT** be inferred from what
a logged-in browser sees. *Why:* the identity session is held at the **account** scope, not the
hostname's (§8.7), so the very first visit to a brand-new gated hostname can serve content with no
challenge. In the browser that is indistinguishable from no gate at all — which is exactly how it
was reported as a breach (#329).

---

## 8. Publishing, gates and zones

8.1 A published tenant **MUST** declare its `zone`. `princess-pi.dev` is **internal-only** and
everything published there **MUST** be `gate = "access"`. *Why:* the invariant "everything on this
zone is gated" is what lets a health check treat a bare `200` as a failure. One exception destroys it.

8.2 A `dev` **Env MUST** be `gate = "access"`, even when its `prod` counterpart is `gate = "public"`.
*Why:* a public prod tenant is a deliberate decision; a publicly reachable half-built dev instance
running against dev credentials is not. The promotion chain makes them the same codebase, so nothing
else stops dev inheriting prod's openness by default.

8.3 A `gate = "public"` tenant **MUST** be published into a zone other than `princess-pi.dev`, and
**MUST** own its authentication. *Why:* Cloudflare Access answers an unauthenticated cross-origin XHR
with a `302` to a login page, which a browser `fetch` cannot complete — Access cannot gate a
browser-called API. A public tenant serving guests and authenticating members itself is the intended
shape, not an exception.

8.4 Publishing a `gate = "public"` tenant **SHOULD** require explicit friction rather than a bare
negation flag. *Why:* the one prior silent allow-list change locked a client out (rogue-savvy #19).
Ergonomics undecided — see *Open* below.

8.5 A publish of a service tenant **MUST NOT** auto-seed a `.serve-acl`. **⚠ NOT YET ENFORCEABLE** (§8).

8.6 A published tenant's edge resources **MUST** be provably `serve`-owned by a marker that does
**not** depend on its `gate`. **⚠ NOT YET ENFORCEABLE** (§9 — #294). *Why:* today the proof of
ownership *is* the gate — reap matches a hostname only when a `serve `-prefixed Access application
fronts it, a test a `gate = "public"` tenant can never pass, because §2.3 gives it no Access
application by design. The consequence is not a tidy-up problem: the ingress rule outlives its origin
still pointing at `127.0.0.1:<port>`, and when the allocator later hands that port to a different
tenant — §3.3 being unenforceable — the dead public hostname routes to the new tenant with no gate in
front of it. Latent only because §8.3 cannot be executed yet (§9); it becomes reachable on the same
day multi-zone publish does.

8.7 A `gate = "access"` tenant is gated in **two steps at two different scopes**, and any statement
about the gate **MUST** name which one it means:

| Step | Question | Scope | Where it lives |
|---|---|---|---|
| **Authentication** | *who are you?* | the whole Cloudflare account | one identity session on the team domain (`princess-pi.cloudflareaccess.com`), ~24h |
| **Authorization** | *may you open this one?* | one sub-domain | that tenant's `.serve-acl` → the app's allow policy |

Only the second step is per-sub-domain. *Why:* a visitor who authenticated to **any** tenant in the
account carries that identity to every other tenant, so publishing a brand-new sub-domain does **not**
produce a fresh challenge for them — measured 2026-08-17, where an identity minted **7h 44m before
the sub-domain's Access application existed** opened it silently (#329). The per-sub-domain isolation
this standard relies on is real, but it is the *allow-list* that provides it, never the login prompt.

8.8 A login prompt **MUST NOT** be read as evidence about the gate, and its **absence** proves only
that the visitor holds a valid token **for that hostname** — never that a gate is missing, and never,
on its own, that an account session is live. *Why:* Cloudflare re-shows the same login page for
"no session" **and** for "session whose identity is not on this list" — it doubles as an identity
chooser — so the prompt cannot distinguish the two. Silence is narrower than it looks in the other
direction: the application token is issued per hostname with its **own** lifetime (`session_duration`,
24h, set by `upsertAccessApp()`), independent of the account-scoped identity session, so a **revisit**
can be silent on a token issued earlier even after that account session has lapsed. Only on a **first**
visit to a newly published sub-domain — where no such token can yet exist — does silence imply a live
identity session that is *also* on that tenant's allow-list. Observed states for that first-visit case,
same browser, same minute (2026-08-17):

| Identity session | On that tenant's `.serve-acl` | What the visitor sees on a **first** visit |
|---|---|---|
| live | yes | content, no prompt |
| live | no | login page; submitting that address sends **no code** |
| none | yes | login page → code mailed → content |
| none | no | login page → **no code** sent |

The deny path (rows 2 and 4) is Cloudflare checking the submitted address against the policy
**before** mailing a PIN — first measured 2026-07-07 (runbook Phase 5, step 3), re-measured
2026-08-17 on a `serve`-published tenant whose visitor held a live, allow-listed-elsewhere identity.
An allow-list is therefore never satisfied by re-authenticating; being on it is the only way through.
Note that the *same* address (`duppypro@gmail.com`) opens one tenant silently and cannot obtain a
code for another in the same minute — the allow-list is evaluated per tenant, not per person.

---

## 9. Not yet enforceable

The standard's intent, blocked on tooling in this repo. Collected so nothing is planned against them.

| Rule | Blocked on | Consequence today |
|---|---|---|
| §3.3 service ports reserved | the allocator has no *reservation* — since #181 it bind-probes each candidate, so it can no longer take a port a service is **currently listening on**. Remaining gap: a reserved port whose service is momentarily down | a casual `serve <dir> --pub foo` can still take a service's port during that window |
| §8.5 no `.serve-acl` auto-seed for services | publish assumes it spawned the origin | a public tenant would have a gate fabricated on it |
| reap must not unpublish services | **Corrected (#181, #306).** `reapOrphans()` never matched `ps aux` — it has probed the port since `8ae6fde`, so a *listening* service tenant is kept. Since #306 a silent port is no longer sufficient: reap also needs the #181 registry to say the process `serve` spawned for that port is dead/recycled. A service tenant has no registry record → `keep-unverified` → never reaped by the probe; reported as a warning instead. `spec-306-307-reap-state.md` | none from reap. A dead service tenant's ingress now survives until an explicit `--unpublish` (or a manifest-driven check, brain #9) |
| §8.3 multi-zone publish | `loadCfEnv()` reads one `CF_ZONE_ID`, and `ZONE_SUFFIX` is hardcoded to `princess-pi.dev` | §8.3 cannot be executed at all yet — which is the only reason §8.6 is not already live |
| §8.6 gate-independent ownership | `reapOrphans()` proves ownership from `serve `-prefixed Access apps, so a `gate = "public"` tenant is invisible to it | a dead public tenant's ingress survives forever and can later route its hostname to whichever tenant inherits the port — **#294**, must close before the first public tenant |

---

## 10. Prohibitions

**MUST NOT**, in any repo, on any machine:

- serve or deploy from a Workspace (§1.1)
- write runtime data into a release dir (§1.3)
- touch the state root during a deploy (§1.4)
- bind anything to an external interface (§3.4)
- declare `kind = "service"` on macOS (§4.1)
- share one secrets file across envs (§5.1)
- keep non-secret configuration in the secrets namespace (§5.4)
- write a secret into a file other tooling has reason to open (§5.5)
- relocate a secrets file before its consumers are updated (§5.6)
- publish without a declared `gate` (§2.3)
- publish an unprotected tenant on `princess-pi.dev` (§8.1)
- prove a tenant's edge ownership by the presence of its Access application (§8.6)
- publish a `dev` Env without `gate = "access"` (§8.2)
- reduce any deploy health-check failure to a warning (§6.4)

---

## Couplings — stated, because colocation no longer holds them

ADR 0002 split this standard away from its neighbours, so the constraints that cross the boundary are
named here rather than left to proximity.

- **§3.1 pinned ports × unit authoring.** A service tenant's port appears in both its manifest and
  its unit's `ExecStart`. Changing one without the other breaks ingress on the next restart.
- **§6.3 deploy × unit authoring.** The deploy sequence restarts the unit and waits for it to become
  active; the unit's `Restart=` policy determines whether "active" is meaningful.
- **§9 state root × scheduled work.** This standard says irreplaceable data lives in the state root;
  `scheduled-work-standard.md` §1 is what actually backs it up. Neither is sufficient alone.

---

## Open, and deliberately not ruled on

- **Public-publish ergonomics** (§8.4): an explicit `--public` with friction, versus `--no-gate` as a
  plain negation. Undecided — #292.
