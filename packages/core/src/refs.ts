import { requireCurseForge, type ResolveContext } from "./context.js";
import type { LockEntry, SourceRef } from "./schema.js";
import { CF_FOLDERS, cfSha1, type CfFile } from "./sources/curseforge.js";
import { toSupport } from "./sources/env.js";
import { MODRINTH_FOLDERS, primaryFile } from "./sources/modrinth.js";

/** Resolves one CurseForge/Modrinth file reference into a lock entry. */
export async function resolveRef(ref: SourceRef, ctx: ResolveContext, path?: string): Promise<LockEntry> {
  if (ref.source === "modrinth") {
    const v = await ctx.modrinth.getVersion(ref.versionId);
    const project = await ctx.modrinth.getProject(v.project_id);
    const f = primaryFile(v);
    return {
      path: path ?? `${MODRINTH_FOLDERS[project.project_type] ?? "mods"}/${f.filename}`,
      size: f.size,
      hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 },
      downloads: [f.url],
      origin: { source: "modrinth", projectId: v.project_id, versionId: v.id },
      env: { client: toSupport(project.client_side), server: toSupport(project.server_side) },
    };
  }
  const cf = requireCurseForge(ctx);
  const file = await cf.getFile(ref.projectId, ref.fileId);
  const [entry] = await curseForgeEntries([file], ctx);
  return path ? { ...entry!, path } : entry!;
}

/**
 * Turns CurseForge files into lock entries in bulk. Files whose author blocks third-party
 * downloads fall back to the identical jar on Modrinth (matched by SHA-1); anything left is
 * marked `blocked` so the launcher can walk the player through a manual download.
 */
export async function curseForgeEntries(files: CfFile[], ctx: ResolveContext): Promise<LockEntry[]> {
  const cf = requireCurseForge(ctx);
  const mods = await cf.getMods(files.map((f) => f.modId));

  const blockedSha1s = files.filter((f) => !f.downloadUrl).flatMap((f) => cfSha1(f) ?? []);
  const onModrinth = blockedSha1s.length ? await ctx.modrinth.versionsBySha1(blockedSha1s).catch(() => ({})) : {};

  return files.map((f): LockEntry => {
    const mod = mods.get(f.modId);
    const sha1 = cfSha1(f);
    const base = {
      path: `${CF_FOLDERS[mod?.classId ?? 6] ?? "mods"}/${f.fileName}`,
      size: f.fileLength,
      hashes: sha1 ? { sha1 } : {},
      origin: { source: "curseforge" as const, projectId: f.modId, fileId: f.id },
    };
    if (f.downloadUrl) return { ...base, downloads: [f.downloadUrl] };

    const mr = sha1 ? (onModrinth as Record<string, { files: { hashes: { sha1: string }; url: string }[] }>)[sha1] : undefined;
    const mrFile = mr?.files.find((x) => x.hashes.sha1 === sha1);
    if (mrFile) return { ...base, downloads: [mrFile.url] };

    const pageUrl = mod ? `${mod.links.websiteUrl}/files/${f.id}` : `https://www.curseforge.com/projects/${f.modId}`;
    ctx.warnings.push(`Blocked on CurseForge, needs manual download: ${mod?.name ?? f.modId} (${f.fileName}) ${pageUrl}`);
    return { ...base, downloads: [], blocked: { fileName: f.fileName, pageUrl } };
  });
}
