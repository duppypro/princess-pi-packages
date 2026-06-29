# ---
# machine layer inputs (#32).
# ---
variable "tfc_org" {
  type        = string
  description = "Terraform Cloud organization (to read the core workspace's outputs)."
}

variable "machine" {
  type        = string
  description = "Short machine id used as the subdomain segment (e.g. vps, mac). Matches PI_SERVE_MACHINE."
}

variable "session_duration" {
  type        = string
  default     = "24h"
  description = "Access session lifetime before re-auth."
}

# Written by /serve (serve-shares.auto.tfvars.json). Keyed by DNS label.
variable "shares" {
  type = map(object({
    hostname = string
    port     = number
    dir      = string
    slug     = string
    emails   = list(string)
  }))
  default = {}
}
