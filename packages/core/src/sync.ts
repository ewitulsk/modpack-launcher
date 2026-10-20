import type { LockEntry, Lockfile } from "./schema.js";

export interface SyncPlan {
  /** Download (or unzip) these. Excludes blocked files. */
  download: LockEntry[];
  /** CurseForge files the player must fetch by hand (and aren't already present). */
  blocked: LockEntry[];
  /** Paths the launcher previously installed that are no longer in the pack. */
  remove: string[];
  unchanged: LockEntry[];
}

/**
 * Works out what to change on disk when moving an instance from `prev` to `next`.
 * Only files the launcher itself installed (those in `prev`) are ever removed, so a player's
 * own screenshots, options.txt and saves are untouched. `installOnce` entries (worlds) are
 * written only when missing and never removed.
 */
export async function planSync(
  prev: Lockfile | null,
  next: Lockfile,
  exists: (path: string) => Promise<boolean>,
): Promise<SyncPlan> {
  const before = new Map((prev?.files ?? []).map((e) => [e.path, e]));
  const plan: SyncPlan = { download: [], blocked: [], remove: [], unchanged: [] };

  for (const e of next.files) {
    const old = before.get(e.path);
    const present = await exists(e.path);
    const same = present && (e.installOnce || (old !== undefined && sameContent(old, e)));
    if (same) plan.unchanged.push(e);
    else if (e.blocked) plan.blocked.push(e);
    else plan.download.push(e);
  }

  const nextPaths = new Set(next.files.map((e) => e.path));
  for (const e of before.values()) {
    if (!nextPaths.has(e.path) && !e.installOnce) plan.remove.push(e.path);
  }
  return plan;
}

/** Two entries are the same file if any hash they both carry agrees. */
export function sameContent(a: LockEntry, b: LockEntry) {
  for (const k of ["sha512", "sha256", "sha1"] as const) {
    if (a.hashes[k] && b.hashes[k]) return a.hashes[k] === b.hashes[k];
  }
  return false;
}
