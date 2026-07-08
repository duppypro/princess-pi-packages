# Phase 6A infra teardown — APPLY RUNBOOK (Duppy runs this on the VPS)

> **STAGED, NOT APPLIED.** Per the prod-edit rule and issue #64, nothing here has touched
> the live VPS. Every step below is run by Duppy in his own SSH session. Claude/Pi never
> sudos live prod config.
>
> **Precondition (code before infra):** deploy the Phase 6A serve build FIRST
> (`git fetch <bundle>` → merge/checkout → `npm run deploy:local`), so `serve` has stopped
> calling `sudo nginx -s reload` before the sudoers grant disappears. Verify:
> `bash tests/serve-no-sudo-nginx.test.sh` on the VPS.

## 0. Preflight snapshot (rollback material)
```bash
STAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
sudo cp -a /etc/nginx "/root/etc-nginx-backup-$STAMP"
sudo cp /etc/sudoers.d/princess-pi "/root/sudoers-princess-pi-backup-$STAMP" 2>/dev/null || true
sudo nginx -t   # must be clean BEFORE we start, or stop and investigate
```

## 1. nginx — remove the dead /live/ + /oauth2/ gate
The exact blocks vary with hand-edits; locate rather than assume:
```bash
grep -n "live/\|oauth2\|serve-acls\|serve-ports\|4182" /etc/nginx/sites-available/princess-pi.dev
grep -rn "serve-acls\|serve-ports" /etc/nginx/nginx.conf /etc/nginx/conf.d/ 2>/dev/null
```
Edit `sites-available/princess-pi.dev`: delete the `location /live/ { ... }` and
`location /oauth2/ { ... }` (and `location = /oauth2/auth`) blocks, plus any
`map`/`include` lines referencing `serve-acls.map` / `serve-ports.map` (these may live in
`nginx.conf` http{} scope — the greps above find them). Then:
```bash
sudo nginx -t && sudo nginx -s reload
```

## 2. oauth2-proxy — stop, disable, remove
```bash
sudo systemctl disable --now oauth2-proxy-live-serve
ss -tlnp | grep -E ':(4180|4181|4182)' || echo "no oauth2-proxy listeners left"
# If :4180/:4181 instances exist AND nothing else uses them, disable those units too.
sudo rm -f /etc/systemd/system/oauth2-proxy-live-serve.service
sudo systemctl daemon-reload
sudo rm -f /etc/oauth2-proxy/oauth2-proxy-live-serve.cfg 2>/dev/null || true
# cfg may instead live next to the repo checkout (it was gitignored) — remove where found:
find ~ -maxdepth 3 -name "oauth2-proxy-live-serve.cfg" 2>/dev/null
```

## 3. Map files
```bash
sudo rm -f /etc/nginx/serve-acls.map /etc/nginx/serve-ports.map
sudo nginx -t && sudo nginx -s reload   # confirms nothing still includes them
```

## 4. Sudoers grant — the highest-value deletion
```bash
sudo rm /etc/sudoers.d/princess-pi
sudo -l | grep -i nginx && echo "FAIL: nginx grant still present" || echo "OK: no nginx sudo grant"
```

## 5. Verify (Phase 6A infra Code Approved checklist)
```bash
sudo nginx -t
journalctl -u nginx -u cloudflared --since "-10 min" --no-pager | tail -50   # clean
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/              # 200 (serve up)
```
Browser (laptop): `https://preview.princess-pi.dev` → Access gate still challenges →
allow-listed email passes → preview renders. Non-listed email still denied.

## Rollback
Restore `/root/etc-nginx-backup-$STAMP` over `/etc/nginx`, `nginx -t && nginx -s reload`,
restore the sudoers file, `systemctl enable --now oauth2-proxy-live-serve` if its unit and
cfg were restored. The Cloudflare gate is untouched by this teardown either way.
