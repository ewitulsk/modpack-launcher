# Deliberately tiny: one $4 droplet running the API under systemd, SQLite and uploaded files on its
# disk, a reserved IP (free while attached) so the address survives rebuilds, and a free firewall.

resource "random_password" "admin_token" {
  length  = 40
  special = false
}

resource "random_password" "admin_password" {
  length  = 20
  special = false
}

resource "digitalocean_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "digitalocean_reserved_ip" "api" {
  region = var.region
}

resource "digitalocean_droplet" "api" {
  name       = var.name
  region     = var.region
  size       = var.size
  image      = "ubuntu-24-04-x64"
  ssh_keys   = [digitalocean_ssh_key.deploy.id]
  monitoring = false
  backups    = false

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    public_url         = "http://${digitalocean_reserved_ip.api.ip_address}"
    admin_token        = random_password.admin_token.result
    admin_username     = var.admin_username
    admin_password     = random_password.admin_password.result
    curseforge_api_key = var.curseforge_api_key
  })

  # Changing cloud-init shouldn't rebuild the droplet (and wipe its data); deploys go over SSH.
  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "digitalocean_reserved_ip_assignment" "api" {
  ip_address = digitalocean_reserved_ip.api.ip_address
  droplet_id = digitalocean_droplet.api.id
}

resource "digitalocean_firewall" "api" {
  name        = "${var.name}-fw"
  droplet_ids = [digitalocean_droplet.api.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_project" "remix" {
  name        = var.name
  description = "Friends-only modpack server"
  purpose     = "Web Application"
  environment = "Production"
  resources = [
    digitalocean_droplet.api.urn,
    digitalocean_reserved_ip.api.urn,
  ]
}
