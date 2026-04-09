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
  })
}
