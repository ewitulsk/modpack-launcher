import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Remix,
  resolveRemix,
  sameContent,
  sha256,
  type BlobStore,
  type CurseForgeClient,
  type Fetcher,
  type Lockfile,
  type ModrinthClient,
} from "@remix/core";
import { Conflict, type Changes, type Pack, type Store, type User } from "./store.js";

export interface AppDeps {
  store: Store;
  blobs: BlobStore & { has?(hex: string): Promise<boolean> };
  modrinth: ModrinthClient;
  curseforge?: CurseForgeClient;
  /** A bearer token that acts as the admin account, for scripts and first-time setup. */
  adminToken: string;
  /** Username of the admin account the admin token maps to. */
  adminUsername?: string;
  /** Shared key every download request must carry. Unset means downloads are open. Browsing is always open. */
  packKey?: string;
  /** Serve GET /blobs/* from `blobs` (local disk mode). */
  serveBlobs?: boolean;
  fetcher?: Fetcher;
  logger?: boolean;
  maxUploadBytes?: number;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "pack";

const PublishBody = z.object({
  remix: z.unknown(),
  changelog: z.string().default(""),
  /** Optional human name for the version, like "1.2" or "Create update". */
  version: z.string().trim().max(40).optional(),
});
const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{2,24}$/, "Usernames are 2 to 24 letters, numbers, dots, dashes or underscores.");
const Password = z.string().min(4, "Pick a password of at least 4 characters.").max(200);

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    token: string | null;
  }
}

/**
 * Anyone can browse packs. Every download (revision, lockfile, blob) needs the shared pack key,
 * which Evan hands out himself; accounts don't bypass it. Publishing needs an account, and an
 * account needs an invite code.
 */
