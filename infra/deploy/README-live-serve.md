# ⚠️ DEPRECATED — superseded by the Cloudflare design (#32)

> This oauth2-proxy + nginx `/live/` runbook is **retired**. The current approach is
> **Cloudflare Tunnel + Access** — see `docs/SPEC_SECURE_DYNAMIC_SERVE.md` and
> `infra/terraform/README.md`. This file and the sibling `oauth2-proxy-live-serve.*`
> are kept only until the cutover commit (spec §12), so the live token path keeps
> working until Cloudflare is stood up. **Do not follow the steps below for new setup.**

---

# Standing up real OAuth for `princess-pi.dev/live/` (#32, closes #38 F2)

Replaces the interim static token with a real Google-OAuth gate on `:4182`.
Trust boundaries: **remote humans → OAuth**; **local tests → `127.0.0.1:<port>` directly** (no token).

## Part A — Google Cloud Console (your step; everything else is automatable)
1. console.cloud.google.com → **APIs & Services → Credentials** (reuse the rogue-savvy project or make a new one).
2. **Create Credentials → OAuth client ID → Application type: Web application.** Name it e.g. `princess-pi.dev live serve`.
3. **Authorized redirect URI:** `https://princess-pi.dev/oauth2/callback`  ← must match `redirect_url` in the cfg exactly.
4. If the OAuth **consent screen is in "Testing"**, add each reviewer's Google email under **Test users** (or publish the app). External + Testing = only listed test users can sign in.
5. Copy the **Client ID** and **Client secret**.

That's all you need from the console. Hand me the client ID/secret (or paste them into the cfg yourself) and I'll do the rest.

## Part B — wire it up (mostly me; runbook for the cutover)
1. `cp oauth2-proxy-live-serve.cfg.example oauth2-proxy-live-serve.cfg` and fill `client_id`, `client_secret`, and a fresh `cookie_secret` (`openssl rand -base64 32 | tr -- '+/' '-_' | tr -d '='`). (cfg is gitignored.)
2. Seed the AUTHN union file: `~/.config/princess-pi/authenticated-emails.txt` (one email/line — for now `duppypro@gmail.com`). The cascade resolver in `/serve` will maintain this from `.serve-acl` files.
3. Install + start the unit:
   ```bash
   sudo cp infra/deploy/oauth2-proxy-live-serve.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now oauth2-proxy-live-serve
   ss -tlnp | grep 127.0.0.1:4182      # expect oauth2-proxy listening
   ```
4. **nginx cutover** (I'll provide the token-free `princess-pi.dev` vhost at this step):
   - remove the `?token=duppy_live_token_777` bypass from `location = /oauth2/auth` and the `/live/` block,
   - add `"duppypro@gmail.com" "all";` to `/etc/nginx/serve-acls.map`,
   - `sudo nginx -t && sudo nginx -s reload`.
5. Remove the token from `/serve` code (the printed URL becomes the bare `https://princess-pi.dev/live/<slug>/`).

## Part C — verify (definition of done)
- Reviewer email listed → Google sign-in succeeds → sees the preview.
- Google account NOT listed → denied (oauth2-proxy rejects; or nginx 403 for wrong slug).
- Cascade: email in `~/.serve-acl` → works for any served subdir; remove it → revoked everywhere.
- Local test: `curl http://127.0.0.1:<port>/` → 200, no auth.
- Old `?token=duppy_live_token_777` → no longer grants access.

See #32 for the settled ACL-format/design decisions.
