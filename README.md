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

Anyone can browse packs. Downloading one needs the shared pack key: one key for everyone, which Evan hands out himself. It's never built into the installer; the launcher asks for it the first time you download a pack and remembers it. Playing needs no pack account. To remix and publish you need a pack account, and making one needs an invite code from the admin (Remix & publish → New invite code). You can publish to packs you created; the admin can publish to any.

## Versions and updates

Every publish is a new, immutable version (optionally named, like "1.2"). Launchers keep track of the version they installed and, on update, download only files that are new or changed and delete only files the pack removed; worlds and the player's own files are left alone. Downloaded files also go into a shared cache, so a mod already downloaded for one pack is never downloaded again for another.

## Deploy

```sh
cd infra/terraform && terraform init && terraform apply   # once; needs DIGITALOCEAN_TOKEN
cd ../.. && npm run deploy                                # every backend change
```

`npm run deploy` builds the backend into one file (`packages/backend/dist/server.mjs`), copies it to the droplet over SSH, sets the pack key there, restarts it, and writes the server address (never the key) into `packages/launcher/.env.production` for the next installer build. Get the key to hand out with `terraform -chdir=infra/terraform output -raw pack_key`. See [infra/terraform/README.md](infra/terraform/README.md).

## Releases

Pushing a tag `vX.Y.Z` (or Actions → Release launcher → Run workflow, or `gh workflow run release.yml -f version=X.Y.Z`) builds the Windows installer on GitHub and attaches it to a release. The server address comes from the `SERVER_URL` repo variable (default: the live droplet). The pack key is never built in: hand it to friends yourself, and the launcher asks for it the first time they download a pack.

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
