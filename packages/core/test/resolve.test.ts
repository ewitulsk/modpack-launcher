import { describe, expect, it } from "vitest";
import {
  CurseForgeClient,
  MemoryBlobStore,
  ModrinthClient,
  Remix,
  planSync,
  resolveRemix,
  sha256,
  type Lockfile,
  type RemixInput,
} from "../src/index.js";
import { CF, MR, fakeFetch, mrFile, zip } from "./fixtures.js";

const mrpack = zip({
  "modrinth.index.json": JSON.stringify({
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.0.0",
    name: "Cool Pack",
    dependencies: { minecraft: "1.21.1", neoforge: "21.1.77" },
    files: [
      {
        path: "mods/jei.jar",
        hashes: { sha1: "a".repeat(40), sha512: "a".repeat(128) },
        downloads: ["https://cdn.modrinth.com/data/JEIID/versions/V1/jei.jar"],
        fileSize: 10,
      },
      {
        path: "mods/oculus.jar",
        hashes: { sha1: "b".repeat(40), sha512: "b".repeat(128) },
        env: { client: "required", server: "unsupported" },
        downloads: ["https://cdn.modrinth.com/data/OCID/versions/V2/oculus.jar"],
        fileSize: 20,
      },
    ],
  }),
  "overrides/config/jei/jei-client.ini": "a=1",
  "overrides/config/jei/other.ini": "b=2",
  "overrides/options.txt": "fov:70",
  "client-overrides/options.txt": "fov:90",
  "server-overrides/server.properties": "motd=hi",
});

function modrinthRoutes() {
  return {
    [`GET ${MR}/version/PACKV`]: {
      id: "PACKV",
      project_id: "PACK",
      files: [{ ...mrFile("PACK", "PACKV", "cool.mrpack", "c".repeat(40)), url: "https://cdn.modrinth.com/cool.mrpack" }],
    },
    "GET https://cdn.modrinth.com/cool.mrpack": mrpack,
    [`GET ${MR}/project/jei`]: { id: "JEIID", slug: "jei", project_type: "mod", client_side: "required", server_side: "required" },
    [`GET ${MR}/version/SODV`]: { id: "SODV", project_id: "SODID", files: [mrFile("SODID", "SODV", "sodium.jar", "d".repeat(40))] },
    [`GET ${MR}/project/SODID`]: { id: "SODID", slug: "sodium", project_type: "mod", client_side: "required", server_side: "unsupported" },
    [`GET ${MR}/version/SHV`]: { id: "SHV", project_id: "SHID", files: [mrFile("SHID", "SHV", "bsl.zip", "e".repeat(40))] },
    [`GET ${MR}/project/SHID`]: { id: "SHID", slug: "bsl", project_type: "shader", client_side: "required", server_side: "unsupported" },
  };
}

async function setup() {
  const blobs = new MemoryBlobStore();
  const fetcher = fakeFetch(modrinthRoutes());
  const kubejs = await blobs.put(zip({ "server_scripts/recipes.js": "ServerEvents.recipes(e => {})", "startup_scripts/a.js": "//" }));
  const jar = await blobs.put(new TextEncoder().encode("my test build"));
  const world = await blobs.put(zip({ "level.dat": "x" }));
  return { blobs, fetcher, modrinth: new ModrinthClient(fetcher), kubejs, jar, world };
}

