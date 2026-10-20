output "ip" {
  description = "Reserved IP. Stays the same even if the droplet is rebuilt."
  value       = digitalocean_reserved_ip.api.ip_address
}

output "server_url" {
  description = "Put this in packages/launcher/.env.production as MAIN_VITE_SERVER_URL."
  value       = "http://${digitalocean_reserved_ip.api.ip_address}"
}

output "admin_username" {
  value = var.admin_username
}

output "admin_password" {
  description = "Sign in from the launcher (Remix & publish) with admin_username and this."
  value       = random_password.admin_password.result
  sensitive   = true
}

output "admin_token" {
  description = "Bearer token that acts as the admin account, for scripts."
  value       = random_password.admin_token.result
  sensitive   = true
}

output "pack_key" {
  description = "Shared key every pack download needs. npm run deploy puts it on the server; hand it to friends yourself (it is never built into the launcher)."
  value       = random_password.pack_key.result
  sensitive   = true
}
