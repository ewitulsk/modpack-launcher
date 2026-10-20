/**
 * Brings an instance folder in line with a lockfile: downloads what changed (verifying
 * hashes), unpacks worlds once, and deletes only files the launcher itself installed.
 */
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { planSync, USER_AGENT, type Fetcher, type LockEntry, type Lockfile } from "@remix/core";
import { createHash } from "node:crypto";
import { ensureDir, exists, hashFile, pool, walk } from "./files.js";

export interface InstanceState {
  packId: string;
  packName: string;
  revision: number;
  lockfile: Lockfile;
  syncedAt: string;
}

export interface SyncProgress {
  phase: "plan" | "download" | "remove" | "done";
  done: number;
  total: number;
  current?: string;
}

export interface SyncResult {
  downloaded: number;
  removed: number;
  unchanged: number;
  /** Still missing: CurseForge files the player must download by hand. */
  blocked: LockEntry[];
}

const STATE = ".remix/state.json";

export async function readState(instanceDir: string): Promise<InstanceState | null> {
  try {
    return JSON.parse(await readFile(join(instanceDir, STATE), "utf8")) as InstanceState;
  } catch {
    return null;
  }
}

async function writeState(instanceDir: string, state: InstanceState) {
  await ensureDir(join(instanceDir, ".remix"));
  await writeFile(join(instanceDir, STATE), JSON.stringify(state, null, 2));
}

function verify(data: Uint8Array, e: LockEntry) {
  for (const algo of ["sha512", "sha256", "sha1"] as const) {
    const want = e.hashes[algo];
    if (want) return createHash(algo).update(data).digest("hex") === want.toLowerCase();
  }
  return true;
}

type HeadersFor = (url: string) => Record<string, string>;

async function fetchEntry(fetcher: Fetcher, e: LockEntry, headersFor: HeadersFor = () => ({})): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const url of e.downloads) {
    try {
      const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, ...headersFor(url) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (!verify(data, e)) throw new Error("hash mismatch");
      return data;
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Couldn't download ${e.path}: ${errors.join("; ") || "no download URLs"}`);
}

/** Where a file lives in the shared download cache, keyed by its strongest hash. */
function cachePath(cacheDir: string, e: LockEntry): string | null {
  for (const algo of ["sha512", "sha256", "sha1"] as const) {
    const hex = e.hashes[algo]?.toLowerCase();
    if (hex) return join(cacheDir, algo, hex.slice(0, 2), hex);
  }
  return null;
}

/**
 * Shared across every pack and version: a mod that's already been downloaded once (for any
 * pack) is copied from the cache instead of downloaded again.
 */
async function getEntry(fetcher: Fetcher, e: LockEntry, headersFor?: HeadersFor, cacheDir?: string): Promise<Uint8Array> {
  const cached = cacheDir ? cachePath(cacheDir, e) : null;
  if (cached) {
    const data = await readFile(cached).then((b) => new Uint8Array(b), () => null);
    if (data && verify(data, e)) return data;
  }
  const data = await fetchEntry(fetcher, e, headersFor);
  if (cached) {
    await ensureDir(dirname(cached));
    await writeFile(`${cached}.tmp`, data).then(() => rename(`${cached}.tmp`, cached)).catch(() => undefined);
  }
  return data;
}

async function writeEntry(instanceDir: string, e: LockEntry, data: Uint8Array) {
  const target = join(instanceDir, e.path);
  if (e.unzip) {
    for (const [name, bytes] of Object.entries(unzipSync(data))) {
      if (name.endsWith("/")) continue;
      const out = join(target, name);
      if (!out.startsWith(target)) continue; // zip-slip guard
      await ensureDir(dirname(out));
      await writeFile(out, bytes);
    }
    return;
  }
  await ensureDir(dirname(target));
  const tmp = `${target}.remix-tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

export async function syncInstance(opts: {
  instanceDir: string;
  packId: string;
  packName: string;
  revision: number;
  lockfile: Lockfile;
  fetcher?: Fetcher;
  /** Extra request headers per download URL (the pack key for our own server). */
  headersFor?: HeadersFor;
  /** Shared download cache folder. Omit to always download. */
  cacheDir?: string;
  concurrency?: number;
  onProgress?: (p: SyncProgress) => void;
}): Promise<SyncResult> {
  const { instanceDir, lockfile } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const report = opts.onProgress ?? (() => {});
  await ensureDir(instanceDir);

  report({ phase: "plan", done: 0, total: 0 });
  const prev = await readState(instanceDir);
  const plan = await planSync(prev?.lockfile ?? null, lockfile, (p) => exists(join(instanceDir, p)));

  // A blocked file may already be in place from an earlier manual download.
  const stillBlocked: LockEntry[] = [];
  for (const e of plan.blocked) {
    const path = join(instanceDir, e.path);
    if (!(await exists(path)) || (e.hashes.sha1 && (await hashFile(path, "sha1")) !== e.hashes.sha1)) stillBlocked.push(e);
  }

  let done = 0;
  report({ phase: "download", done, total: plan.download.length });
  await pool(plan.download, opts.concurrency ?? 8, async (e) => {
    await writeEntry(instanceDir, e, await getEntry(fetcher, e, opts.headersFor, opts.cacheDir));
    report({ phase: "download", done: ++done, total: plan.download.length, current: e.path });
  });

  report({ phase: "remove", done: 0, total: plan.remove.length });
  for (const p of plan.remove) await rm(join(instanceDir, p), { recursive: true, force: true });

  await writeState(instanceDir, {
    packId: opts.packId,
    packName: opts.packName,
    revision: opts.revision,
    lockfile,
    syncedAt: new Date().toISOString(),
  });
  report({ phase: "done", done: plan.download.length, total: plan.download.length });
  return { downloaded: plan.download.length, removed: plan.remove.length, unchanged: plan.unchanged.length, blocked: stillBlocked };
}

/** Where a manually downloaded or already-installed copy of a blocked file might be. */
export function blockedSearchDirs(home = homedir()): string[] {
  return [
    join(home, "Downloads"),
    join(home, "curseforge", "minecraft", "Instances"),
    join(home, "Documents", "Curseforge", "Minecraft", "Instances"),
  ];
}

/**
 * Looks for blocked files (by SHA-1) in Downloads and local CurseForge instances, and copies
 * any it finds into the instance. Returns the entries still missing.
 */
export async function fillBlocked(instanceDir: string, blocked: LockEntry[], searchDirs = blockedSearchDirs()): Promise<LockEntry[]> {
  const want = new Map(blocked.filter((e) => e.hashes.sha1).map((e) => [e.hashes.sha1!, e]));
  const names = new Set(blocked.map((e) => e.blocked?.fileName ?? e.path.split("/").at(-1)));
  for (const dir of searchDirs) {
    if (want.size === 0) break;
    const files = await walk(dir, (rel) => rel.split("/").length > 4);
    for (const rel of files) {
      const base = rel.split("/").at(-1)!;
      if (!names.has(base) && !base.endsWith(".jar")) continue;
      const abs = join(dir, rel);
      const sha1 = await hashFile(abs, "sha1").catch(() => "");
      const e = want.get(sha1);
      if (!e) continue;
      const target = join(instanceDir, e.path);
      await ensureDir(dirname(target));
      await copyFile(abs, target);
      want.delete(sha1);
    }
  }
  return blocked.filter((e) => !e.hashes.sha1 || want.has(e.hashes.sha1));
}
