# ---
# machine layer — one workspace per serving host (VPS, MacBook, …). Owns that host's
# tunnel + the Access apps/policies for its live shares. Driven by /serve, which writes
# serve-shares.auto.tfvars.json and runs `terraform apply`. (#32)
#
# Workspaces are selected by tag at `terraform init` (e.g. pi-serve-vps, pi-serve-mac),
# so multiple machines share one TFC org without clobbering each other.
# ---
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  cloud {
    organization = "REPLACE_TFC_ORG"
    workspaces {
      tags = ["pi-serve-machine"]
    }
  }
}

provider "cloudflare" {}
