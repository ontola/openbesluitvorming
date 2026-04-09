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
