# Tenancy Glossary — ubiquitous language for serve and scheduled work

**Canonical source.** Moved here 2026-08-15 by **ADR 0002**, which dissolved the VPS Tenancy Standard
into `serve-standard.md`, `scheduled-work-standard.md` and `unit-authoring-standard.md`. The glossary
follows the standards: every term below is serve or scheduling vocabulary, so it belongs beside the
tools it describes rather than in a knowledge repo. Earlier homes — `btw/CONTEXT.md`, then
`princess-pi-brain/vps-tenancy/vps-tenancy-glossary.md` — are history. btw keeps the research notes
recording *how* each rule was decided.

**`tenant` survives as the central noun** even though no standard is named "tenancy" any more. That
is deliberate: the standards are named for what they *bind to*; the vocabulary is named for what it
*describes*.

This file is the shared vocabulary for everything `serve` deploys or publishes, on any machine.
It is written to be **copied into each site-host repo** (`crispyhardware-com`, `interfacearts-com`,
`agentic-arts-ai`, `duppy-com`, `portfolio-api`), so that five repos and the agents working in them
use one set of words for one set of things.

**How to copy it.** Copy the region **between the two markers below**, and add a provenance header to
the copy:

```markdown
> Copied from `princess-pi-packages/docs/tenancy-glossary.md` @ <commit sha>, <YYYY-MM-DD>.
> Shared serve vocabulary. If this disagrees with the source, the source wins — fix the copy, or
> change the source and re-copy. Repo-specific terms go below the marker at the end, never inline
> above it.
```

Copies drift; that is not a reason to avoid duplication, it is a reason to make drift **detectable**.
The sha in the header makes `git log` at the source the answer to "is my copy stale."

<!-- ========= COPY BEGINS HERE ========= -->

**Scope.** This glossary covers *hosting*: where things live, how they deploy, how they reach the
public internet. It does **not** cover any application's own domain language — that belongs in that
repo's own section (see the marker at the end), or in its own `CONTEXT.md` for a repo with a rich
domain of its own (`portfolio-api` has one).

**Companion:** `../CONTEXT.md` § Language — Serve owns the `serve` **tool's**
internals. Where a term appears in both, that file is authoritative for tool behaviour and this file
for deployment meaning. Conflicts are called out explicitly below rather than left for a reader to
trip over.

---

## Placement — the four roots

Every deployed thing has exactly these locations. Nothing lives anywhere else.

| Term | Means | Notes |
|---|---|---|
| **Workspace** | `~/git-projects/<repo>` — the git clone where code is written | **Never served, never deployed from.** Source only. Its `research/`, `debug/` and `tmp/` are development scratch and never reach a release |
| **Release dir** | `~/.local/share/<app>/<env>/` — build output; the rsync target | Replaced wholesale on every deploy (`rsync --delete`). **Nothing may be written here at runtime** — it will be destroyed |
| **State root** | `~/.local/state/<app>/<env>/` — databases, logs, uploads | **Never touched by deploy.** The only place irreplaceable data may live |
| **Secrets file** | `~/.config/secrets/<app>-<env>.env`, mode `0600`, inside a `0700` directory | Loaded via systemd `EnvironmentFile=`. Per-`Env`, never one file for all envs — otherwise a dev unit gets live credentials. The directory holds credentials **only**, so one anchored rule can protect it |

