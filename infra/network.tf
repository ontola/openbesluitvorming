# Private network for ingest server <-> extraction workers.
# Workers are only reachable on this network, not from the internet.

resource "hcloud_network" "woozi" {
  name     = "woozi-internal"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "woozi" {
  network_id   = hcloud_network.woozi.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}
