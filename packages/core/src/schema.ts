import { z } from "zod";

/** A specific, immutable file on an upstream platform. */
export const ModrinthRef = z.object({
  source: z.literal("modrinth"),
  versionId: z.string().min(1),
});
export const CurseForgeRef = z.object({
  source: z.literal("curseforge"),
  projectId: z.number().int().positive(),
  fileId: z.number().int().positive(),
});
export const SourceRef = z.discriminatedUnion("source", [ModrinthRef, CurseForgeRef]);
export type SourceRef = z.infer<typeof SourceRef>;

/** "sha256:<hex>" pointer into the blob store (uploaded jars, configs, worlds...). */
export const BlobRef = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex chars>");
export type BlobRef = z.infer<typeof BlobRef>;

/** Picks existing files out of the resolved pack. Every given field must match. */
export const ModMatch = z
  .object({
    modrinthProject: z.string().optional(),
    curseforgeProject: z.number().int().optional(),
    glob: z.string().optional(),
  })
  .refine((m) => m.modrinthProject || m.curseforgeProject || m.glob, "match needs at least one field");
export type ModMatch = z.infer<typeof ModMatch>;

export const LoaderType = z.enum(["forge", "neoforge", "fabric", "quilt"]);
export type LoaderType = z.infer<typeof LoaderType>;

export const Loader = z.object({ type: LoaderType, version: z.string().min(1) });
export type Loader = z.infer<typeof Loader>;

const Side = z.enum(["both", "client", "server"]);

export const Op = z.discriminatedUnion("op", [
  /** Add a file from CurseForge/Modrinth. Folder is picked from the project type unless `path` is given. */
  z.object({ op: z.literal("addMod"), from: SourceRef, path: z.string().optional(), side: Side.optional() }),
  /** Remove whatever `match` selects and add `from` in its place. */
  z.object({ op: z.literal("replaceMod"), match: ModMatch, from: SourceRef, path: z.string().optional() }),
  z.object({ op: z.literal("removeMod"), match: ModMatch }),
  /**
   * Put an uploaded blob at `path`. With `unzip`, the blob is a zip whose entries land under
   * `path` (a folder), e.g. a whole config/ or kubejs/ tree.
   */
  z.object({
    op: z.literal("putFile"),
    path: z.string().min(1),
    blob: BlobRef,
    unzip: z.boolean().optional(),
    side: Side.optional(),
  }),
  /** Delete every resolved file whose path matches the glob. */
  z.object({ op: z.literal("deletePath"), glob: z.string().min(1) }),
  /** A zipped world, unpacked into saves/<name> the first time only so players keep progress. */
  z.object({ op: z.literal("addWorld"), name: z.string().min(1), blob: BlobRef }),
]);
export type Op = z.infer<typeof Op>;

export const Remix = z.object({
  schema: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  base: SourceRef,
  loaderOverride: Loader.optional(),
  minecraftOverride: z.string().optional(),
  memoryMb: z.number().int().positive().optional(),
  javaArgs: z.array(z.string()).optional(),
  ops: z.array(Op).default([]),
  server: z.object({ excludeGlobs: z.array(z.string()).default([]) }).optional(),
});
export type Remix = z.infer<typeof Remix>;
export type RemixInput = z.input<typeof Remix>;

// ---------------------------------------------------------------------------
// Lockfile: the fully resolved file list a launcher syncs. Never contains ops.
// ---------------------------------------------------------------------------

export const EnvSupport = z.enum(["required", "optional", "unsupported"]);
export const Env = z.object({ client: EnvSupport, server: EnvSupport });
export type Env = z.infer<typeof Env>;

export const Origin = z.discriminatedUnion("source", [
  z.object({ source: z.literal("modrinth"), projectId: z.string(), versionId: z.string() }),
  z.object({ source: z.literal("curseforge"), projectId: z.number(), fileId: z.number() }),
  /** Something we host (uploads, pack overrides). */
  z.object({ source: z.literal("blob") }),
  /** A third-party URL listed in an .mrpack (e.g. GitHub releases). */
  z.object({ source: z.literal("url") }),
]);
export type Origin = z.infer<typeof Origin>;

export const LockEntry = z.object({
  /** Forward-slash path relative to the instance (.minecraft) folder. */
  path: z.string(),
  size: z.number().int().nonnegative().optional(),
  hashes: z.object({ sha1: z.string().optional(), sha256: z.string().optional(), sha512: z.string().optional() }),
  /** Mirrors to try in order. Empty only when `blocked` is set. */
  downloads: z.array(z.string()),
  origin: Origin,
  env: Env.optional(),
  /** Zip to unpack into `path` (a folder). */
  unzip: z.boolean().optional(),
  /** Only written if absent; never overwritten or deleted by sync (worlds). */
  installOnce: z.boolean().optional(),
  /** CurseForge author disallows third-party downloads; the launcher must guide a manual download. */
  blocked: z.object({ fileName: z.string(), pageUrl: z.string() }).optional(),
});
export type LockEntry = z.infer<typeof LockEntry>;

export const Lockfile = z.object({
  schema: z.literal(1),
  name: z.string(),
  minecraft: z.string(),
  loader: Loader.nullable(),
  memoryMb: z.number().int().positive().optional(),
  javaArgs: z.array(z.string()).optional(),
  base: SourceRef,
  files: z.array(LockEntry),
  resolvedAt: z.string(),
});
export type Lockfile = z.infer<typeof Lockfile>;
