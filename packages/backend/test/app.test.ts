import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBlobStore, ModrinthClient, sha256, type Fetcher, type Lockfile } from "@remix/core";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";

const MR = "https://api.modrinth.com/v2";
const mrpack = zipSync({
  "modrinth.index.json": strToU8(
    JSON.stringify({
      formatVersion: 1,
      name: "Base",
      dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.5" },
      files: [
        {
          path: "mods/a.jar",
          hashes: { sha1: "a".repeat(40), sha512: "a".repeat(128) },
          downloads: ["https://cdn.modrinth.com/data/AAA/versions/V1/a.jar"],
          fileSize: 1,
        },
      ],
    }),
  ),
  "overrides/config/a.toml": strToU8("x=1"),
});

const fetcher: Fetcher = async (url) => {
  if (url === `${MR}/version/BASE`)
    return Response.json({ id: "BASE", project_id: "P", files: [{ url: "https://cdn/base.mrpack", filename: "base.mrpack", primary: true, size: 1, hashes: {} }] });
  if (url === "https://cdn/base.mrpack") return new Response(mrpack);
  return new Response("nope", { status: 404 });
};

const ADMIN = "admin-secret";

describe("API", () => {
  let store: Store;
  let blobs: MemoryBlobStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    store = new Store(":memory:");
    blobs = new MemoryBlobStore();
    app = buildApp({ store, blobs, modrinth: new ModrinthClient(fetcher), fetcher, adminToken: ADMIN });
  });
  afterEach(() => store.close());

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const signUp = async (username: string, password = "hunter2") => {
    const invite = (await app.inject({ method: "POST", url: "/invites", headers: as(ADMIN), payload: { note: username } })).json();
    const r = await app.inject({ method: "POST", url: "/accounts/register", payload: { code: invite.code, username, password } });
    expect(r.statusCode).toBe(201);
    return r.json().token as string;
  };

  it("needs an invite to make an account, and an account to publish", async () => {
    expect((await app.inject({ url: "/packs" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/packs", payload: { name: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/invites", headers: as("nope") })).statusCode).toBe(401);

    const bad = await app.inject({ method: "POST", url: "/accounts/register", payload: { code: "NOPE", username: "sam", password: "hunter2" } });
    expect(bad.statusCode).toBe(404);

    const invite = (await app.inject({ method: "POST", url: "/invites", headers: as(ADMIN), payload: { note: "Sam" } })).json();
    const reg = await app.inject({ method: "POST", url: "/accounts/register", payload: { code: invite.code.toLowerCase(), username: "Sam", password: "hunter2" } });
    expect(reg.statusCode).toBe(201);
    const { token } = reg.json();
    expect((await app.inject({ url: "/me", headers: as(token) })).json()).toMatchObject({ username: "Sam", isAdmin: false });

    const again = await app.inject({ method: "POST", url: "/accounts/register", payload: { code: invite.code, username: "Other", password: "hunter2" } });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/invites", headers: as(token) })).statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: "/accounts/login", payload: { username: "sam", password: "wrong" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/accounts/login", payload: { username: "sam", password: "hunter2" } });
    expect(login.statusCode).toBe(200);
    const t2 = login.json().token;
    await app.inject({ method: "POST", url: "/accounts/logout", headers: as(t2) });
    expect((await app.inject({ url: "/me", headers: as(t2) })).statusCode).toBe(401);
    expect((await app.inject({ url: "/me", headers: as(token) })).statusCode).toBe(200);

    const taken = await signUp("someone");
    expect(taken).toBeTruthy();
    const invite2 = (await app.inject({ method: "POST", url: "/invites", headers: as(ADMIN) })).json();
    const dup = await app.inject({ method: "POST", url: "/accounts/register", payload: { code: invite2.code, username: "SOMEONE", password: "hunter2" } });
    expect(dup.statusCode).toBe(409);
  });

  it("lets anyone browse but needs the pack key on every download, even for accounts", async () => {
    const pack = (await app.inject({ method: "POST", url: "/packs", headers: as(ADMIN), payload: { name: "Keyed" } })).json();
    const remix = { schema: 1, name: "K", base: { source: "modrinth", versionId: "BASE" }, ops: [] };
    expect((await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(ADMIN), payload: { remix } })).statusCode).toBe(201);
    const locked = buildApp({ store, blobs, modrinth: new ModrinthClient(fetcher), fetcher, adminToken: ADMIN, packKey: "letmein", serveBlobs: true });
    const jar = new TextEncoder().encode("jar");
    const hex = sha256(jar);
    await blobs.put(jar);
    expect((await locked.inject({ url: "/health" })).json().packKey).toBe(true);
    expect((await locked.inject({ url: "/packs" })).statusCode).toBe(200);
    expect((await locked.inject({ url: `/packs/${pack.slug}` })).statusCode).toBe(200);

    const downloads = [`/packs/${pack.slug}/revisions/latest`, `/packs/${pack.slug}/revisions/latest/lockfile`, `/blobs/${hex.slice(0, 2)}/${hex}`];
    for (const url of downloads) {
      const denied = await locked.inject({ url });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().code).toBe("pack-key");
      expect((await locked.inject({ url, headers: as(ADMIN) })).statusCode).toBe(401);
      expect((await locked.inject({ url, headers: { "x-pack-key": "wrong" } })).statusCode).toBe(401);
      expect((await locked.inject({ url, headers: { "x-pack-key": "letmein" } })).statusCode).toBe(200);
    }
    expect((await locked.inject({ url: `/blobs/${hex.slice(0, 2)}/${hex}?key=letmein` })).statusCode).toBe(200);
  });

  it("names versions and records what changed since the previous one", async () => {
    const pack = (await app.inject({ method: "POST", url: "/packs", headers: as(ADMIN), payload: { name: "V" } })).json();
    const base = { schema: 1, name: "R", base: { source: "modrinth", versionId: "BASE" } };
    const v1 = await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(ADMIN), payload: { remix: { ...base, ops: [] }, version: "1.0" } });
    expect(v1.json()).toMatchObject({ revision: 1, version: "1.0" });
    expect(v1.json().changes).toBeUndefined();
    const jar = new TextEncoder().encode("extra");
    const hex = sha256(jar);
    await blobs.put(jar);
    const v2 = await app.inject({
      method: "POST",
      url: `/packs/${pack.slug}/revisions`,
      headers: as(ADMIN),
      payload: { remix: { ...base, ops: [{ op: "putFile", path: "mods/extra.jar", blob: `sha256:${hex}` }, { op: "deletePath", glob: "config/**" }] } },
    });
    expect(v2.json().changes).toEqual({ added: ["mods/extra.jar"], updated: [], removed: ["config/a.toml"], downloadBytes: 5 });
  });

  it("only lets the owner (or the admin) publish to a pack", async () => {
    const sam = await signUp("sam");
    const kim = await signUp("kim");
    const pack = (await app.inject({ method: "POST", url: "/packs", headers: as(sam), payload: { name: "Sam's" } })).json();
    expect(pack.ownerName).toBe("sam");
    const remix = { schema: 1, name: "R", base: { source: "modrinth", versionId: "BASE" }, ops: [] };
    expect((await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(kim), payload: { remix } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(sam), payload: { remix } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().publishedBy).toBe("sam");
    expect((await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(ADMIN), payload: { remix } })).statusCode).toBe(201);
    // anyone can download
    expect((await app.inject({ url: `/packs/${pack.slug}/revisions/latest/lockfile` })).statusCode).toBe(200);
  });

  it("uploads a blob, publishes a remix that uses it, and serves the lockfile", async () => {
    const jar = new TextEncoder().encode("my jar");
    const hex = sha256(jar);
    const bad = await app.inject({ method: "PUT", url: `/blobs/${"0".repeat(64)}`, headers: { ...as(ADMIN), "content-type": "application/octet-stream" }, payload: Buffer.from(jar) });
    expect(bad.statusCode).toBe(400);
    const up = await app.inject({ method: "PUT", url: `/blobs/${hex}`, headers: { ...as(ADMIN), "content-type": "application/octet-stream" }, payload: Buffer.from(jar) });
    expect(up.json().blob).toBe(`sha256:${hex}`);
    expect((await app.inject({ method: "HEAD", url: `/blobs/${hex}`, headers: as(ADMIN) })).statusCode).toBe(200);

    const pack = (await app.inject({ method: "POST", url: "/packs", headers: as(ADMIN), payload: { name: "Evan's Test Pack!" } })).json();
    expect(pack.slug).toBe("evan-s-test-pack");
    expect((await app.inject({ method: "POST", url: "/packs", headers: as(ADMIN), payload: { name: "Evan's Test Pack!" } })).statusCode).toBe(409);

    const remix = {
      schema: 1,
      name: "Remixed",
      base: { source: "modrinth", versionId: "BASE" },
      ops: [
        { op: "putFile", path: "mods/mine.jar", blob: `sha256:${hex}` },
        { op: "deletePath", glob: "config/**" },
      ],
    };
    const pub = await app.inject({ method: "POST", url: `/packs/${pack.slug}/revisions`, headers: as(ADMIN), payload: { remix, changelog: "first" } });
    expect(pub.statusCode).toBe(201);
    expect(pub.json()).toMatchObject({ revision: 1, fileCount: 2, blockedCount: 0, minecraft: "1.21.1", loader: { type: "fabric", version: "0.16.5" } });

    await app.inject({ method: "POST", url: `/packs/${pack.id}/revisions`, headers: as(ADMIN), payload: { remix: { ...remix, ops: [] } } });

    const list = (await app.inject({ url: "/packs", headers: as(ADMIN) })).json();
    expect(list).toHaveLength(1);
    expect(list[0].latestRevision).toBe(2);

    const detail = (await app.inject({ url: `/packs/${pack.slug}`, headers: as(ADMIN) })).json();
    expect(detail.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);

    const lock: Lockfile = (await app.inject({ url: `/packs/${pack.slug}/revisions/1/lockfile`, headers: as(ADMIN) })).json();
    expect(lock.files.map((f) => f.path)).toEqual(["mods/a.jar", "mods/mine.jar"]);
    expect(lock.files[1]!.downloads).toEqual([blobs.url(hex)]);

    const latest: Lockfile = (await app.inject({ url: `/packs/${pack.slug}/revisions/latest/lockfile`, headers: as(ADMIN) })).json();
    expect(latest.files.map((f) => f.path)).toEqual(["config/a.toml", "mods/a.jar"]);
  });

  it("rejects an invalid remix with 400 and an unknown pack with 404", async () => {
    const pack = (await app.inject({ method: "POST", url: "/packs", headers: as(ADMIN), payload: { name: "p" } })).json();
    const r = await app.inject({ method: "POST", url: `/packs/${pack.id}/revisions`, headers: as(ADMIN), payload: { remix: { schema: 2 } } });
    expect(r.statusCode).toBe(400);
    expect((await app.inject({ url: "/packs/nope", headers: as(ADMIN) })).statusCode).toBe(404);
  });

  it("previews a remix without saving it", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/resolve/preview",
      headers: as(ADMIN),
      payload: { remix: { schema: 1, name: "x", base: { source: "modrinth", versionId: "BASE" }, ops: [{ op: "removeMod", match: { glob: "nothing/*" } }] } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().warnings).toEqual(['removeMod matched nothing: {"glob":"nothing/*"}']);
  });
});
