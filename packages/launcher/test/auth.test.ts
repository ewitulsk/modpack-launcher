import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import type { Fetcher } from "@remix/core";
import { AuthError, accountFromMs, ensureFresh, liveAuthorizeUrl, type Account } from "../src/main/auth/microsoft.js";
import { importCurseforgeAccounts } from "../src/main/auth/curseforge-app.js";
import { importModrinthAccounts } from "../src/main/auth/modrinth-app.js";

function chain(opts: { xstsErr?: number; owns?: boolean } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = init?.body ? (String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("login.live.com/oauth20_token")) return Response.json({ access_token: "MS2", refresh_token: "R2", expires_in: 3600 });
    if (url.includes("user.auth.xboxlive.com")) return Response.json({ Token: "XBL", DisplayClaims: { xui: [{ uhs: "UHS" }] } });
    if (url.includes("xsts.auth.xboxlive.com"))
      return opts.xstsErr ? Response.json({ XErr: opts.xstsErr }, { status: 401 }) : Response.json({ Token: "XSTS" });
    if (url.includes("login_with_xbox")) return Response.json({ access_token: "MC", expires_in: 86400 });
    if (url.includes("minecraft/profile"))
      return opts.owns === false ? new Response("", { status: 404 }) : Response.json({ id: "abc123", name: "Evan" });
    return new Response("?", { status: 500 });
  };
  return { fetcher, calls };
}

describe("Microsoft sign-in chain", () => {
  it("walks MS → Xbox → XSTS → Minecraft and returns an account", async () => {
    const { fetcher, calls } = chain();
    const a = await accountFromMs(fetcher, "live", "cid", { access_token: "MS", refresh_token: "R", expires_in: 3600 });
    expect(a).toMatchObject({ id: "abc123", name: "Evan", mcAccessToken: "MC", msRefreshToken: "R", kind: "live" });
    expect((calls[0]!.body as { Properties: { RpsTicket: string } }).Properties.RpsTicket).toBe("MS");
    expect((calls[2]!.body as { identityToken: string }).identityToken).toBe("XBL3.0 x=UHS;XSTS");
  });

  it("prefixes the ticket with d= for our own Azure app", async () => {
    const { fetcher, calls } = chain();
    await accountFromMs(fetcher, "azure", "cid", { access_token: "MS", refresh_token: "R", expires_in: 1 });
    expect((calls[0]!.body as { Properties: { RpsTicket: string } }).Properties.RpsTicket).toBe("d=MS");
  });

  it("explains Xbox and ownership problems", async () => {
    await expect(accountFromMs(chain({ xstsErr: 2148916233 }).fetcher, "live", "c", { access_token: "", refresh_token: "", expires_in: 1 })).rejects.toThrow(/no Xbox profile/);
    await expect(accountFromMs(chain({ owns: false }).fetcher, "live", "c", { access_token: "", refresh_token: "", expires_in: 1 })).rejects.toThrow(AuthError);
  });

  it("refreshes only when the Minecraft token is close to expiring", async () => {
    const base: Account = { id: "abc123", name: "Evan", kind: "live", clientId: "cid", msRefreshToken: "R", mcAccessToken: "OLD", mcExpiresAt: Date.now() + 3_600_000, source: "modrinth-app" };
    const { fetcher, calls } = chain();
    expect(await ensureFresh(fetcher, base)).toBe(base);
    expect(calls).toHaveLength(0);
    const fresh = await ensureFresh(fetcher, { ...base, mcExpiresAt: Date.now() });
    expect(fresh).toMatchObject({ mcAccessToken: "MC", msRefreshToken: "R2", source: "modrinth-app" });
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
  });

  it("builds the login.live.com URL", () => {
    expect(liveAuthorizeUrl()).toContain("client_id=00000000402b5328");
  });
});

describe("Modrinth App import", () => {
  it("reads accounts from a minecraft_users table", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("create table minecraft_users (uuid text, active integer, username text, access_token text, refresh_token text, expires integer)");
    db.run("insert into minecraft_users values ('12345678-1234-1234-1234-123456789abc', 1, 'Evan', 'eyJhbGc.token', 'M.refresh', 1900000000)");
    const dir = await mkdtemp(join(tmpdir(), "mr-app-"));
    const path = join(dir, "app.db");
    await writeFile(path, db.export());

    const r = await importModrinthAccounts([join(dir, "missing.db"), path]);
    expect(r.accounts).toEqual([
      expect.objectContaining({ id: "12345678123412341234123456789abc", name: "Evan", mcAccessToken: "eyJhbGc.token", msRefreshToken: "M.refresh", mcExpiresAt: 1900000000000, source: "modrinth-app" }),
    ]);
  });

  it("says so when the Modrinth App isn't installed", async () => {
    const r = await importModrinthAccounts(["/nope/app.db"]);
    expect(r.accounts).toEqual([]);
    expect(r.notes[0]).toMatch(/not found/);
  });
});

describe("CurseForge import", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  async function launcherAccounts(accounts: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const path = join(dir, "launcher_accounts.json");
    await writeFile(path, JSON.stringify({ accounts, activeAccountLocalId: "a", mojangClientToken: "x" }));
    return path;
  }

  it("reads Java profiles and their Minecraft tokens from the bundled launcher", async () => {
    const path = await launcherAccounts({
      a: { accessToken: "eyJhbGc.cf", accessTokenExpiresAt: "2026-10-20T20:00:00Z", minecraftProfile: { id: "12345678-1234-1234-1234-123456789abc", name: "Evan" }, type: "Xbox" },
      b: { accessToken: "eyJhbGc.old", accessTokenExpiresAt: "2026-10-19T00:00:00Z", minecraftProfile: { id: "ffff", name: "Stale" } },
      c: { accessToken: "eyJhbGc.nojava", accessTokenExpiresAt: "2026-10-21T00:00:00Z", username: "someone@example.com" },
    });
    const r = await importCurseforgeAccounts(["/nope/launcher_accounts.json", path], now);
    expect(r.accounts).toEqual([
      { id: "12345678123412341234123456789abc", name: "Evan", kind: "live", clientId: "00000000402b5328", msRefreshToken: "", mcAccessToken: "eyJhbGc.cf", mcExpiresAt: Date.parse("2026-10-20T20:00:00Z"), source: "curseforge-app" },
    ]);
    expect(r.notes.join(" ")).toMatch(/Stale's CurseForge sign-in has expired/);
  });

  it("asks for a fresh sign-in once an imported token runs out", async () => {
    const a: Account = { id: "x", name: "Evan", kind: "live", clientId: "c", msRefreshToken: "", mcAccessToken: "eyJ", mcExpiresAt: 0, source: "curseforge-app" };
    await expect(ensureFresh(chain().fetcher, a)).rejects.toThrow(/import again/);
  });

  it("says so when CurseForge isn't installed", async () => {
    const r = await importCurseforgeAccounts(["/nope/launcher_accounts.json"]);
    expect(r.accounts).toEqual([]);
    expect(r.notes[0]).toMatch(/not found/);
  });
});
