import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sha1, sha256, type Fetcher, type LockEntry, type Lockfile, ModrinthClient } from "@remix/core";
import { captureChanges } from "../src/main/game/capture.js";
import { exists } from "../src/main/game/files.js";
import { fillBlocked, readState, syncInstance } from "../src/main/game/sync.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const served = new Map<string, Uint8Array>();
const fetcher: Fetcher = async (url) => {
  const b = served.get(url);
  return b ? new Response(b) : new Response("missing", { status: 404 });
};

function entry(path: string, content: string | Uint8Array, extra: Partial<LockEntry> = {}): LockEntry {
  const data = typeof content === "string" ? bytes(content) : content;
  const url = `https://cdn.test/${encodeURIComponent(path)}/${sha1(data)}`;
  served.set(url, data);
  return { path, size: data.byteLength, hashes: { sha1: sha1(data) }, downloads: [url], origin: { source: "blob" }, ...extra };
}

const lock = (files: LockEntry[]): Lockfile => ({
  schema: 1,
  name: "Test",
  minecraft: "1.21.1",
  loader: { type: "fabric", version: "0.16.5" },
  base: { source: "modrinth", versionId: "x" },
  files,
  resolvedAt: "",
});

const tmp = () => mkdtemp(join(tmpdir(), "remix-launcher-"));

describe("syncInstance", () => {
  it("installs, updates, removes managed files, keeps player files and worlds", async () => {
    const dir = await tmp();
    const world = zipSync({ "level.dat": strToU8("v1"), "region/r.0.0.mca": strToU8("r") });
    const v1 = lock([entry("mods/a.jar", "a1"), entry("mods/b.jar", "b1"), entry("saves/Map", world, { unzip: true, installOnce: true, hashes: { sha256: sha256(world) } })]);

    const r1 = await syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 1, lockfile: v1, fetcher });
    expect(r1).toMatchObject({ downloaded: 3, removed: 0 });
    expect(await readFile(join(dir, "saves/Map/level.dat"), "utf8")).toBe("v1");

    // the player plays: world progresses, they add their own mod and options
    await writeFile(join(dir, "saves/Map/level.dat"), "progress");
    await writeFile(join(dir, "options.txt"), "fov:90");
    await writeFile(join(dir, "mods/my-own.jar"), "mine");

    const world2 = zipSync({ "level.dat": strToU8("v2") });
    const v2 = lock([entry("mods/a.jar", "a2"), entry("saves/Map", world2, { unzip: true, installOnce: true, hashes: { sha256: sha256(world2) } })]);
    const r2 = await syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 2, lockfile: v2, fetcher });

    expect(r2).toMatchObject({ downloaded: 1, removed: 1, unchanged: 1 });
    expect(await readFile(join(dir, "mods/a.jar"), "utf8")).toBe("a2");
    expect(await exists(join(dir, "mods/b.jar"))).toBe(false);
    expect(await readFile(join(dir, "mods/my-own.jar"), "utf8")).toBe("mine");
    expect(await readFile(join(dir, "options.txt"), "utf8")).toBe("fov:90");
    expect(await readFile(join(dir, "saves/Map/level.dat"), "utf8")).toBe("progress");
    expect((await readState(dir))?.revision).toBe(2);
  });

  it("rejects a download whose hash doesn't match", async () => {
    const dir = await tmp();
    const e = entry("mods/x.jar", "real");
    served.set(e.downloads[0]!, bytes("tampered"));
    await expect(syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 1, lockfile: lock([e]), fetcher })).rejects.toThrow(/hash mismatch/);
  });

  it("reports blocked files and fills them from Downloads by hash", async () => {
    const dir = await tmp();
    const downloads = await tmp();
    const jar = bytes("blocked jar");
    const blocked: LockEntry = {
      path: "mods/blocked.jar",
      hashes: { sha1: sha1(jar) },
      downloads: [],
      origin: { source: "curseforge", projectId: 1, fileId: 2 },
      blocked: { fileName: "blocked-1.0.jar", pageUrl: "https://www.curseforge.com/x/files/2" },
    };
    const res = await syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 1, lockfile: lock([blocked]), fetcher });
    expect(res.blocked.map((b) => b.path)).toEqual(["mods/blocked.jar"]);

    await writeFile(join(downloads, "blocked-1.0.jar"), jar);
    expect(await fillBlocked(dir, res.blocked, [downloads])).toEqual([]);
    expect(await readFile(join(dir, "mods/blocked.jar"), "utf8")).toBe("blocked jar");

    const again = await syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 1, lockfile: lock([blocked]), fetcher });
    expect(again.blocked).toEqual([]);
  });
});

describe("captureChanges", () => {
  it("turns edits into ops: Modrinth refs for known jars, uploads for the rest, deletes", async () => {
    const dir = await tmp();
    const v1 = lock([entry("mods/a.jar", "a"), entry("mods/gone.jar", "g"), entry("config/a.toml", "x=1")]);
    await syncInstance({ instanceDir: dir, packId: "p", packName: "P", revision: 1, lockfile: v1, fetcher });

    await writeFile(join(dir, "config/a.toml"), "x=2");
    await writeFile(join(dir, "mods/sodium.jar"), "sodium bytes");
    await writeFile(join(dir, "mods/custom.jar"), "custom bytes");
    await mkdir(join(dir, "kubejs/server_scripts"), { recursive: true });
    await writeFile(join(dir, "kubejs/server_scripts/r.js"), "// recipes");
    await writeFile(join(dir, "options.txt"), "ignored");
    await mkdir(join(dir, "logs"));
    await writeFile(join(dir, "logs/latest.log"), "ignored");
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, "mods/gone.jar"));

    const modrinth = new ModrinthClient(async (url, init) => {
      expect(url).toBe("https://api.modrinth.com/v2/version_files");
      const { hashes } = JSON.parse(String(init!.body)) as { hashes: string[] };
      const sodium = sha1(bytes("sodium bytes"));
      return Response.json(hashes.includes(sodium) ? { [sodium]: { id: "SODIUMV1" } } : {});
    });
    const uploaded: string[] = [];
    const { ops, summary } = await captureChanges({
      instanceDir: dir,
      lockfile: v1,
      modrinth,
      upload: async (data, path) => (uploaded.push(path), sha256(data)),
    });

    expect(uploaded.sort()).toEqual(["config/a.toml", "kubejs/server_scripts/r.js", "mods/custom.jar"]);
    expect(ops).toContainEqual({ op: "addMod", from: { source: "modrinth", versionId: "SODIUMV1" }, path: "mods/sodium.jar" });
    expect(ops).toContainEqual({ op: "putFile", path: "config/a.toml", blob: `sha256:${sha256(bytes("x=2"))}` });
    expect(ops).toContainEqual({ op: "deletePath", glob: "mods/gone.jar" });
    expect(summary.find((s) => s.path === "config/a.toml")?.kind).toBe("changed");
    expect(ops).toHaveLength(5);
  });
});
