import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lockfile, Remix } from "@remix/core";

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface Invite {
  code: string;
  note: string;
  createdBy: string | null;
  redeemedBy: string | null;
  createdAt: string;
}

export interface Pack {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  latestRevision: number | null;
}

export interface RevisionSummary {
  packId: string;
  revision: number;
  changelog: string;
  warnings: string[];
  minecraft: string;
  loader: Lockfile["loader"];
  fileCount: number;
  blockedCount: number;
  publishedBy: string;
  createdAt: string;
}

export interface Revision extends RevisionSummary {
  remix: Remix;
  client: Lockfile;
  server: Lockfile;
}

export interface NewRevision {
  remix: Remix;
  client: Lockfile;
  server: Lockfile;
  changelog: string;
  warnings: string[];
  publishedBy: string;
}

export class Conflict extends Error {}

const newId = () => randomUUID();
const newToken = () => randomBytes(24).toString("base64url");
const newInviteCode = () => randomBytes(5).toString("hex").toUpperCase();
const now = () => new Date().toISOString();

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export function checkPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

const SCHEMA = `
  pragma journal_mode = wal;
  pragma foreign_keys = on;
  create table if not exists users (
    id text primary key,
    username text not null unique collate nocase,
    password_hash text not null,
    is_admin integer not null default 0,
    created_at text not null);
  create table if not exists sessions (
    token text primary key,
    user_id text not null references users(id) on delete cascade,
    created_at text not null);
  create table if not exists invites (
    code text primary key,
    note text not null default '',
    created_by text references users(id),
    redeemed_by text references users(id),
    created_at text not null);
  create table if not exists packs (
    id text primary key,
    slug text not null unique,
    name text not null,
    description text not null default '',
    owner_id text not null references users(id),
    created_at text not null);
  create table if not exists revisions (
    pack_id text not null references packs(id) on delete cascade,
    revision integer not null,
    summary text not null,
    remix text not null,
    client text not null,
    server text not null,
    primary key (pack_id, revision));
`;

type Row = Record<string, unknown>;
const toUser = (r: Row): User => ({
  id: r.id as string,
  username: r.username as string,
  isAdmin: Boolean(r.is_admin),
  createdAt: r.created_at as string,
});
const toInvite = (r: Row): Invite => ({
  code: r.code as string,
  note: r.note as string,
  createdBy: (r.created_by as string | null) ?? null,
  redeemedBy: (r.redeemed_by as string | null) ?? null,
  createdAt: r.created_at as string,
});
const toPack = (r: Row): Pack => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  description: r.description as string,
  ownerId: r.owner_id as string,
  ownerName: r.owner_name as string,
  createdAt: r.created_at as string,
  latestRevision: (r.latest_revision as number | null) ?? null,
});

const PACK_SELECT = `
  select p.*, u.username as owner_name,
    (select max(revision) from revisions r where r.pack_id = p.id) as latest_revision
  from packs p join users u on u.id = p.owner_id`;

