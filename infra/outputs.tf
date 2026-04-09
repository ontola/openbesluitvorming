output "extraction_server_ips" {
  value = [for s in hcloud_server.extraction : s.ipv4_address]
  description = "Public IPs of extraction servers"
}

output "extraction_service_url_env" {
  value       = join(",", [for s in hcloud_server.extraction : "http://${s.ipv4_address}:8000"])
  description = "Value for WOOZI_EXTRACTION_SERVICE_URL"
}
