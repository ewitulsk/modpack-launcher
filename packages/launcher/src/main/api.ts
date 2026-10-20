import { sha256, type Fetcher, type Lockfile, type RemixInput } from "@remix/core";

export interface PackSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  latestRevision: number | null;
  latestVersion: string | null;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface Changes {
  added: string[];
  updated: string[];
  removed: string[];
  downloadBytes: number;
}

export interface RevisionSummary {
  revision: number;
  version?: string;
  changes?: Changes;
  changelog: string;
  warnings: string[];
  minecraft: string;
  loader: Lockfile["loader"];
  fileCount: number;
  blockedCount: number;
  publishedBy?: string;
  createdAt: string;
}

export interface Revision extends RevisionSummary {
  remix: RemixInput;
  client: Lockfile;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's error code, e.g. "pack-key" when a download needs the shared key. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Client for the backend in packages/backend. Browsing needs nothing; every download needs the
 * shared pack key; publishing needs an account.
 */
export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly token = "",
    /** Shared key the server requires on every download (revisions, lockfiles, blobs). */
    private readonly packKey = "",
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const isBytes = body instanceof Uint8Array;
    const base = this.baseUrl.replace(/\/$/, "");
    const res = await this.fetcher(`${base}${path}`, {
      method,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.packKey ? { "X-Pack-Key": this.packKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": isBytes ? "application/octet-stream" : "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : isBytes ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
    }).catch(() => {
      throw new ApiError(0, `Can't reach the pack server at ${base}. Is it running?`);
    });
    if (method === "HEAD") return (res.ok as unknown) as T;
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`, json.code);
    return json;
  }

  register(code: string, username: string, password: string) {
    return this.req<{ token: string; user: Me }>("POST", "/accounts/register", { code, username, password });
  }
  login(username: string, password: string) {
    return this.req<{ token: string; user: Me }>("POST", "/accounts/login", { username, password });
  }
  logout() {
    return this.req<{ ok: boolean }>("POST", "/accounts/logout", {});
  }
  me() {
    return this.req<Me>("GET", "/me");
  }
  packs() {
    return this.req<PackSummary[]>("GET", "/packs");
  }
  pack(id: string) {
    return this.req<PackSummary & { revisions: RevisionSummary[] }>("GET", `/packs/${encodeURIComponent(id)}`);
  }
  revision(id: string, rev: number | "latest") {
    return this.req<Revision>("GET", `/packs/${encodeURIComponent(id)}/revisions/${rev}`);
  }
  /**
   * Throws ApiError with code "pack-key" if the server rejects this client's key. Browsing doesn't
   * check the key, so this asks for a download (the latest lockfile of the first published pack).
   * With nothing published yet there's nothing to check against, and the key is taken as is.
   */
  async checkPackKey() {
    const pack = (await this.packs()).find((p) => p.latestRevision);
    if (pack) await this.req("GET", `/packs/${encodeURIComponent(pack.id)}/revisions/latest/lockfile`);
  }

  // accounts (createInvite: admin only)
  createInvite(note: string) {
    return this.req<{ code: string }>("POST", "/invites", { note });
  }
  createPack(name: string, description: string) {
    return this.req<PackSummary>("POST", "/packs", { name, description });
  }
  preview(remix: unknown) {
    return this.req<{ lockfile: Lockfile; warnings: string[] }>("POST", "/resolve/preview", { remix });
  }
  publish(packId: string, remix: unknown, changelog: string, version?: string) {
    return this.req<RevisionSummary>("POST", `/packs/${encodeURIComponent(packId)}/revisions`, { remix, changelog, version });
  }
  /** Uploads (if the server doesn't already have it) and returns the sha256. */
  async upload(data: Uint8Array): Promise<string> {
    const hex = sha256(data);
    const has = await this.req<boolean>("HEAD", `/blobs/${hex}`);
    if (!has) await this.req("PUT", `/blobs/${hex}`, data);
    return hex;
  }
}
