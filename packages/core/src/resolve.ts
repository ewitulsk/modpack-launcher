import picomatch from "picomatch";
import { applyOp } from "./apply.js";
import type { BlobStore } from "./blobs.js";
import type { ResolveContext, Side } from "./context.js";
import type { Fetcher } from "./http.js";
import { loadBase } from "./packs.js";
import { Lockfile, Remix, type RemixInput } from "./schema.js";
import type { CurseForgeClient } from "./sources/curseforge.js";
import type { ModrinthClient } from "./sources/modrinth.js";

export interface ResolveOptions {
  blobs: BlobStore;
  modrinth: ModrinthClient;
  curseforge?: CurseForgeClient;
  /** Client lockfile (default) or a server pack. */
  side?: Side;
  fetcher?: Fetcher;
  now?: () => Date;
}

export interface ResolveResult {
  lockfile: Lockfile;
  /** Ops that matched nothing, mods needing manual download, etc. */
  warnings: string[];
}

/** Pinned base + ops → immutable lockfile. Runs on the backend at publish time. */
export async function resolveRemix(input: RemixInput, opts: ResolveOptions): Promise<ResolveResult> {
  const remix = Remix.parse(input);
  const ctx: ResolveContext = {
    blobs: opts.blobs,
    modrinth: opts.modrinth,
    curseforge: opts.curseforge,
    side: opts.side ?? "client",
    warnings: [],
  };

  const state = await loadBase(remix.base, ctx, opts.fetcher);
  for (const op of remix.ops) await applyOp(state, op, ctx);

  const excluded = ctx.side === "server" ? (remix.server?.excludeGlobs ?? []).map((g) => picomatch(g, { dot: true })) : [];
  const files = [...state.files.values()]
    .filter((e) => e.env?.[ctx.side] !== "unsupported")
    .filter((e) => !excluded.some((m) => m(e.path)))
    .sort((a, b) => a.path.localeCompare(b.path));

  const lockfile = Lockfile.parse({
    schema: 1,
    name: remix.name,
    minecraft: remix.minecraftOverride ?? state.minecraft,
    loader: remix.loaderOverride ?? state.loader,
    memoryMb: remix.memoryMb,
    javaArgs: remix.javaArgs,
    base: remix.base,
    files,
    resolvedAt: (opts.now?.() ?? new Date()).toISOString(),
  });
  return { lockfile, warnings: ctx.warnings };
}
