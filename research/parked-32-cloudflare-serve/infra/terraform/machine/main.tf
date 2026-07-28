# ---
# machine layer — this host's tunnel + per-share DNS / Access app / policy. (#32)
# ---
data "terraform_remote_state" "core" {
  backend = "remote"
  config = {
    organization = var.tfc_org
    workspaces = {
      name = "pi-serve-core"
    }
  }
}

locals {
  account_id       = data.terraform_remote_state.core.outputs.account_id
  zone_id          = data.terraform_remote_state.core.outputs.zone_id
  idp_ids          = data.terraform_remote_state.core.outputs.idp_ids
  service_token_id = data.terraform_remote_state.core.outputs.service_token_id
}

# --- One named tunnel for this machine. cloudflared runs locally with its token. ---
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_tunnel" "this" {
  account_id = local.account_id
  name       = "pi-serve-${var.machine}"
  secret     = random_id.tunnel_secret.b64_std
}

# --- Remotely-managed ingress: one rule per live share, plus a terminal 404. ---
resource "cloudflare_tunnel_config" "this" {
  account_id = local.account_id
  tunnel_id  = cloudflare_tunnel.this.id

  config {
    dynamic "ingress_rule" {
      for_each = var.shares
      content {
        hostname = ingress_rule.value.hostname
        service  = "http://127.0.0.1:${ingress_rule.value.port}"
      }
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# --- Per-share public DNS (proxied CNAME to the tunnel). ---
resource "cloudflare_record" "share" {
  for_each = var.shares
  zone_id  = local.zone_id
  name     = each.value.hostname
  type     = "CNAME"
  content  = "${cloudflare_tunnel.this.id}.cfargotunnel.com"
  proxied  = true
}

# --- Per-share Access application (binds the gate to exactly this hostname). ---
resource "cloudflare_access_application" "share" {
  for_each                  = var.shares
  account_id                = local.account_id
  name                      = "serve ${each.value.slug} (${var.machine})"
  domain                    = each.value.hostname
  session_duration          = var.session_duration
  allowed_idps              = local.idp_ids
  auto_redirect_to_identity = false # show the login picker (multiple IdPs)
}

# --- Per-share policy: allow the cascaded reviewer emails OR the CI service token.
#     Separate include blocks are OR'd. Per-app policy => hard isolation between shares. ---
resource "cloudflare_access_policy" "share" {
  for_each       = var.shares
  application_id = cloudflare_access_application.share[each.key].id
  account_id     = local.account_id
  name           = "allow-reviewers"
  precedence     = 1
  decision       = "allow"

  include {
    email = each.value.emails
  }
  include {
    service_token = [local.service_token_id]
  }
}
