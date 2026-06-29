# ---
# core outputs consumed by each machine layer via terraform_remote_state (#32).
# ---
output "account_id" {
  value = var.account_id
}

output "zone_id" {
  value = data.cloudflare_zone.main.id
}

output "zone_name" {
  value = var.zone_name
}

# IdP ids to attach to every Access application (empty Google entry filtered out).
output "idp_ids" {
  value = compact(concat(
    [cloudflare_access_identity_provider.otp.id],
    cloudflare_access_identity_provider.google[*].id,
  ))
}

output "service_token_id" {
  value = cloudflare_access_service_token.ci.id
}

# Client id is safe to surface; the secret is shown ONCE at create time in TFC and
# must be copied into the test runner's env (see README).
output "service_token_client_id" {
  value = cloudflare_access_service_token.ci.client_id
}
