import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const toPosix = (p: string) => p.split(sep).join("/");

export async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export async function hashFile(path: string, algorithm: "sha1" | "sha256" | "sha512"): Promise<string> {
  const h = createHash(algorithm);
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** All files under `root`, as forward-slash paths relative to it. */
export async function walk(root: string, skipDir: (rel: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  async function go(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toPosix(relative(root, abs));
      if (e.isDirectory()) {
        if (!skipDir(rel)) await go(abs);
      } else if (e.isFile()) out.push(rel);
    }
  }
  await go(root);
  return out;
}

export const ensureDir = (p: string) => mkdir(p, { recursive: true });

/** Run `fn` over items with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}
