# ---
# core layer — account-wide scaffolding, applied once (#32).
# Remote state in Terraform Cloud (shared by every machine workspace, with locking).
# ---
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }

  cloud {
    organization = "REPLACE_TFC_ORG" # set during onboarding (infra/terraform/README.md)
    workspaces {
      name = "pi-serve-core"
    }
  }
}

# Token comes from CLOUDFLARE_API_TOKEN in the environment (do not hardcode).
provider "cloudflare" {}
