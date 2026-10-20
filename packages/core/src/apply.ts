import { unzipSync } from "fflate";
import picomatch from "picomatch";
import type { ResolveContext } from "./context.js";
import { blobEntry, normalize, type PackState } from "./packs.js";
import { resolveRef } from "./refs.js";
import type { Env, LockEntry, ModMatch, Op } from "./schema.js";

const SIDE_ENV: Record<"client" | "server", Env> = {
  client: { client: "required", server: "unsupported" },
  server: { client: "unsupported", server: "required" },
};

const blobHex = (ref: string) => ref.slice("sha256:".length);

/** Applies one op to the pack state in place. Ops run in order, so later ops see earlier results. */
export async function applyOp(state: PackState, op: Op, ctx: ResolveContext): Promise<void> {
  switch (op.op) {
    case "addMod": {
      const e = await resolveRef(op.from, ctx, op.path && normalize(op.path));
      if (op.side && op.side !== "both") e.env = SIDE_ENV[op.side];
      state.files.set(e.path, e);
      return;
    }
    case "replaceMod": {
      const removed = await removeMatching(state, op.match, ctx);
      if (removed === 0) ctx.warnings.push(`replaceMod matched nothing: ${JSON.stringify(op.match)}`);
      const e = await resolveRef(op.from, ctx, op.path && normalize(op.path));
      state.files.set(e.path, e);
      return;
    }
    case "removeMod": {
      const removed = await removeMatching(state, op.match, ctx);
      if (removed === 0) ctx.warnings.push(`removeMod matched nothing: ${JSON.stringify(op.match)}`);
      return;
    }
    case "putFile": {
      const env = op.side && op.side !== "both" ? SIDE_ENV[op.side] : undefined;
      const data = await ctx.blobs.get(blobHex(op.blob));
      if (!op.unzip) {
        const path = normalize(op.path);
        if (path.endsWith("/")) throw new Error(`putFile path "${op.path}" is a folder; set unzip or name the file`);
        state.files.set(path, await blobEntry(path, data, ctx, env));
        return;
      }
      const dir = normalize(op.path).replace(/\/?$/, "/");
      for (const [name, bytes] of Object.entries(unzipSync(data))) {
        if (name.endsWith("/")) continue;
        const path = normalize(dir + name);
        state.files.set(path, await blobEntry(path, bytes, ctx, env));
      }
      return;
    }
    case "deletePath": {
      const isMatch = picomatch(op.glob, { dot: true });
      let n = 0;
      for (const path of [...state.files.keys()]) {
        if (isMatch(path)) {
          state.files.delete(path);
          n++;
        }
      }
      if (n === 0) ctx.warnings.push(`deletePath matched nothing: ${op.glob}`);
      return;
    }
    case "addWorld": {
      const path = `saves/${op.name}`;
      const hex = blobHex(op.blob);
      const data = await ctx.blobs.get(hex);
      state.files.set(path, {
        path,
        size: data.byteLength,
        hashes: { sha256: hex },
        downloads: [ctx.blobs.url(hex)],
        origin: { source: "blob" },
        env: SIDE_ENV.client,
        unzip: true,
        installOnce: true,
      });
      return;
    }
  }
}

async function removeMatching(state: PackState, match: ModMatch, ctx: ResolveContext) {
  // Matches accept Modrinth slugs too; origins store project ids.
  const mrId = match.modrinthProject ? (await ctx.modrinth.getProject(match.modrinthProject)).id : undefined;
  const isGlob = match.glob ? picomatch(match.glob, { dot: true }) : undefined;
  const hit = (e: LockEntry) =>
    (mrId === undefined || (e.origin.source === "modrinth" && e.origin.projectId === mrId)) &&
    (match.curseforgeProject === undefined ||
      (e.origin.source === "curseforge" && e.origin.projectId === match.curseforgeProject)) &&
    (isGlob === undefined || isGlob(e.path));

  let n = 0;
  for (const [path, e] of [...state.files]) {
    if (hit(e)) {
      state.files.delete(path);
      n++;
    }
  }
  return n;
}
