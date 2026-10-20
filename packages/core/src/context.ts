import type { BlobStore } from "./blobs.js";
import type { CurseForgeClient } from "./sources/curseforge.js";
import type { ModrinthClient } from "./sources/modrinth.js";

export type Side = "client" | "server";

export interface ResolveContext {
  blobs: BlobStore;
  modrinth: ModrinthClient;
  /** Optional until a CurseForge API key is approved; CurseForge refs then fail with a clear error. */
  curseforge?: CurseForgeClient;
  side: Side;
  warnings: string[];
}

export function requireCurseForge(ctx: ResolveContext) {
  if (!ctx.curseforge) {
    throw new Error("This remix references CurseForge, but no CurseForge API key is configured (CURSEFORGE_API_KEY).");
  }
  return ctx.curseforge;
}
