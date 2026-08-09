# Road not taken: Pangolin as the `/serve` perimeter

**Author:** Princess-Pi (adversarial second-pass review session), with Duppy.
**Subject:** Whether Pangolin (fosrl/pangolin — self-hosted Traefik + WireGuard tunneled
reverse proxy, per the DevOps Toolbox video "I Found The END GAME of Homelab Tunnels",
youtube.com/watch?v=EpxzTDhIQzI) is a fork worth taking instead of the
Cloudflare Tunnel + Access perimeter that `serve --pub` is built on.
**Decision:** **No — stay on Cloudflare; keep the VPS outbound-only.** Pangolin's best
feature is imported as a requirement instead (#142, expiring share links).
**Deciding input (Duppy, 2026-08-08):** the VPS stays **outbound-only** — no inbound
service ports, no on-box TLS, no root in the publish path. That input settles the fork by
itself, because Pangolin *is* an inbound perimeter.

---

## What Pangolin is

Four cooperating components (docs.pangolin.net/development/system-architecture.md):

| Component | Runs on | Job |
|---|---|---|
| **Traefik** | public node (VPS) | terminates TLS (Let's Encrypt), routes HTTP(S) |
| **Gerbil** | public node | WireGuard peer manager, SNI routing, UDP relay |
| **Badger** | public node | Traefik forward-auth plugin enforcing Pangolin auth |
| **Newt** | each private site | outbound-only connector: WebSocket to control plane + WireGuard to Gerbil |

Install is Docker (root, `curl | bash`), and the public node must open inbound
**80/tcp, 443/tcp, 51820/udp, 21820/udp**. Auth is built-in (local users, OIDC/SSO, MFA,
passkeys, PINs, per-resource path/geo/CIDR/ASN rules, expiring share links). Licensing:
AGPL-3 community edition + commercial tiers.

## The fork underneath the tool choice

Same fork the retired oauth2-proxy/NGINX design (`SPEC_SECURE_DYNAMIC_SERVE.html`) sat on:
**who owns the perimeter.**

- **Rent the edge (current):** Cloudflare terminates TLS, absorbs DDoS/scan traffic, and
  enforces auth *before* packets reach the tunnel. The box holds no certs, opens no inbound
  service ports, and publishing is unprivileged API calls. Price: Cloudflare sees plaintext
  and sets the ToS.
- **Own every hop (Pangolin):** no third party in the plaintext path, no vendor terms,
  richer per-resource auth. Price: on-box TLS custody, four components + Docker to patch,
  open inbound ports, and being your own DDoS shield (no formal third-party security audit
  as of the 2026-07 Show HN thread).

The 2026-08-08 deciding input — outbound-only — chooses the first branch explicitly.
It also keeps intact everything downstream that assumes it: btw's VPS tenancy standard
("no process on this box touches a certificate"; loopback-only binds; `gate="access"`
health semantics where a bare 200 on a gated hostname is a *loud failure*), the no-sudo
publish path, and the 2026-08-05 perimeter decision ("No nginx. Cloudflare Tunnel remains
the perimeter for the foreseeable future", btw `research/api-perimeter-and-zone-split.md`).

## The topology mismatch (why the video's "end game" isn't ours)

Pangolin's headline job is reaching a **private network you can't port-forward into**:
Newt runs inside the homelab/CGNAT network and dials out to Gerbil on a public VPS. That
is the video's audience. **Here, the origin and the public node are the same machine** —
`serve`'s origins are loopback ports on the very box that would run Traefik/Gerbil. Deploy
Pangolin on this VPS and the entire WireGuard fabric idles; what remains doing real work
is Traefik + Badger — i.e., a self-hosted reverse proxy with an auth middleware, which is
architecturally the already-superseded Path D (oauth2-proxy + NGINX maps) wearing better
packaging.

## What Pangolin does better — imported as requirements, not as a stack

Unlike Tailscale (`WHY_NOT_TAILSCALE.md`), Pangolin is **not** eliminated by the
external-clients + vanity-domain inputs — it serves both. Its genuine advantages become
roadmap items on the current stack instead:

1. **Expiring share links** → filed as princess-pi-packages **#142** (time-boxed viewer
   access without permanent ACL edits).
2. **Per-path auth bypass on one hostname** (gated UI + open API) → already resolved by
   the zone-split decision (public API tenants live in a separate zone with their own
   auth; btw `research/api-perimeter-and-zone-split.md`).
3. **Multi-domain publishing** → known `serve` gap (single `CF_ZONE_ID`), tracked in
   btw#20; a serve roadmap item, not a perimeter change.

## Where Pangolin *would* lead if the inputs were different

Documented so a future change is a re-read, not a re-derivation:

- **If origins ever live on machines other than this VPS** — home hardware, a client's
  on-prem box, GPU machines behind CGNAT — Pangolin's tunnel fabric stops being dead
  weight and becomes exactly the tool: Newt at each site, this VPS (or a dedicated node)
  as the public ingress. **That is the trigger condition to reopen this fork.** (The
  Cloudflare-shaped alternative at that point is one `cloudflared` per site; compare
  again then.)
- **If Cloudflare's ToS or limits bite** (e.g. the ~100MB upload ceiling, media-streaming
  ambiguity) for a real tenant, Pangolin is the strongest self-hosted exit ramp — it
  replaces both the tunnel *and* Access in one move, which the oauth2-proxy design never
  managed cleanly.
- **If plaintext-privacy from Cloudflare itself becomes a requirement**, this is the only
  fork that delivers it; accept the inbound perimeter that day with a fresh security spec.

## Related

- `WHY_NOT_TAILSCALE.md` — sibling road-not-taken; its retained tailnet-for-insiders idea
  (close inbound `:22`) *composes* with this decision and would make the box more
  outbound-only, not less.
- `EXT_SERVE.html`, `RUNBOOK_CLOUDFLARE_TUNNEL_SERVE.md` — the design this validates.
- btw: `docs/vps-tenancy-standard.md`, `research/api-perimeter-and-zone-split.md`,
  `research/tenancy-service-as-property.md`.
- princess-pi-packages #142 (expiring share links).
- Sources reviewed 2026-08-08: docs.pangolin.net (architecture, access-control/links,
  quick-install, enterprise-edition), github.com/fosrl/pangolin, Show HN thread
  news.ycombinator.com/item?id=44526015, XDA hands-on "I replaced Cloudflare Tunnel with
  Pangolin". Note: the YouTube video's comment section was not retrievable headlessly;
  community sentiment above draws on HN/XDA instead.
