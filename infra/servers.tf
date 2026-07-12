data "hcloud_ssh_key" "default" {
  name = var.ssh_key_name
}

# The ingest/web server (woozi-1) is managed outside of Tofu for now.
# Only extraction servers are provisioned here.

resource "hcloud_server" "extraction" {
  count       = var.extraction_server_count
  name        = "woozi-extraction-${count.index + 1}"
  server_type = var.extraction_server_type
  location    = var.location
  image       = "docker-ce"
  ssh_keys    = [data.hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.worker.id]

  user_data = templatefile("${path.module}/cloud-init/worker.yaml", {
    extraction_service_image = var.extraction_service_image
    uvicorn_workers          = var.extraction_uvicorn_workers
    s3_storage_endpoint      = var.s3_storage_endpoint
    s3_storage_region        = var.s3_storage_region
    s3_storage_bucket_name   = var.s3_storage_bucket_name
    s3_access_key            = var.s3_access_key
    s3_secret_key            = var.s3_secret_key
  })
}
