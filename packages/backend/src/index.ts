import { resolve } from "node:path";
import { CurseForgeClient, FsBlobStore, ModrinthClient } from "@remix/core";
import { buildApp } from "./app.js";
import { Store } from "./store.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = resolve(env.DATA_DIR ?? ".data");

if (!env.ADMIN_TOKEN) {
  if (env.NODE_ENV === "production") {
    console.error("ADMIN_TOKEN is required.");
    process.exit(1);
  }
  env.ADMIN_TOKEN = "dev";
  console.warn('ADMIN_TOKEN not set: using "dev" (local development only).');
}

const store = new Store(resolve(env.SQLITE_PATH ?? `${dataDir}/remix.db`));
const adminUsername = env.ADMIN_USERNAME ?? "admin";
// ADMIN_PASSWORD (re)sets the admin account's password so the admin can sign in from the launcher.
store.ensureAdmin(adminUsername, env.ADMIN_PASSWORD || (env.NODE_ENV === "production" ? undefined : "dev"));

const blobs = new FsBlobStore(resolve(env.BLOB_DIR ?? `${dataDir}/blobs`), `${publicUrl}/`);

const app = buildApp({
  store,
  blobs,
  serveBlobs: true,
  modrinth: new ModrinthClient(),
  curseforge: env.CURSEFORGE_API_KEY ? new CurseForgeClient(env.CURSEFORGE_API_KEY) : undefined,
  adminToken: env.ADMIN_TOKEN,
  adminUsername,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port, host: env.HOST ?? "0.0.0.0" });
app.log.info(`Public URL ${publicUrl}; data in ${dataDir}; CurseForge ${env.CURSEFORGE_API_KEY ? "on" : "off (no key)"}`);
