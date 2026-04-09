terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }

  # Store state in Hetzner Object Storage (S3-compatible).
  # Initialize with:
  #   tofu init \
  #     -backend-config="access_key=$S3_ACCESS_KEY" \
  #     -backend-config="secret_key=$S3_SECRET_KEY"
  backend "s3" {
    bucket                      = "woozi-dev"
    key                         = "tfstate/terraform.tfstate"
    endpoints                   = { s3 = "https://fsn1.your-objectstorage.com" }
    region                      = "fsn1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