/** What a player's launcher will fetch or delete when updating from `prev` to `next`. */
export function diffLockfiles(prev: Lockfile, next: Lockfile): Changes {
  const before = new Map(prev.files.map((e) => [e.path, e]));
  const out: Changes = { added: [], updated: [], removed: [], downloadBytes: 0 };
  for (const e of next.files) {
    const old = before.get(e.path);
    if (!old) out.added.push(e.path);
    else if (!e.installOnce && !sameContent(old, e)) out.updated.push(e.path);
    else continue;
    out.downloadBytes += e.size ?? 0;
  }
  const nextPaths = new Set(next.files.map((e) => e.path));
  for (const e of prev.files) if (!nextPaths.has(e.path) && !e.installOnce) out.removed.push(e.path);
  return out;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  const maxUpload = deps.maxUploadBytes ?? 1024 * 1024 * 1024;
  const adminUser = deps.store.ensureAdmin(deps.adminUsername ?? "admin");

  app.decorateRequest("user", null);
  app.decorateRequest("token", null);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: maxUpload }, (_req, body, done) =>
    done(null, body),
  );

  app.addHook("onRequest", async (req) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) return;
    req.token = token;
    req.user = token === deps.adminToken ? adminUser : deps.store.userByToken(token);
  });

  const account = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "Sign in to your account first." });
  };
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "Sign in to your account first." });
    if (!req.user.isAdmin) return reply.code(403).send({ error: "Only the admin can do that." });
  };
  /** The shared pack key, sent as X-Pack-Key (or ?key=) with every download request. */
  const downloader = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.packKey) return;
    const key = req.headers["x-pack-key"] ?? (req.query as { key?: string } | undefined)?.key;
    if (key !== deps.packKey)
      return reply.code(401).send({ error: "This server needs the pack key. Ask Evan for it.", code: "pack-key" });
  };
  const canEdit = (user: User, pack: Pack) => user.isAdmin || pack.ownerId === user.id;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: err.issues[0]?.message ?? "Invalid request", issues: err.issues });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err.message });
  });

  const resolveBoth = async (remix: Remix) => {
    const opts = { blobs: deps.blobs, modrinth: deps.modrinth, curseforge: deps.curseforge, fetcher: deps.fetcher };
    const client = await resolveRemix(remix, { ...opts, side: "client" });
    const server = await resolveRemix(remix, { ...opts, side: "server" });
    return { client: client.lockfile, server: server.lockfile, warnings: client.warnings };
  };

  const findPack = (idOrSlug: string, reply: FastifyReply) => {
    const pack = deps.store.getPack(idOrSlug);
    if (!pack) reply.code(404).send({ error: `No pack ${idOrSlug}` });
    return pack;
  };

  const parseRev = (rev: string) => (rev === "latest" ? "latest" : Number(rev));

  app.get("/health", async () => ({ ok: true, curseforge: Boolean(deps.curseforge), packKey: Boolean(deps.packKey) }));

  // --- accounts ------------------------------------------------------------

  app.post("/accounts/register", async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(1), username: Username, password: Password }).parse(req.body);
    const user = deps.store.register(body.code, body.username, body.password);
    if (user === "bad-invite") return reply.code(404).send({ error: "That invite code is unknown or already used." });
    if (user === "taken") return reply.code(409).send({ error: `The username ${body.username} is taken.` });
    return reply.code(201).send({ token: deps.store.createSession(user.id), user });
  });

  app.post("/accounts/login", async (req, reply) => {
    const body = z.object({ username: z.string().trim().min(1), password: z.string().min(1) }).parse(req.body);
    const out = deps.store.login(body.username, body.password);
    if (!out) return reply.code(401).send({ error: "Wrong username or password." });
    return out;
  });

  app.post("/accounts/logout", async (req) => {
    if (req.token && req.token !== deps.adminToken) deps.store.logout(req.token);
    return { ok: true };
  });

  app.get("/me", { preHandler: account }, async (req) => req.user);

  // --- browse (open) and download (pack key) --------------------------------

  app.get("/packs", async () => deps.store.listPacks());

  app.get<{ Params: { pack: string } }>("/packs/:pack", async (req, reply) => {
    const pack = findPack(req.params.pack, reply);
    if (!pack) return;
    return { ...pack, revisions: deps.store.listRevisions(pack.id) };
  });

  app.get<{ Params: { pack: string; rev: string } }>("/packs/:pack/revisions/:rev", { preHandler: downloader }, async (req, reply) => {
    const pack = findPack(req.params.pack, reply);
    if (!pack) return;
    const rev = parseRev(req.params.rev);
    if (rev !== "latest" && !Number.isInteger(rev)) return reply.code(400).send({ error: "revision must be a number or latest" });
    const r = deps.store.getRevision(pack.id, rev);
    if (!r) return reply.code(404).send({ error: "No such revision" });
    return r;
  });

  app.get<{ Params: { pack: string; rev: string }; Querystring: { side?: string } }>(
    "/packs/:pack/revisions/:rev/lockfile",
    { preHandler: downloader },
    async (req, reply) => {
      const pack = findPack(req.params.pack, reply);
      if (!pack) return;
      const rev = parseRev(req.params.rev);
      if (rev !== "latest" && !Number.isInteger(rev)) return reply.code(400).send({ error: "revision must be a number or latest" });
      const r = deps.store.getRevision(pack.id, rev);
      if (!r) return reply.code(404).send({ error: "No such revision" });
      return req.query.side === "server" ? r.server : r.client;
    },
  );

  if (deps.serveBlobs) {
    app.get<{ Params: { prefix: string; hex: string } }>("/blobs/:prefix/:hex", { preHandler: downloader }, async (req, reply) => {
      try {
        const data = await deps.blobs.get(req.params.hex);
        return reply.type("application/octet-stream").send(Buffer.from(data));
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    });
  }

  // --- accounts: remix and publish -----------------------------------------

  app.post("/packs", { preHandler: account }, async (req, reply) => {
    const body = z
      .object({ name: z.string().trim().min(1), slug: z.string().optional(), description: z.string().default("") })
      .parse(req.body);
    const pack = deps.store.createPack({
      name: body.name,
      slug: slugify(body.slug ?? body.name),
      description: body.description,
      ownerId: req.user!.id,
    });
    return reply.code(201).send(pack);
  });

  /** Dry run: resolve without saving, to see warnings and blocked mods before publishing. */
  app.post("/resolve/preview", { preHandler: account }, async (req) => {
    const remix = Remix.parse((req.body as { remix?: unknown })?.remix ?? req.body);
    const { client, warnings } = await resolveBoth(remix);
    return { lockfile: client, warnings };
  });

  app.post<{ Params: { pack: string } }>("/packs/:pack/revisions", { preHandler: account }, async (req, reply) => {
    const pack = findPack(req.params.pack, reply);
    if (!pack) return;
    if (!canEdit(req.user!, pack))
      return reply.code(403).send({ error: `${pack.name} belongs to ${pack.ownerName}. Make your own pack to publish a remix.` });
    const body = PublishBody.parse(req.body);
    const remix = Remix.parse(body.remix);
    const resolved = await resolveBoth(remix);
    const prev = deps.store.getRevision(pack.id, "latest");
    const { remix: _r, client: _c, server: _s, ...summary } = deps.store.addRevision(pack.id, {
      remix,
      ...resolved,
      changelog: body.changelog,
      version: body.version || undefined,
      changes: prev ? diffLockfiles(prev.client, resolved.client) : undefined,
      publishedBy: req.user!.username,
    });
    return reply.code(201).send(summary);
  });

  app.head<{ Params: { hex: string } }>("/blobs/:hex", { preHandler: account }, async (req, reply) => {
    const has = deps.blobs.has
      ? await deps.blobs.has(req.params.hex)
      : await deps.blobs.get(req.params.hex).then(() => true, () => false);
    return reply.code(has ? 200 : 404).send();
  });

  /** Upload a file by its SHA-256. Idempotent; the hash is checked. */
  app.put<{ Params: { hex: string }; Body: Buffer }>("/blobs/:hex", { preHandler: account }, async (req, reply) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.hex)) return reply.code(400).send({ error: "expected a sha256 hex" });
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "send Content-Type: application/octet-stream" });
    const data = new Uint8Array(req.body);
    if (sha256(data) !== req.params.hex) return reply.code(400).send({ error: "body does not match sha256" });
    await deps.blobs.put(data);
    return { blob: `sha256:${req.params.hex}`, url: deps.blobs.url(req.params.hex) };
  });

  // --- admin ---------------------------------------------------------------

  app.post("/invites", { preHandler: admin }, async (req) => {
    const { note } = z.object({ note: z.string().default("") }).parse(req.body ?? {});
    return deps.store.createInvite(note, req.user!.id);
  });
  app.get("/invites", { preHandler: admin }, async () => deps.store.listInvites());
  app.get("/users", { preHandler: admin }, async () => deps.store.listUsers());

  return app;
}
