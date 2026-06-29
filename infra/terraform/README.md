# `/serve` on Cloudflare — onboarding & operation (#32)

Stands up the Cloudflare gate that replaces the oauth2-proxy + nginx `/live/` stack.
Two Terraform layers: **`core/`** (account-wide, once) and **`machine/`** (one per serving
host). State lives in **Terraform Cloud**. After onboarding, `serve` / `serve --kill` drive
everything.

## Part A — one-time onboarding (Duppy, from your own SSH/terminal)

> Headless VPS: run the interactive bits (`terraform login`, any browser auth) yourself.

1. **DNS** — move `princess-pi.dev` nameservers to Cloudflare; wait for the zone to go *Active*.
2. **Zero Trust** — pick a team domain. Add identity providers: **Google** and **One-time PIN**
   (GitHub/Apple/Twitch later; Apple & Twitch via *generic OIDC*; Discord is not OIDC-compliant,
   skip).
3. **API token** — create a scoped Cloudflare token with: Zone→DNS:Edit, Account→Access:Edit,
   Account→Cloudflare Tunnel:Edit, Account→Account Settings:Read. Then:
   `export CLOUDFLARE_API_TOKEN=...`
4. **Terraform Cloud** — create an org; `terraform login`. Replace `REPLACE_TFC_ORG` in
   `core/versions.tf` and `machine/versions.tf` with your org name. Create workspaces:
   `pi-serve-core` (name), and per host a tag-`pi-serve-machine` workspace (e.g. `pi-serve-vps`).
5. **Tools** — install `terraform` and `cloudflared` on each serving host.
6. **core apply** (once):
   ```bash
   cd infra/terraform/core
   cp terraform.tfvars.example terraform.tfvars   # set account_id (+ Google creds optional)
   terraform init && terraform apply
   ```
   Copy the **service-token secret** shown once into your test runner env:
   `export CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...`
7. **machine init + tunnel** (per host):
   ```bash
   cd infra/terraform/machine
   cp terraform.tfvars.example terraform.tfvars   # set tfc_org + machine (e.g. "vps")
   terraform init   # select/create this host's pi-serve-<machine> workspace
   terraform apply  # no shares yet -> just creates the tunnel
   cloudflared tunnel run --token "$(terraform output -raw tunnel_token)"   # run as a service
   ```
   Set `PI_SERVE_MACHINE` to the same id (`vps`) so `serve` builds matching hostnames.

## Part B — daily use (automated)

- `serve docs/` → starts the loopback server, writes `serve-shares.auto.tfvars.json`, runs
  `terraform apply`, prints `https://<label>.<machine>.preview.princess-pi.dev/` **and** the
  loopback `http://127.0.0.1:<port>/`.
- `serve --kill docs/` (or `--kill all`) → removes the share, `terraform apply` (Cloudflare
  destroys that app/policy/DNS/ingress), stops the local process.
- Grant a reviewer: add their email to `.serve-acl` in the served dir (or any parent up to
  `~/.serve-acl`), then re-run `serve` for that dir. Revoke: remove it and re-run.

## Tests

- On the host: `curl http://127.0.0.1:<port>/` → 200, no auth.
- From Mac/CI through the edge: send the service-token headers
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` (from step 6).
- `PI_SERVE_DRY_RUN=1 serve …` → writes tfvars and runs `terraform plan` only (no apply).

> Provider note: pinned to `cloudflare/cloudflare ~> 4.52`. In provider v5 the resources are
> renamed `cloudflare_zero_trust_*`; bump deliberately when upgrading.
