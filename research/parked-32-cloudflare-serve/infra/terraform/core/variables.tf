# ---
# core layer inputs (#32). Secrets via TFC workspace vars / env, never committed.
# ---
variable "account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "zone_name" {
  type        = string
  default     = "princess-pi.dev"
  description = "The zone hosting the *.preview gated previews."
}

variable "google_client_id" {
  type        = string
  default     = ""
  description = "Google OAuth client id for the Access Google IdP (blank = skip)."
}

variable "google_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Google OAuth client secret for the Access Google IdP."
}