describe("resolveRemix with a Modrinth base", () => {
  it("expands the mrpack, applies ops in order, and writes a sorted lockfile", async () => {
    const { blobs, fetcher, modrinth, kubejs, jar, world } = await setup();
    const remix: RemixInput = {
      schema: 1,
      name: "Cool Pack, remixed",
      base: { source: "modrinth", versionId: "PACKV" },
      memoryMb: 6144,
      ops: [
        { op: "removeMod", match: { modrinthProject: "jei" } },
        { op: "addMod", from: { source: "modrinth", versionId: "SODV" } },
        { op: "addMod", from: { source: "modrinth", versionId: "SHV" } },
        { op: "putFile", path: "mods/my-test-build.jar", blob: `sha256:${jar}` },
        { op: "putFile", path: "kubejs", blob: `sha256:${kubejs}`, unzip: true },
        { op: "deletePath", glob: "config/jei/*.ini" },
        { op: "addWorld", name: "Playtest Map", blob: `sha256:${world}` },
      ],
    };

    const { lockfile, warnings } = await resolveRemix(remix, { blobs, modrinth, fetcher, now: () => new Date(0) });

    expect(warnings).toEqual([]);
    expect(lockfile.minecraft).toBe("1.21.1");
    expect(lockfile.loader).toEqual({ type: "neoforge", version: "21.1.77" });
    expect(lockfile.memoryMb).toBe(6144);
    expect(lockfile.files.map((f) => f.path)).toEqual([
      "kubejs/server_scripts/recipes.js",
      "kubejs/startup_scripts/a.js",
      "mods/my-test-build.jar",
      "mods/oculus.jar",
      "mods/sodium.jar",
      "options.txt",
      "saves/Playtest Map",
      "shaderpacks/bsl.zip",
    ]);

    const byPath = Object.fromEntries(lockfile.files.map((f) => [f.path, f]));
    expect(byPath["options.txt"]!.env).toEqual({ client: "required", server: "unsupported" }); // client-overrides won
    expect(byPath["mods/my-test-build.jar"]!.downloads).toEqual([blobs.url(jar)]);
    expect(byPath["mods/sodium.jar"]!.origin).toEqual({ source: "modrinth", projectId: "SODID", versionId: "SODV" });
    expect(byPath["saves/Playtest Map"]).toMatchObject({ unzip: true, installOnce: true, hashes: { sha256: world } });
  });

  it("builds a server pack: drops client-only files, uses server-overrides, applies excludeGlobs", async () => {
    const { blobs, fetcher, modrinth } = await setup();
    const { lockfile } = await resolveRemix(
      {
        schema: 1,
        name: "srv",
        base: { source: "modrinth", versionId: "PACKV" },
        ops: [{ op: "addMod", from: { source: "modrinth", versionId: "SODV" } }],
        server: { excludeGlobs: ["config/jei/**"] },
      },
      { blobs, modrinth, fetcher, side: "server" },
    );
    expect(lockfile.files.map((f) => f.path)).toEqual(["mods/jei.jar", "options.txt", "server.properties"]);
  });

  it("warns when an op matches nothing", async () => {
    const { blobs, fetcher, modrinth } = await setup();
    const { warnings } = await resolveRemix(
      { schema: 1, name: "w", base: { source: "modrinth", versionId: "PACKV" }, ops: [{ op: "deletePath", glob: "nope/**" }] },
      { blobs, modrinth, fetcher },
    );
    expect(warnings).toEqual(["deletePath matched nothing: nope/**"]);
  });
});

