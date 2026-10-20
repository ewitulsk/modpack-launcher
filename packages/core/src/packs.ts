import { strFromU8, unzipSync } from "fflate";
import { requireCurseForge, type ResolveContext } from "./context.js";
import { sha1 } from "./hash.js";
import { getBytes, type Fetcher } from "./http.js";
import { curseForgeEntries } from "./refs.js";
import type { Env, LockEntry, Loader, LoaderType, SourceRef } from "./schema.js";
import { toSupport } from "./sources/env.js";
import { primaryFile } from "./sources/modrinth.js";

/** The working state ops are applied to: one entry per instance path. */
export interface PackState {
  name: string;
  minecraft: string;
  loader: Loader | null;
  files: Map<string, LockEntry>;
}

const CLIENT_ONLY: Env = { client: "required", server: "unsupported" };
const SERVER_ONLY: Env = { client: "unsupported", server: "required" };

/** Downloads the pinned upstream pack and expands it into a PackState. */
export async function loadBase(ref: SourceRef, ctx: ResolveContext, fetcher: Fetcher = fetch): Promise<PackState> {
  if (ref.source === "modrinth") {
    const v = await ctx.modrinth.getVersion(ref.versionId);
    const file = v.files.find((f) => f.filename.endsWith(".mrpack")) ?? primaryFile(v);
    return parseMrpack(await getBytes(fetcher, file.url), ctx);
  }
  const cf = requireCurseForge(ctx);
  const file = await cf.getFile(ref.projectId, ref.fileId);
  if (!file.downloadUrl) {
    throw new Error(`CurseForge pack file ${ref.fileId} does not allow third-party downloads.`);
  }
  return parseCurseForgeZip(await getBytes(fetcher, file.downloadUrl), ctx);
}

interface MrIndex {
  formatVersion: number;
  name: string;
  files: { path: string; hashes: { sha1: string; sha512: string }; env?: { client: string; server: string }; downloads: string[]; fileSize: number }[];
  dependencies: Record<string, string>;
}

const MR_LOADERS: Record<string, LoaderType> = {
  forge: "forge",
  neoforge: "neoforge",
  "fabric-loader": "fabric",
  "quilt-loader": "quilt",
};

export async function parseMrpack(zipBytes: Uint8Array, ctx: ResolveContext): Promise<PackState> {
  const zip = unzipSync(zipBytes);
  const raw = zip["modrinth.index.json"];
  if (!raw) throw new Error("Not an .mrpack: modrinth.index.json missing");
  const index = JSON.parse(strFromU8(raw)) as MrIndex;

  const files = new Map<string, LockEntry>();
  for (const f of index.files) {
    files.set(normalize(f.path), {
      path: normalize(f.path),
      size: f.fileSize,
      hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 },
      downloads: f.downloads,
      origin: modrinthOrigin(f.downloads[0]),
      env: f.env ? { client: toSupport(f.env.client), server: toSupport(f.env.server) } : undefined,
    });
  }

  // overrides/ applies to both sides; the side-specific folder is applied after it and wins.
  await addOverrides(zip, "overrides/", files, ctx, undefined);
  if (ctx.side === "client") await addOverrides(zip, "client-overrides/", files, ctx, CLIENT_ONLY);
  else await addOverrides(zip, "server-overrides/", files, ctx, SERVER_ONLY);

  const loaderKey = Object.keys(index.dependencies).find((k) => k in MR_LOADERS);
  return {
    name: index.name,
    minecraft: index.dependencies.minecraft ?? "",
    loader: loaderKey ? { type: MR_LOADERS[loaderKey]!, version: index.dependencies[loaderKey]! } : null,
    files,
  };
}

interface CfManifest {
  name: string;
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] };
  files: { projectID: number; fileID: number; required?: boolean }[];
  overrides?: string;
}

export async function parseCurseForgeZip(zipBytes: Uint8Array, ctx: ResolveContext): Promise<PackState> {
  const zip = unzipSync(zipBytes);
  const raw = zip["manifest.json"];
  if (!raw) throw new Error("Not a CurseForge pack: manifest.json missing");
  const manifest = JSON.parse(strFromU8(raw)) as CfManifest;

  const cf = requireCurseForge(ctx);
  const wanted = manifest.files.filter((f) => f.required !== false);
  const cfFiles = await cf.getFiles(wanted.map((f) => f.fileID));
  const files = new Map<string, LockEntry>();
  for (const e of await curseForgeEntries(cfFiles, ctx)) files.set(e.path, e);

  await addOverrides(zip, `${manifest.overrides ?? "overrides"}/`, files, ctx, undefined);

  const primary = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];
  return {
    name: manifest.name,
    minecraft: manifest.minecraft.version,
    loader: primary ? parseCfLoader(primary.id) : null,
    files,
  };
}

/** "forge-47.2.0" → forge 47.2.0, "neoforge-21.1.77" → neoforge 21.1.77. */
export function parseCfLoader(id: string): Loader | null {
  const dash = id.indexOf("-");
  if (dash < 0) return null;
  const type = id.slice(0, dash) as LoaderType;
  if (!["forge", "neoforge", "fabric", "quilt"].includes(type)) return null;
  return { type, version: id.slice(dash + 1) };
}

async function addOverrides(
  zip: Record<string, Uint8Array>,
  prefix: string,
  files: Map<string, LockEntry>,
  ctx: ResolveContext,
  env: Env | undefined,
) {
  for (const [name, data] of Object.entries(zip)) {
    if (!name.startsWith(prefix) || name.endsWith("/")) continue;
    const path = normalize(name.slice(prefix.length));
    if (!path) continue;
    files.set(path, await blobEntry(path, data, ctx, env));
  }
}

/** Stores bytes in the blob store and returns an entry pointing at them. */
export async function blobEntry(path: string, data: Uint8Array, ctx: ResolveContext, env?: Env): Promise<LockEntry> {
  const hex = await ctx.blobs.put(data);
  return {
    path,
    size: data.byteLength,
    hashes: { sha1: sha1(data), sha256: hex },
    downloads: [ctx.blobs.url(hex)],
    origin: { source: "blob" },
    ...(env ? { env } : {}),
  };
}

/** cdn.modrinth.com/data/<project>/versions/<version>/<file> → ids, so removeMod can match pack files. */
function modrinthOrigin(url: string | undefined): LockEntry["origin"] {
  const m = url?.match(/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//);
  return m ? { source: "modrinth", projectId: m[1]!, versionId: m[2]! } : { source: "url" };
}

export function normalize(p: string) {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}
