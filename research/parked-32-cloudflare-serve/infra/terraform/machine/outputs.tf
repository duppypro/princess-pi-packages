# ---
# machine outputs (#32).
# ---
# Token to run this machine's connector: `cloudflared tunnel run --token <token>`.
output "tunnel_token" {
  value     = cloudflare_tunnel.this.tunnel_token
  sensitive = true
}

output "tunnel_id" {
  value = cloudflare_tunnel.this.id
}

output "gated_urls" {
  value = { for label, s in var.shares : label => "https://${s.hostname}/" }
}
