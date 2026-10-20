/**
 * "Capture changes": diff an instance folder you've hand-edited against the lockfile it was
 * installed from, and turn the differences into remix ops. New jars that exist on Modrinth
 * become addMod refs (no upload); everything else is uploaded as a blob.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import { sha1 as sha1Of, type LockEntry, type Lockfile, type ModrinthClient, type Op } from "@remix/core";
import { walk } from "./files.js";

/** Player-owned or generated stuff that shouldn't end up in a pack. Editable in settings. */
export const DEFAULT_CAPTURE_IGNORE = [
  ".remix/**",
  "logs/**",
  "crash-reports/**",
  "screenshots/**",
  "saves/**",
  "backups/**",
  ".mixin.out/**",
  ".cache/**",
  "journeymap/data/**",
  "options.txt",
  "optionsof.txt",
  "optionsshaders.txt",
  "servers.dat",
  "servers.dat_old",
  "usercache.json",
  "usernamecache.json",
  "realms_persistence.json",
  "command_history.txt",
  "launcher_profiles.json",
  "**/*.log",
  "**/*.remix-tmp",
];

export interface CaptureResult {
  ops: Op[];
  /** Human-readable list of what changed, for review before publishing. */
  summary: { kind: "added" | "changed" | "deleted"; path: string; how: string }[];
}

const escapeGlob = (p: string) => p.replace(/[\\*?[\]{}()!+@]/g, (c) => `\\${c}`);

function sameHash(e: LockEntry, sha1: string) {
  return e.hashes.sha1 ? e.hashes.sha1 === sha1 : false;
}

export async function captureChanges(opts: {
  instanceDir: string;
  lockfile: Lockfile;
  modrinth: ModrinthClient;
  /** Uploads bytes and returns their sha256 hex. */
  upload: (data: Uint8Array, path: string) => Promise<string>;
  ignore?: string[];
}): Promise<CaptureResult> {
  const ignored = picomatch(opts.ignore ?? DEFAULT_CAPTURE_IGNORE, { dot: true });
  const managed = new Map(opts.lockfile.files.filter((e) => !e.unzip).map((e) => [e.path, e]));
  const unzipRoots = opts.lockfile.files.filter((e) => e.unzip).map((e) => `${e.path}/`);

  const files = (await walk(opts.instanceDir)).filter((p) => !ignored(p) && !unzipRoots.some((r) => p.startsWith(r)));
  const present = new Set(files);

  const changed: { path: string; data: Uint8Array; sha1: string; existed: boolean }[] = [];
  for (const path of files) {
    const data = new Uint8Array(await readFile(join(opts.instanceDir, path)));
    const sha1 = sha1Of(data);
    const old = managed.get(path);
    if (old && (sameHash(old, sha1) || (!old.hashes.sha1 && old.size === data.byteLength))) continue;
    changed.push({ path, data, sha1, existed: Boolean(old) });
  }

  // New jars that Modrinth has: reference them instead of uploading.
  const jars = changed.filter((c) => /^mods\/[^/]+\.jar$/.test(c.path));
  const known = jars.length ? await opts.modrinth.versionsBySha1(jars.map((j) => j.sha1)).catch(() => ({})) : {};

  const ops: Op[] = [];
  const summary: CaptureResult["summary"] = [];
  for (const c of changed) {
    const mr = (known as Record<string, { id: string }>)[c.sha1];
    if (mr) {
      ops.push({ op: "addMod", from: { source: "modrinth", versionId: mr.id }, path: c.path });
      summary.push({ kind: c.existed ? "changed" : "added", path: c.path, how: "from Modrinth" });
    } else {
      const hex = await opts.upload(c.data, c.path);
      ops.push({ op: "putFile", path: c.path, blob: `sha256:${hex}` });
      summary.push({ kind: c.existed ? "changed" : "added", path: c.path, how: "uploaded" });
    }
  }
  for (const path of managed.keys()) {
    if (!present.has(path) && !ignored(path)) {
      ops.push({ op: "deletePath", glob: escapeGlob(path) });
      summary.push({ kind: "deleted", path, how: "removed" });
    }
  }
  return { ops, summary };
}
