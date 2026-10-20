import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const { tmpdir } = os;
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
    if (url.includes("login.live.com/oauth20_token") || url.includes("login.microsoftonline.com/consumers/oauth2/v2.0/token"))
      return Response.json({ access_token: "MS2", refresh_token: "R2", expires_in: 3600 });
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

  /** Mirrors the CurseForge app's cryptr encryption so fixtures round-trip decryptCurseforge(). */
  function encryptForUser(text: string, secret = String(os.userInfo().uid) + os.userInfo().username): string {
    const salt = randomBytes(64);
    const iv = randomBytes(16);
    const key = pbkdf2Sync(secret, salt, 100_000, 32, "sha512");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.from(Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("hex")).toString("base64");
  }

  it("reads Java profiles and their Minecraft tokens from the bundled launcher", async () => {
    const path = await launcherAccounts({
      a: { accessToken: "eyJhbGc.cf", accessTokenExpiresAt: "2026-10-20T20:00:00Z", minecraftProfile: { id: "12345678-1234-1234-1234-123456789abc", name: "Evan" }, type: "Xbox" },
      b: { accessToken: "eyJhbGc.old", accessTokenExpiresAt: "2026-10-19T00:00:00Z", minecraftProfile: { id: "ffff", name: "Stale" } },
      c: { accessToken: "eyJhbGc.nojava", accessTokenExpiresAt: "2026-10-21T00:00:00Z", username: "someone@example.com" },
    });
    const r = await importCurseforgeAccounts({ accountFiles: ["/nope/launcher_accounts.json", path], storageFiles: ["/nope/storage.json"], now });
    expect(r.accounts).toEqual([
      { id: "12345678123412341234123456789abc", name: "Evan", kind: "live", clientId: "00000000402b5328", msRefreshToken: "", mcAccessToken: "eyJhbGc.cf", mcExpiresAt: Date.parse("2026-10-20T20:00:00Z"), source: "curseforge-app" },
    ]);
    expect(r.notes.join(" ")).toMatch(/Stale's CurseForge-bundled sign-in has expired/);
  });

  it("imports the app's saved Microsoft sign-in from storage.json with its own client id and scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const path = join(dir, "storage.json");
    const users = [
      [
        "8055428104f844c69952fc986e7fedf4",
        {
          oauthTokens: { refreshToken: "M.C540_BL2.0.U.MsaArtifacts.fake", accessToken: "EwAI", idToken: "eyJid" },
          minecraftToken: { accessToken: "eyJraWQiOiJhbGciOi", expiresAt: 1792540141961 },
          username: "greenpeppers100",
        },
      ],
      ["ffffffffffffffffffffffffffffffff", { oauthTokens: {}, username: "NoToken" }], // no refresh token: skipped
    ];
    await writeFile(path, JSON.stringify({ "game-user-info": encryptForUser(JSON.stringify(users)) }));
    const r = await importCurseforgeAccounts({ accountFiles: ["/nope/launcher_accounts.json"], storageFiles: [path], now });
    expect(r.accounts).toEqual([
      {
        id: "8055428104f844c69952fc986e7fedf4",
        name: "greenpeppers100",
        kind: "azure",
        clientId: "d5b2e079-2c2c-4ade-9dab-1c1eb204162a",
        msScope: "XboxLive.signin XboxLive.offline_access openid",
        msRefreshToken: "M.C540_BL2.0.U.MsaArtifacts.fake",
        mcAccessToken: "eyJraWQiOiJhbGciOi",
        mcExpiresAt: 1792540141961,
        source: "curseforge-app",
      },
    ]);
  });

  it("notes a storage.json it can't decrypt, and falls back to the bundled launcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const storagePath = join(dir, "storage.json");
    await writeFile(storagePath, JSON.stringify({ "game-user-info": Buffer.from("nonsense").toString("base64") }));
    const path = await launcherAccounts({ a: { accessToken: "eyJhbGc.cf", accessTokenExpiresAt: "2026-10-20T20:00:00Z", minecraftProfile: { id: "abc", name: "Evan" } } });
    const r = await importCurseforgeAccounts({ accountFiles: [path], storageFiles: [storagePath], now });
    expect(r.notes.join(" ")).toMatch(/Couldn't decrypt CurseForge's saved sign-in/);
    expect(r.accounts[0]).toMatchObject({ name: "Evan", msRefreshToken: "" });
  });

  it("imports the Microsoft refresh token from the encrypted sign-in, matching by xuid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const path = join(dir, "launcher_accounts.json");
    await writeFile(path, JSON.stringify({ accounts: { a: { accessToken: "", accessTokenExpiresAt: "2026-04-22T04:34:54Z", minecraftProfile: { id: "8055428104f844c69952fc986e7fedf4", name: "greenpeppers100" }, remoteId: "2533274946838549", type: "Xbox" } } }));
    await writeFile(join(dir, "launcher_msa_credentials.bin"), "dpapi-bytes");
    const decrypt = async (file: string) => {
      expect(file).toBe(join(dir, "launcher_msa_credentials.bin"));
      return JSON.stringify({
        activeUserXuid: "2533274946838549",
        credentials: {
          "2533274946838549": {
            "Xal.1794566092.Production.Msa.Y2Rl": '{"refresh_token":"M.C540_USER"}',
            "Xal.Production.Msa.Foci.1": '{"refresh_token":"M.C540_FOCI"}',
            "Xal.Production.RETAIL.D": '{"token":{}}',
          },
        },
      });
    };
    const r = await importCurseforgeAccounts({ accountFiles: [path], storageFiles: ["/nope/storage.json"], now, decrypt });
    expect(r.accounts).toEqual([
      { id: "8055428104f844c69952fc986e7fedf4", name: "greenpeppers100", kind: "live", clientId: "00000000402b5328", msRefreshToken: "M.C540_FOCI", mcAccessToken: "", mcExpiresAt: 0, source: "curseforge-app" },
    ]);
  });

  it("falls back to the active user's refresh token when the account has no xuid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const path = join(dir, "launcher_accounts.json");
    await writeFile(path, JSON.stringify({ accounts: { a: { accessToken: "", minecraftProfile: { id: "aaa", name: "Evan" } } } }));
    await writeFile(join(dir, "launcher_msa_credentials.bin"), "dpapi-bytes");
    const decrypt = async () => JSON.stringify({ activeUserXuid: "42", credentials: { "42": { "Xal.Production.Msa.Foci.1": '{"refresh_token":"M.C540_FOCI"}' } } });
    const r = await importCurseforgeAccounts({ accountFiles: [path], storageFiles: ["/nope/storage.json"], now, decrypt });
    expect(r.accounts[0]).toMatchObject({ msRefreshToken: "M.C540_FOCI", mcAccessToken: "", mcExpiresAt: 0 });
  });

  it("says so when the encrypted sign-in can't be read, and still imports tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-app-"));
    const path = join(dir, "launcher_accounts.json");
    await writeFile(path, JSON.stringify({ accounts: { a: { accessToken: "eyJhbGc.cf", accessTokenExpiresAt: "2026-10-20T20:00:00Z", minecraftProfile: { id: "abc", name: "Evan" } } } }));
    await writeFile(join(dir, "launcher_msa_credentials.bin"), "dpapi-bytes");
    const decrypt = async () => {
      throw new Error("DPAPI failed");
    };
    const r = await importCurseforgeAccounts({ accountFiles: [path], storageFiles: ["/nope/storage.json"], now, decrypt });
    expect(r.notes.join(" ")).toMatch(/Couldn't read CurseForge's encrypted sign-in/);
    expect(r.accounts[0]).toMatchObject({ msRefreshToken: "", mcAccessToken: "eyJhbGc.cf" });
  });

  it("asks for a fresh sign-in once an imported token runs out", async () => {
    const a: Account = { id: "x", name: "Evan", kind: "live", clientId: "c", msRefreshToken: "", mcAccessToken: "eyJ", mcExpiresAt: 0, source: "curseforge-app" };
    await expect(ensureFresh(chain().fetcher, a)).rejects.toThrow(/import from the Modrinth App/);
  });

  it("refreshes a CurseForge-app account with CurseForge's client id and scope", async () => {
    const a: Account = {
      id: "x", name: "Evan", kind: "azure", clientId: "d5b2e079-2c2c-4ade-9dab-1c1eb204162a",
      msScope: "XboxLive.signin XboxLive.offline_access openid",
      msRefreshToken: "M.C540", mcAccessToken: "", mcExpiresAt: 0, source: "curseforge-app",
    };
    const { fetcher, calls } = chain();
    const fresh = await ensureFresh(fetcher, a);
    expect(fresh).toMatchObject({ mcAccessToken: "MC", source: "curseforge-app" });
    const refresh = calls[0]!.body as string;
    expect(refresh).toContain("client_id=d5b2e079-2c2c-4ade-9dab-1c1eb204162a");
    expect(refresh).toContain("scope=XboxLive.signin+XboxLive.offline_access+openid");
    expect((calls[1]!.body as { Properties: { RpsTicket: string } }).Properties.RpsTicket).toMatch(/^d=/);
  });

  it("says so when CurseForge isn't installed", async () => {
    const r = await importCurseforgeAccounts({ accountFiles: ["/nope/launcher_accounts.json"], storageFiles: ["/nope/storage.json"] });
    expect(r.accounts).toEqual([]);
    expect(r.notes[0]).toMatch(/not found/);
  });
});
