# @remix/backend

Fastify API that keeps accounts, packs and revisions in one SQLite file (`node:sqlite`, no native modules), stores uploaded files on disk, and resolves remixes into lockfiles. It ships as a single bundled file, `dist/server.mjs`.

```sh
npm run dev -w @remix/backend     # http://localhost:3000, admin account "admin" / "dev", ADMIN_TOKEN "dev"
npm test -w @remix/backend
npm run bundle -w @remix/backend  # dist/server.mjs, what `npm run deploy` ships
```

## Environment

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base for uploaded-file download URLs in lockfiles. |
| `DATA_DIR` | `.data` | Holds `remix.db` and `blobs/`. |
| `SQLITE_PATH`, `BLOB_DIR` | inside `DATA_DIR` | Override either location. |
| `ADMIN_TOKEN` | `dev` (required in production) | Bearer token that acts as the admin account. |
| `ADMIN_USERNAME` | `admin` | The admin account, created on start. |
| `ADMIN_PASSWORD` | `dev` outside production | Sets the admin's password so they can sign in from the launcher. |
| `CURSEFORGE_API_KEY` | none | Enables CurseForge bases. |

## API

| Route | Who | |
| --- | --- | --- |
| `GET /health` | anyone | |
| `GET /packs`, `GET /packs/:pack` | anyone | `:pack` is the id or slug |
| `GET /packs/:pack/revisions/:rev[/lockfile?side=server]` | anyone | `:rev` is a number or `latest` |
| `GET /blobs/:xx/:sha256` | anyone | uploaded files |
| `POST /accounts/register` `{code, username, password}` | anyone with an invite | → `{token, user}` |
| `POST /accounts/login` `{username, password}` | anyone | → `{token, user}` |
| `POST /accounts/logout`, `GET /me` | account | |
| `POST /packs` `{name, description}` | account | you own the pack |
| `POST /resolve/preview` `{remix}` | account | dry run |
| `POST /packs/:pack/revisions` `{remix, changelog}` | pack owner or admin | |
| `HEAD/PUT /blobs/:sha256` | account | upload (`application/octet-stream`, hash checked) |
| `POST /invites`, `GET /invites`, `GET /users` | admin | |