*Why release and state are separate roots:* `deploy.sh` rsyncs with `--delete`, so anything a service
writes inside its release dir is destroyed on the next deploy. Splitting the roots makes that loss
structurally impossible rather than remembered. The rule was learned the hard way once already —
`vite build` wiping `.serve-acl` (rogue-savvy #19).

---

## The tenant

| Term | Means | Notes |
|---|---|---|
| **App** | one deployable codebase, named by its repo (`rogue-aix`, `portfolio-api`) | one App, several `Env`s |
| **Env** | `dev` or `prod` — one deployed instance of an App | each has its own release dir, state root, secrets file and port. A **sub-domain** only if published; a **unit** only if `kind = "service"` |
| **Tenant** | one App+`Env` pair as the host sees it: a release dir, a manifest, and a port — plus a sub-domain when published | the unit of hosting. **This is the word the Sesame proposal called a "domain"** |
| **Manifest** | `.tenant.toml` in the release dir — declares `kind`, and for a service `port` and `unit`. `gate`, `zone` and `subdomain` are **optional** | rsync-**excluded**, exactly as `.serve-acl` is: a build must never be able to change a tenant's gate, port or zone |
| **Loopback-only** | a tenant with no `gate`/`zone`/`subdomain` — reachable at `127.0.0.1:<port>`, not published | the default. Publishing is an *intent*, not a property of the machine |
| **Published** | a tenant with all three declared | **MUST** carry a `gate`; there is no such thing as a published tenant with no access policy |
| **Static tenant** | `kind = "static"` — files served by a process `serve` spawns | port **allocated** (first free from 8080). The only kind supported on macOS today |
| **Service tenant** | `kind = "service"` — a long-running process supervised by the init system | port **pinned** in the manifest, because the unit and the ingress rule both reference it and a restart must land on the same one. Linux only for now — `serve-standard.md` §4.1 |
| **Unit** | the **user**-level init-system unit for a service tenant (`<app>-<env>.service` under systemd) | never root. `Linger=yes` is set, so units survive logout. Authoring rules: `unit-authoring-standard.md` |
| **Job** | scheduled recurring work owned by the operator, declaring a **lane** | backups are the first real one |
| **Lane** | where a Job runs: **on-box** (a user systemd timer or cron entry, same absolute-path rules as a unit) or **off-box** (an ephemeral GitHub-hosted runner) | not a preference — *derived*: needs local state → on-box; needs only the network → off-box |
| **Agent Job** | a Job whose work is performed by an LLM agent rather than a deterministic script | `agent-job-standard.md`. Reserved for questions where reasonable readers disagree — never for one with an exact answer |

**Port pinning is the load-bearing asymmetry** between the two kinds, and it creates a requirement
on `serve`: declared service ports must be **reserved** against the static allocator, or a casual
`serve <dir> --pub foo` can take a service's port and break it on its next restart.

---

## The perimeter

| Term | Means | Notes |
|---|---|---|
| **Edge** | Cloudflare's network — TLS termination, tunnel ingress, Access authentication | no process on this box touches a certificate |
| **Loopback** | `127.0.0.1`, which every tenant binds to | nothing listens on an external interface. Public reach is exclusively via the tunnel |
| **Zone** | a Cloudflare DNS zone (`princess-pi.dev`, `agentic-arts.ai`) | a tenant is published into exactly one. `princess-pi.dev` is **internal-only** and everything on it is Access-gated |
| **Sub-domain** | the short URL-safe label identifying a published tenant — the `api` in `api.agentic-arts.ai` | see the naming ruling below |
| **Gate** | a tenant's access policy: `"access"` (Cloudflare Access, email-OTP) or `"public"` (open, and owns its own auth) | the *policy*. The Cloudflare resource implementing it is an **Access application** |
| **Publish** | creating a tenant's edge resources: a tunnel ingress rule, and an Access application if gated | `serve --pub`. See `../CONTEXT.md` § Language — Serve for the tool's exact behaviour |
| **Reap** | deleting ingress rules whose local origin no longer answers | runs on every `serve` invocation. Gated on two facts: the hostname is fronted by a `serve `-prefixed Access application, **and** its port fails a TCP probe (3 attempts / ~1.5 s since princess-pi-packages #181). It asks *"does anything answer here"*, never *"is this one of ours"* — so a listening service tenant is kept. **Residual gap:** a tenant that is down across the whole probe window (a slow `systemctl restart`) still reads dead. Correct service liveness is a systemd question answered from the manifest `unit` — `serve-standard.md` §9. *Earlier text here claimed reap matched `ps aux`; it never did — see #9.* |

---

## Deployment

| Term | Means | Notes |
|---|---|---|
| **Promotion chain** | `main → dev → prod`, fast-forward only, refusing a dirty tree | releases contain only exact commits from the remote — enforced procedurally by script guardrails, not structurally by permissions. A known limit, not an assumed property |
| **Deploy** | checkout → build → rsync into the release dir → (service: restart the unit) → health check | the only path by which a release dir changes |
| **Health check contract** | what a successful deploy probe looks like — **read per-tenant from `gate`, never assumed globally** | `gate = "access"`: a `302` to `cloudflareaccess.com` is success and a bare `200` is a **loud failure**. `gate = "public"`: the reverse. Both directions stay loud |
| **Operator** | Duppy, administering the deployed things — the only principal that spans tenants | not a user with a flag; a separate principal with a separate auth path |

---

## Naming rulings

These exist because two canonical documents disagreed, or because one word was doing too many jobs.

### "Domain" means four different things — so it means none of them here

| Sense | Say this instead |
|---|---|
| a DNS name (`agentic-arts.ai`) | **domain** (keep it) or **zone** for the Cloudflare object |
| a deployable thing on the VPS (the Sesame proposal's usage) | **tenant** |
| a DDD bounded context | **bounded context** |
| a scope of engineering rules (`~/git-projects/CLAUDE.md`) | **scope** |

_Avoid:_ using **domain** unqualified for anything but DNS.

### Sub-domain, not slug — but slug is not a banned word

**Ruling (Duppy, 2026-08-06): in the context of a URL, the label before the zone is a
*sub-domain*.** *Slug* is **too broad** to be the term here — it legitimately means any generated
URL-safe string, including ones used in file names and directory names. It is a *shape* of string,
not a *role*. Sub-domain names the role precisely, and precision is the whole point of a glossary.

So the rule is narrow and worth stating exactly:

- the label in `api.agentic-arts.ai` is a **sub-domain** — never a slug
- a generated URL-safe string used for a filename, a directory, an article path segment or an id
  **may still be called a slug**; that is its correct general sense and nothing here forbids it
- when in doubt, ask what the string *identifies*. A tenant at the edge → sub-domain. Anything else
  → slug is fine

Corroborating, and the reason the fix lands on prose rather than code: the **code** already says
sub-domain — the flag stores `--subdomain`, the persistence file is `subdomains.json`, the function
is `publishSubdomain()`. *(This reverses an earlier lean of mine toward "slug", argued only from the
runbooks being the docs people actually read. The precision argument above is the durable reason; the
change-cost argument merely agrees with it.)*

**Applied 2026-08-06** across `btw/CONTEXT.md`, `docs/vps-tenancy-standard.md`, both active research
notes and all of `portfolio-api` — including the **manifest key**, which was `slug = "api"` and is now
`subdomain = "api"`. Deliberately *not* rewritten: the Sesame proposal (a verbatim record of someone
else's document) and archived research notes, where rewriting would falsify the record.

**Open item:** rogue-savvy's `deploy.sh` still says slug (14 occurrences) and still prints the
legacy `--as` flag — tracked as rogue-savvy #46. Its `deploy-rogue-aix` skill and
`infra/deploy/README.md` were amended and merged (`438b062`).

### Service means the systemd sense only

`../CONTEXT.md` lists *Service* under `_Avoid_` for a **server instance** — a
`serve`-spawned static process. That ruling stands and this glossary sharpens it: **Service** is
reserved for a systemd-supervised long-running process (`kind = "service"`). A static tenant is never
a service, and a service is never a "server instance."

### Gate vs Access application — related, not synonyms

`../CONTEXT.md` lists *gate* under `_Avoid_` for an **Access application**. Kept,
and narrowed: **Gate** is the declared *policy* (`"access"` or `"public"`) in a manifest; **Access
application** is the Cloudflare *resource* that implements `gate = "access"`. A public tenant has a
gate and no Access application. Never use "gate" for the Cloudflare object.

### Origin is ambiguous across repos — a live hazard

In `../CONTEXT.md`, **Origin** is the loopback service behind the edge. In any repo
serving browsers, **origin** is the CORS sense: scheme + host + port of the calling page. Both
meanings are load-bearing and neither will yield.

**Ruling:** in deployment prose say **loopback service**. Reserve bare *origin* for the CORS sense.
A repo that uses both must say which in its own glossary.

---

## _Avoid_ generally

**Production** — say the `Env` name, `prod`. **Server** — overloaded across the process, the VPS and
the `serve` tool; say tenant, unit, or the box. **Backend** — ambiguous; name the App.
**Deploy** as a synonym for publish — deploying changes a release dir, publishing changes the edge,
and they fail in different ways.

---

<!-- ========= COPY ENDS HERE — repo-specific terms below this line ========= -->

## Repo-specific terms

*(In this file — the source — none. In a copy, add that repo's own vocabulary here. Never edit the
shared section above in a copy: change **this file** and re-copy, so all five repos stay in step.)*
