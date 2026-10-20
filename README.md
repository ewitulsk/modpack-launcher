# ModpackLauncher

A Minecraft modpack launcher plus a small backend for sharing modpacks between friends.

Architecture and decisions: [ModpackLauncher Architecture](https://claude.ai/code/artifact/d1301c62-6256-45ec-be81-32f683d7a3c8)

## Goals

- **Launcher**: install and launch modpacks (loader, mods, configs) with one click.
- **Backend**: host shared modpacks so friends can pull the latest version.
- **Remixing**: take a pinned CurseForge or Modrinth pack, add/remove/replace jars, configs, KubeJS, worlds, and publish it as a "Remixed Pack".
- **Playtesting**: spin up a pack quickly, collect feedback, and track which version was tested.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | `@remix/core`: remix format, op applier, lockfile, CurseForge/Modrinth resolvers, sync planner. Shared by launcher and backend. |
| `packages/backend` | Fastify API: accounts (invite-only), packs, publish (resolves lockfiles), uploads. SQLite + files on disk. See its README. |
| `packages/launcher` | Electron + TypeScript + @xmcl launcher. See its README. |
| `infra/terraform` | DigitalOcean: one $4 droplet, reserved IP, firewall. See its README. |

## Working on it

Requires Node 22+.

```sh
npm install
npm test               # every package's tests
npm run build
npm run dev:backend    # admin / dev, data in packages/backend/.data
npm run dev:launcher
```

## Accounts

Anyone with the launcher can browse and play every pack, no account needed. To remix and publish you need a pack account, and making one needs an invite code from the admin (Remix & publish → New invite code). You can publish to packs you created; the admin can publish to any.

## Deploy

```sh
cd infra/terraform && terraform init && terraform apply   # once; needs DIGITALOCEAN_TOKEN
cd ../.. && npm run deploy                                # every backend change
```

`npm run deploy` builds the backend into one file (`packages/backend/dist/server.mjs`), copies it to the droplet over SSH and restarts it. See [infra/terraform/README.md](infra/terraform/README.md).

## Try resolving a pack

A remix is a JSON file: a pinned base pack plus ops. The smallest one is just a base:

```json
{
  "schema": 1,
  "name": "My first remix",
  "base": { "source": "modrinth", "versionId": "<version id from the pack's Modrinth version page URL>" },
  "ops": []
}
```

For a CurseForge base use `{ "source": "curseforge", "projectId": 123, "fileId": 456 }` (both are in the file's CurseForge URL) and set `CURSEFORGE_API_KEY`.

```sh
npm run build
node packages/core/dist/cli.js resolve my-remix.json
```

It writes `my-remix.client.lock.json` and prints how many files resolved and which CurseForge mods need a manual download. `--side server` builds the server-pack lockfile instead. Upload-style ops (`putFile`, `addWorld`) read blobs from `.blobs/` locally; the backend stores them on its disk.