describe("resolveRemix with a CurseForge base", () => {
  const cfPack = zip({
    "manifest.json": JSON.stringify({
      name: "CF Pack",
      minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.2.0", primary: true }] },
      files: [
        { projectID: 1, fileID: 11, required: true },
        { projectID: 2, fileID: 22, required: true },
        { projectID: 3, fileID: 33, required: true },
        { projectID: 4, fileID: 44, required: false },
      ],
      overrides: "overrides",
    }),
    "overrides/kubejs/server_scripts/x.js": "//",
  });
  const cfFile = (modId: number, id: number, fileName: string, downloadUrl: string | null, sha1: string) => ({
    id,
    modId,
    fileName,
    fileLength: 5,
    downloadUrl,
    hashes: [{ value: sha1, algo: 1 }],
  });
  const cfMod = (id: number, name: string, classId = 6) => ({
    id,
    name,
    slug: name.toLowerCase(),
    classId,
    links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${name.toLowerCase()}` },
  });

  it("falls back to Modrinth for blocked files and flags the rest for manual download", async () => {
    const fetcher = fakeFetch({
      [`GET ${CF}/v1/mods/900/files/9000`]: { data: cfFile(900, 9000, "pack.zip", "https://edge.forgecdn.net/pack.zip", "0".repeat(40)) },
      "GET https://edge.forgecdn.net/pack.zip": cfPack,
      [`POST ${CF}/v1/mods/files`]: ({ body, headers }: { body: { fileIds: number[] }; headers: Record<string, string> }) => {
        expect(headers["x-api-key"]).toBe("KEY");
        expect(body.fileIds).toEqual([11, 22, 33]); // optional file 44 skipped
        return {
          data: [
            cfFile(1, 11, "allowed.jar", "https://edge.forgecdn.net/allowed.jar", "1".repeat(40)),
            cfFile(2, 22, "onmodrinth.jar", null, "2".repeat(40)),
            cfFile(3, 33, "blocked.jar", null, "3".repeat(40)),
          ],
        };
      },
      [`POST ${CF}/v1/mods`]: { data: [cfMod(1, "Allowed"), cfMod(2, "OnModrinth"), cfMod(3, "Blocked")] },
      [`POST ${MR}/version_files`]: ({ body }: { body: { hashes: string[] } }) => {
        expect(body.hashes).toEqual(["2".repeat(40), "3".repeat(40)]);
        return { ["2".repeat(40)]: { files: [mrFile("P2", "V2", "onmodrinth.jar", "2".repeat(40))] } };
      },
    });

    const { lockfile, warnings } = await resolveRemix(
      { schema: 1, name: "CF remix", base: { source: "curseforge", projectId: 900, fileId: 9000 } },
      { blobs: new MemoryBlobStore(), modrinth: new ModrinthClient(fetcher), curseforge: new CurseForgeClient("KEY", fetcher), fetcher },
    );

    expect(lockfile.loader).toEqual({ type: "forge", version: "47.2.0" });
    const byPath = Object.fromEntries(lockfile.files.map((f) => [f.path, f]));
    expect(byPath["mods/allowed.jar"]!.downloads).toEqual(["https://edge.forgecdn.net/allowed.jar"]);
    expect(byPath["mods/onmodrinth.jar"]!.downloads[0]).toContain("cdn.modrinth.com");
    expect(byPath["mods/onmodrinth.jar"]!.origin).toEqual({ source: "curseforge", projectId: 2, fileId: 22 });
    expect(byPath["mods/blocked.jar"]).toMatchObject({
      downloads: [],
      blocked: { fileName: "blocked.jar", pageUrl: "https://www.curseforge.com/minecraft/mc-mods/blocked/files/33" },
    });
    expect(byPath["kubejs/server_scripts/x.js"]!.origin).toEqual({ source: "blob" });
    expect(warnings).toHaveLength(1);
  });

  it("explains what's missing when no CurseForge key is configured", async () => {
    await expect(
      resolveRemix(
        { schema: 1, name: "x", base: { source: "curseforge", projectId: 1, fileId: 2 } },
        { blobs: new MemoryBlobStore(), modrinth: new ModrinthClient(fakeFetch({})) },
      ),
    ).rejects.toThrow(/CURSEFORGE_API_KEY/);
  });
});

describe("Remix schema", () => {
  it("rejects malformed blob refs and empty matches", () => {
    const base = { schema: 1, name: "x", base: { source: "modrinth", versionId: "v" } };
    expect(Remix.safeParse({ ...base, ops: [{ op: "putFile", path: "a", blob: "sha256:nothex" }] }).success).toBe(false);
    expect(Remix.safeParse({ ...base, ops: [{ op: "removeMod", match: {} }] }).success).toBe(false);
    expect(Remix.parse(base).ops).toEqual([]);
  });
});

describe("planSync", () => {
  const entry = (path: string, sha1: string, extra = {}) => ({ path, hashes: { sha1 }, downloads: [`https://x/${path}`], origin: { source: "blob" as const }, ...extra });
  const lock = (files: ReturnType<typeof entry>[]): Lockfile => ({
    schema: 1,
    name: "p",
    minecraft: "1.21.1",
    loader: null,
    base: { source: "modrinth", versionId: "v" },
    files,
    resolvedAt: "",
  });

  it("downloads changes, removes only files it installed, and leaves worlds alone", async () => {
    const prev = lock([entry("mods/a.jar", "1"), entry("mods/b.jar", "2"), entry("saves/W", "w", { installOnce: true })]);
    const next = lock([
      entry("mods/a.jar", "1"),
      entry("mods/c.jar", "3"),
      entry("mods/blocked.jar", "4", { downloads: [], blocked: { fileName: "blocked.jar", pageUrl: "u" } }),
      entry("saves/W", "w2", { installOnce: true }),
      entry("saves/New", "n", { installOnce: true }),
    ]);
    const onDisk = new Set(["mods/a.jar", "mods/b.jar", "saves/W", "mods/my-own-mod.jar"]);
    const plan = await planSync(prev, next, async (p) => onDisk.has(p));

    expect(plan.unchanged.map((e) => e.path)).toEqual(["mods/a.jar", "saves/W"]);
    expect(plan.download.map((e) => e.path)).toEqual(["mods/c.jar", "saves/New"]);
    expect(plan.blocked.map((e) => e.path)).toEqual(["mods/blocked.jar"]);
    expect(plan.remove).toEqual(["mods/b.jar"]);
  });

  it("redownloads a managed file that went missing", async () => {
    const l = lock([entry("mods/a.jar", "1")]);
    const plan = await planSync(l, l, async () => false);
    expect(plan.download.map((e) => e.path)).toEqual(["mods/a.jar"]);
  });
});

it("MemoryBlobStore is content-addressed", async () => {
  const b = new MemoryBlobStore();
  const data = new TextEncoder().encode("hi");
  expect(await b.put(data)).toBe(sha256(data));
});
