# APPLY RUNBOOK — Phase 6B.0: migrate tunnel `serve-preview` to remote-managed config

Staged: 2026-07-26 18:35:44Z (#66, Code Approved). Apply: **Duppy, manually** (prod-edit
rule — restarts the live user-level `cloudflared`; briefly drops `preview` + `rogue-aix`).
No sudo (user unit). Fully reversible.

## Why this is the gate

`serve`'s 6B publisher (`cloudflare.js`) programs the tunnel by **PUT-ing the remote-managed
configuration** via the Cloudflare API. The tunnel is currently running **local** config
(`~/.cloudflared/config.yml` has an `ingress:` block). Proof:

```
GET /accounts/<acct>/cfd_tunnel/<id>/configurations  →  "source": "local"
```

While `source` is `local`, the running tunnel **ignores** the API config. So `publishSlug`
would PUT successfully, its verify-GET would read the value back (reports ✅), yet the
hostname would still 404 — a **false success**. This migration flips the tunnel to read the
API-managed config, after which publish/unpublish/reap actually route traffic.

## Pre-flight

```bash
set -a; source ~/.config/princess-pi/cf.env; set +a
# Confirm token + current (local) config:
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" | python3 -m json.tool | sed -n '1,40p'
cp ~/.cloudflared/config.yml ~/.cloudflared/config.yml.bak-6b   # rollback copy
```

## Step 1 — Seed the remote config with the CURRENT desired ingress (so nothing drops)

PUT the exact rules the tunnel serves today into the API-managed config. (Harmless while
running local — the tunnel keeps using local until Step 3 restart.)

```bash
set -a; source ~/.config/princess-pi/cf.env; set +a
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"config":{"ingress":[
    {"hostname":"preview.princess-pi.dev","service":"http://127.0.0.1:8080"},
    {"hostname":"rogue-aix.princess-pi.dev","service":"http://127.0.0.1:8080"},
    {"service":"http_status:404"}
  ]}}' | python3 -c 'import json,sys; print("success:", json.load(sys.stdin)["success"])'
```

## Step 2 — Remove the local `ingress:` block

Edit `~/.cloudflared/config.yml` so it contains ONLY the tunnel identity — no `ingress:`,
no `url:`. With neither, `cloudflared tunnel run` fetches the remote-managed config. Target
file content in full:

```yaml
# --- serve-preview: remote-managed config (Phase 6B.0, #66). Ingress now lives in the
#     Cloudflare API and is programmed per-slug by `serve` (extensions/lib/serve/cloudflare.js).
#     Do NOT re-add an `ingress:` block here — its presence forces local mode and silently
#     overrides everything serve publishes.
tunnel: e2f8b97c-3d11-4c8a-83f1-be94417483ef
credentials-file: /home/princess-pi/.cloudflared/e2f8b97c-3d11-4c8a-83f1-be94417483ef.json
```

## Step 3 — Restart the user unit (no sudo)

```bash
systemctl --user restart cloudflared
systemctl --user status cloudflared --no-pager | sed -n '1,6p'   # expect: active (running)
```

## Verify

```bash
set -a; source ~/.config/princess-pi/cf.env; set +a
# 1. source is no longer "local":
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" | python3 -c 'import json,sys; print("source:", json.load(sys.stdin)["result"]["source"])'
# 2. existing hostnames still route (302 Access redirect, NOT 530/1033):
for h in preview rogue-aix; do
  curl -s -o /dev/null -w "$h: %{http_code}\n" "https://$h.princess-pi.dev/"; done
```

Expected: `source: cloudflare` (or anything ≠ `local`); both hosts `302`.

## Rollback

```bash
cp ~/.cloudflared/config.yml.bak-6b ~/.cloudflared/config.yml
systemctl --user restart cloudflared
```

Restores the local `ingress:` block; the tunnel goes back to `source: local`. ≤ a few seconds.

## After this: the live #66 sign-off test (Princess Pi drives once source≠local)

1. `serve ~/git-projects/rogue-savvy/frontend/dist rogue-aix` (rebuild dist first) →
   expect `🌐 Published https://rogue-aix.princess-pi.dev`. Confirm the reconciler's
   `serve rogue-aix` Access app now carries the `@roguelivestock.com` `email_domain` rule.
2. Browser (or `curl -I`) `https://rogue-aix.princess-pi.dev` → 302 to Access login.
3. `serve --kill` → hostname unpublished (ingress rule + Access app gone; verify-GET).
4. Reap: leave a stale entry (start, kill the origin process directly), re-run serve →
   `🧹 Reaped …`. That closes Step 4 for real; then Step 5 spec reconcile → merge.
