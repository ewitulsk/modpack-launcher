variable "name" {
  description = "Name for the droplet and related resources."
  type        = string
  default     = "remix-packs"
}

variable "region" {
  description = "DigitalOcean region slug."
  type        = string
  default     = "tor1" # nyc regions do not offer s-1vcpu-512mb-10gb
}

variable "size" {
  description = "Droplet size. s-1vcpu-512mb-10gb is the cheapest ($4/mo): 512 MB RAM (plus swap), 10 GB disk."
  type        = string
  default     = "s-1vcpu-512mb-10gb"
}

variable "ssh_public_key_path" {
  description = "Public key that can SSH in as root (used by npm run deploy)."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "admin_username" {
  description = "Pack account that gets admin rights (makes invite codes, can publish to any pack)."
  type        = string
  default     = "evan"
}

variable "curseforge_api_key" {
  description = "Optional CurseForge API key. Without it only Modrinth bases work."
  type        = string
  default     = ""
  sensitive   = true
}
