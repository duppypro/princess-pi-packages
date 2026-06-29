# ---
# core layer — IdPs + the test service token. The zone is looked up; per-machine
# DNS + Access apps live in the machine layer (which reads these outputs). (#32)
# ---
data "cloudflare_zone" "main" {
  name = var.zone_name
}

# --- Identity providers. One-time PIN (email) is always available; Google when creds set.
#     GitHub/Apple/Twitch added later (Apple & Twitch via generic OIDC; Discord is NOT
#     OIDC-compliant and is out of scope). ---
resource "cloudflare_access_identity_provider" "otp" {
  account_id = var.account_id
  name       = "Email one-time PIN"
  type       = "onetimepin"
}

resource "cloudflare_access_identity_provider" "google" {
  count      = var.google_client_id == "" ? 0 : 1
  account_id = var.account_id
  name       = "Google"
  type       = "google"
  config {
    client_id     = var.google_client_id
    client_secret = var.google_client_secret
  }
}

# --- The ONE test credential (non-interactive edge bypass for CI / MacBook tests).
#     Presented as CF-Access-Client-Id / CF-Access-Client-Secret headers. ---
resource "cloudflare_access_service_token" "ci" {
  account_id = var.account_id
  name       = "pi-serve-ci-tests"
}
