# Road not taken: Tailscale for `/serve` client previews

**Author:** Princess-Pi (adversarial second-pass review session), with Duppy.
**Subject:** Whether Tailscale (Funnel / Serve) is a fork worth taking instead of the
Cloudflare Tunnel + Access design in `RUNBOOK_CLOUDFLARE_TUNNEL_SERVE.md`.
**Decision:** **No — stay on Cloudflare** for the client-preview use case. Tailscale is
retained only as a possible *orthogonal* internal-ops layer (see the last section).
**Deciding inputs (Duppy, 2026-07-07):** viewers are **external clients**; **vanity
princess-pi.dev URLs matter**. Those two answers settle the fork by themselves.

---

## What Cloudflare is actually doing here (two jobs, not one)

The reason this comparison is subtle: Cloudflare is doing **two** jobs at once, and
Tailscale splits them across two different primitives that don't recombine cleanly.

1. **Outbound tunnel / ingress.** `cloudflared` dials *out* to the edge, so the VPS opens
   **zero** inbound ports and still gets a public, trusted-TLS URL. Pairs with the
   deny-all-inbound UFW posture (#38 F4).
2. **Identity-aware access proxy.** Cloudflare Access gates each hostname behind an
   allow-list of **arbitrary external** Google emails (+ email OTP), on **our own** domain
   (`<slug>.preview.princess-pi.dev`), with **no client-side install**. The reviewer clicks
   a princess-pi.dev link and signs in with their own Google account.

Job 2 is the hard part and is exactly what the runbook retires oauth2-proxy to obtain
natively (see `cloudflare-platform-decision`; #32/#38/#59).

## How Tailscale maps onto those two jobs

Tailscale has two relevant primitives; each covers **only one** of the two jobs.

| Tailscale primitive | Analogous to | Gives | Does NOT give |
|---|---|---|---|
| **Funnel** | the `cloudflared` tunnel (job 1) | public URL, outbound-only, auto-TLS | **no auth gate** (open to anyone with the URL); only `*.ts.net`, not a vanity domain; ~3 ports per machine → forces path-based routing |
| **Serve** | job 2, but insiders only | identity = tailnet membership, auto-TLS, per-path routing, trivial on/off | membership requires the viewer to **install Tailscale and join our tailnet** — no arbitrary external email |

**Funnel replaces the tunnel but not the gate. Serve provides a gate but only for people
already inside the tailnet.** Neither primitive natively does "public vanity-domain URL,
gated by an allow-list of external Google emails, no install" — the exact combination
Cloudflare Access exists to provide.

## Why the two deciding inputs close the fork

- **"External clients" eliminates Tailscale Serve.** Serve's gate *is* tailnet membership;
  a non-technical client will not install a VPN and accept a tailnet invite. Serve was the
  only Tailscale primitive with a built-in identity gate, so this removes it.
- **"Vanity matters" eliminates Tailscale Funnel.** Funnel publishes only on `*.ts.net`; it
  cannot serve `<slug>.preview.princess-pi.dev`. And Funnel carries no allow-list, so it
  would mean re-adding oauth2-proxy *on top of* a non-vanity URL — strictly behind where we
  already are after #59.

So for client previews, **both** Tailscale forks lead backward or sideways:

- **Funnel path** pulls back into path-based `/slug/` routing (the ~3-ports limit), which is
  the road the runbook explicitly declined for root-relative-asset reasons (#33/#37) — and
  it still needs a hand-built auth layer.
- **Serve path** requires every viewer inside the tailnet, which the client audience rules
  out.

## Where Tailscale *would* lead if the inputs were different

Documented so a future audience change is a quick re-read, not a re-derivation:

- **If viewers were internal/trusted only** (you, Duppy, agents, a long-term contractor):
  **Tailscale Serve** becomes a strong simplification — Phase 0 DNS migration, IdP config,
  and per-slug Access apps all evaporate; serving/unserving a dir is one CLI call
  (`tailscale serve --bg --set-path /slug http://127.0.0.1:PORT`) versus programming tunnel
  ingress + a per-slug Access app via API/Terraform. The **dynamic serve/unserve ergonomics
  are genuinely where Tailscale shines.** It just commits hard to the tailnet-membership gate.
- **If vanity did not matter and a `*.ts.net` URL were acceptable**, Funnel would still need
  a bolt-on auth layer, so it would remain the weaker of the two Tailscale options.

## Retained road: Tailscale as an orthogonal internal-ops layer (NOT competing)

One Tailscale use *does* stack cleanly with Cloudflare because it serves the opposite
audience — insiders, not clients:

- Put the VPS on the tailnet; reach **SSH, the loopback serve ports, and any admin
  dashboards** over Tailscale Serve *tailnet-only*, then **close inbound `:22`** to the
  public internet entirely. Cloudflare Access keeps gating *outsiders* on the vanity domain;
  Tailscale gates *insiders* on the private mesh. They compose because they don't overlap.

This is a **separate** decision from the runbook, blocks nothing, and would get its own spec
if pursued. Recorded here only so the option isn't lost.

## Related
- `RUNBOOK_CLOUDFLARE_TUNNEL_SERVE.md` — the design this validates (Roads not taken).
- `cloudflare-platform-decision` note; issues #32, #38, #59, #33, #37.
