# Firewall for the ingest/web server — allows SSH, HTTP, HTTPS from the internet.
resource "hcloud_firewall" "ingest" {
  name = "woozi-ingest"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# Firewall for extraction workers — SSH only, no public HTTP.
# The extraction service listens on port 8000 but is only reachable
# via the private network (10.0.0.0/16).
resource "hcloud_firewall" "worker" {
  name = "woozi-worker"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Allow extraction service access from the production ingest server
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "8000"
    source_ips = ["91.98.32.151/32"]
  }
}
