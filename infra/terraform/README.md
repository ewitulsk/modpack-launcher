# DigitalOcean (about $4/month)

One `s-1vcpu-512mb-10gb` droplet ($4/mo) runs the API under systemd on port 80, with SQLite and uploaded files on its 10 GB disk and 1 GB of swap. A reserved IP (free while attached) keeps the address fixed if the droplet is ever rebuilt, and a cloud firewall (free) allows only SSH and HTTP. No database, Spaces, load balancer or domain.

Upstream mods download straight from Modrinth/CurseForge, so the disk only holds files you upload yourself.

## First time

```sh
# token: doctl auth token  (or create one in the DO control panel → API)
$env:DIGITALOCEAN_TOKEN = (doctl auth token)    # PowerShell
cd infra/terraform
terraform init
terraform apply
terraform output server_url
terraform output -raw admin_password
cd ../..
npm run deploy
```

Then put the server address in `packages/launcher/.env.production`:

```
MAIN_VITE_SERVER_URL=http://<ip>
```

and build the launcher for friends (`npm run dist -w @remix/launcher`). Sign in from the launcher's **Remix & publish** tab as `evan` with the admin password, and make invite codes there.

## Later

- Backend changes: `npm run deploy`.
- Logs: `ssh root@<ip> journalctl -u remix -f`.
- Backup: `scp -r root@<ip>:/var/lib/private/remix ./backup` (the database and uploads).
- `terraform destroy` deletes the droplet and everything on it.

Cloud-init changes don't rebuild the droplet (it would wipe the data); edit `/etc/remix/env` over SSH and `systemctl restart remix` instead.