/**
 * Everything the API persists, in one SQLite file (node:sqlite, no native modules).
 * Pass ":memory:" for tests.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  // --- accounts ------------------------------------------------------------

  /**
   * Makes sure the admin account exists (it owns packs published with the ADMIN_TOKEN).
   * A password lets the admin sign in from the launcher too; without one the password is left alone.
   */
  ensureAdmin(username: string, password?: string): User {
    const existing = this.db.prepare("select * from users where username = ?").get(username);
    if (existing) {
      if (password) this.db.prepare("update users set password_hash = ? where id = ?").run(hashPassword(password), existing.id as string);
      this.db.prepare("update users set is_admin = 1 where id = ?").run(existing.id as string);
      return { ...toUser(existing), isAdmin: true };
    }
    const r = this.db
      .prepare("insert into users (id, username, password_hash, is_admin, created_at) values (?, ?, ?, 1, ?) returning *")
      .get(newId(), username, hashPassword(password ?? newToken()), now())!;
    return toUser(r);
  }

  createInvite(note: string, createdBy: string | null): Invite {
    const r = this.db
      .prepare("insert into invites (code, note, created_by, created_at) values (?, ?, ?, ?) returning *")
      .get(newInviteCode(), note, createdBy, now())!;
    return toInvite(r);
  }

  listInvites(): Invite[] {
    return this.db.prepare("select * from invites order by created_at desc").all().map(toInvite);
  }

  /** Redeems an invite into a new account. */
  register(code: string, username: string, password: string): User | "bad-invite" | "taken" {
    return this.tx(() => {
      const invite = this.db.prepare("select * from invites where code = ? and redeemed_by is null").get(code.toUpperCase());
      if (!invite) return "bad-invite";
      if (this.db.prepare("select 1 from users where username = ?").get(username)) return "taken";
      const user = this.db
        .prepare("insert into users (id, username, password_hash, is_admin, created_at) values (?, ?, ?, 0, ?) returning *")
        .get(newId(), username, hashPassword(password), now())!;
      this.db.prepare("update invites set redeemed_by = ? where code = ?").run(user.id as string, invite.code as string);
      return toUser(user);
    });
  }

  login(username: string, password: string): { user: User; token: string } | null {
    const r = this.db.prepare("select * from users where username = ?").get(username);
    if (!r || !checkPassword(password, r.password_hash as string)) return null;
    return { user: toUser(r), token: this.createSession(r.id as string) };
  }

  createSession(userId: string) {
    const token = newToken();
    this.db.prepare("insert into sessions (token, user_id, created_at) values (?, ?, ?)").run(token, userId, now());
    return token;
  }

  logout(token: string) {
    this.db.prepare("delete from sessions where token = ?").run(token);
  }

  userByToken(token: string): User | null {
    const r = this.db.prepare("select u.* from sessions s join users u on u.id = s.user_id where s.token = ?").get(token);
    return r ? toUser(r) : null;
  }

  listUsers(): User[] {
    return this.db.prepare("select * from users order by created_at").all().map(toUser);
  }

  // --- packs ---------------------------------------------------------------

  createPack(p: { slug: string; name: string; description: string; ownerId: string }): Pack {
    try {
      this.db
        .prepare("insert into packs (id, slug, name, description, owner_id, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(newId(), p.slug, p.name, p.description, p.ownerId, now());
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) throw new Conflict(`A pack called ${p.slug} already exists`);
      throw e;
    }
    return this.getPack(p.slug)!;
  }

  listPacks(): Pack[] {
    return this.db.prepare(`${PACK_SELECT} order by p.name collate nocase`).all().map(toPack);
  }

  getPack(idOrSlug: string): Pack | null {
    const r = this.db.prepare(`${PACK_SELECT} where p.id = ? or p.slug = ?`).get(idOrSlug, idOrSlug);
    return r ? toPack(r) : null;
  }

  addRevision(packId: string, r: NewRevision): Revision {
    return this.tx(() => {
      const { next } = this.db.prepare("select coalesce(max(revision), 0) + 1 as next from revisions where pack_id = ?").get(packId) as { next: number };
      const summary: RevisionSummary = {
        packId,
        revision: next,
        changelog: r.changelog,
        warnings: r.warnings,
        minecraft: r.client.minecraft,
        loader: r.client.loader,
        fileCount: r.client.files.length,
        blockedCount: r.client.files.filter((f) => f.blocked).length,
        publishedBy: r.publishedBy,
        createdAt: now(),
      };
      this.db
        .prepare("insert into revisions (pack_id, revision, summary, remix, client, server) values (?, ?, ?, ?, ?, ?)")
        .run(packId, next, JSON.stringify(summary), JSON.stringify(r.remix), JSON.stringify(r.client), JSON.stringify(r.server));
      return { ...summary, remix: r.remix, client: r.client, server: r.server };
    });
  }

  getRevision(packId: string, revision: number | "latest"): Revision | null {
    const r =
      revision === "latest"
        ? this.db.prepare("select * from revisions where pack_id = ? order by revision desc limit 1").get(packId)
        : this.db.prepare("select * from revisions where pack_id = ? and revision = ?").get(packId, revision);
    if (!r) return null;
    return {
      ...(JSON.parse(r.summary as string) as RevisionSummary),
      remix: JSON.parse(r.remix as string),
      client: JSON.parse(r.client as string),
      server: JSON.parse(r.server as string),
    };
  }

  listRevisions(packId: string): RevisionSummary[] {
    return this.db
      .prepare("select summary from revisions where pack_id = ? order by revision desc")
      .all(packId)
      .map((r) => JSON.parse(r.summary as string) as RevisionSummary);
  }

  close() {
    this.db.close();
  }
}
