variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token"
}

variable "ssh_key_name" {
  type        = string
  default     = "joepio-ed25519"
  description = "Name of the SSH key registered in Hetzner Cloud"
}

variable "location" {
  type        = string
  default     = "fsn1"
  description = "Hetzner Cloud location"
}

variable "extraction_server_count" {
  type        = number
  default     = 0
  description = "Number of extraction servers. Set to 0 when not importing."
}

variable "extraction_server_type" {
  type        = string
  default     = "cpx22"
  description = "Server type for the extraction server. Use 'cpx22' for testing, dedicated types like 'ax41-nvme' for production imports."
}

variable "extraction_uvicorn_workers" {
  type        = number
  default     = 2
  description = "Number of uvicorn worker processes. Match to the number of CPU cores/threads on the server."
}

variable "extraction_service_image" {
  type        = string
  default     = "ghcr.io/ontola/woozi-extraction:latest"
  description = "Docker image for the extraction service"
}

# S3 credentials for the extraction service. The service uploads extracted
# markdown directly to object storage; without these every /extract request
# fails with "Unable to locate credentials". Use the same values as the
# S3_* entries in /opt/woozi/.env on the ingest server.
variable "s3_storage_endpoint" {
  type        = string
  description = "S3-compatible endpoint URL for the extraction service"
}

variable "s3_storage_region" {
  type        = string
  default     = "us-east-1"
  description = "S3 region for the extraction service"
}

variable "s3_storage_bucket_name" {
  type        = string
  description = "S3 bucket for extracted document artifacts"
}

variable "s3_access_key" {
  type        = string
  sensitive   = true
  description = "S3 access key for the extraction service"
}

variable "s3_secret_key" {
  type        = string
  sensitive   = true
  description = "S3 secret key for the extraction service"
}
