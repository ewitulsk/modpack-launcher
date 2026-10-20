# @remix/launcher

Electron + TypeScript launcher built on `@xmcl/core` / `@xmcl/installer`.

## Run it

```sh
npm install            # from the repo root
npm run build -w @remix/core
npm run dev -w @remix/launcher
```

`npm run dev` connects to the local backend (`npm run dev:backend`, admin token `dev`) automatically.

## Server address

| How | When |
| --- | --- |
| `REMIX_SERVER_URL` (and optionally `REMIX_TOKEN`) environment variables | Any run; overrides everything else |
| `MAIN_VITE_SERVER_URL=https://...` in `packages/launcher/.env.production` | Baked into `npm run dist` builds, so friends open the launcher and see the packs straight away. Never put the admin token there. |
| Typed on the connect screen | When neither is set |

The pack key works the same way: `REMIX_PACK_KEY` at runtime, `MAIN_VITE_PACK_KEY` in `.env.production` at build (`npm run deploy` writes it), or typed in when the server asks for it.

Logins are remembered per server, so switching between local and real servers keeps both.

## What's where

| Path | |
| --- | --- |
| `src/main/index.ts` | Electron main process and IPC handlers |
| `src/main/auth/microsoft.ts` | Microsoft → Xbox → Minecraft sign-in, token refresh |
| `src/main/auth/modrinth-app.ts` | Import accounts from the Modrinth App's `app.db` |
| `src/main/game/sync.ts` | Sync an instance to a lockfile; blocked-mod helper |
| `src/main/game/install.ts` | Minecraft, Fabric/Quilt/Forge/NeoForge and Mojang Java via @xmcl |
| `src/main/game/capture.ts` | "Capture changes": instance folder diff → remix ops |
| `src/renderer` | React UI |
| `scripts/smoke.ts` | Headless end-to-end test against real servers |

Data lives in `%APPDATA%\@remix\launcher\`: `game/` (shared versions, libraries, assets), `java/`, `instances/<pack>/`.

## Sign-in

By default sign-in uses Microsoft's login page with the official launcher's public client id, so it works without registering an app. Once Mojang approves your own Azure app id, put it in Settings to switch to the device-code flow.

## Smoke test

```sh
npm run smoke -w @remix/launcher -- --modrinth <versionId> --launch
```

Resolves the pack, installs everything into `.smoke/`, and launches offline until the title screen appears.
