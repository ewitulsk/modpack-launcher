/**
 * Imports Minecraft accounts the CurseForge app already signed in.
 *
 * Primary source (modern CurseForge app): the app signs in to Microsoft itself (its own Azure app,
 * the same MS → Xbox → XSTS → Minecraft chain we use) and keeps the account in
 * %APPDATA%\CurseForge\storage.json under "game-user-info", encrypted with cryptr
 * (AES-256-GCM, key = PBKDF2-SHA512 of the Windows user's uid+username). We decrypt it and get a
 * real Microsoft refresh token, so imported accounts keep working indefinitely through the same
 * refresh flow as "Sign in with Microsoft" — using CurseForge's client id, which is already
 * approved for the Minecraft API.
 *
 * Fallback (older CurseForge, or a copied profile): the bundled official Minecraft launcher's
 * launcher_accounts.json, whose Microsoft sign-in sits in the DPAPI-encrypted
 * launcher_msa_credentials.bin next to it — or, failing that, a short-lived Minecraft access
 * token borrowed from the JSON itself.
 */
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Account } from "./microsoft.js";
import type { ImportResult } from "./modrinth-app.js";

const run = promisify(execFile);

/** CurseForge's Azure app, already approved by Mojang for the Minecraft API (PC_LAUNCHER). */
export const CURSEFORGE_CLIENT_ID = "d5b2e079-2c2c-4ade-9dab-1c1eb204162a";
export const CURSEFORGE_SCOPE = "XboxLive.signin XboxLive.offline_access openid";

export function curseforgeAccountFileCandidates(home = homedir()): string[] {
  const installs = [
    join(home, "curseforge", "minecraft", "Install"),
    join(home, "Documents", "Curseforge", "Minecraft", "Install"),
    join(home, "AppData", "Local", "CurseForge", "minecraft", "Install"),
  ];
  return installs.flatMap((d) => [join(d, "launcher_accounts.json"), join(d, "launcher_accounts_microsoft_store.json")]);
}

export function curseforgeStorageCandidates(env = process.env, platform = process.platform, home = homedir()): string[] {
  const dirs =
    platform === "win32"
      ? [...new Set([env.APPDATA, join(home, "AppData", "Roaming")])].filter((d): d is string => Boolean(d))
      : platform === "darwin"
        ? [join(home, "Library", "Application Support")]
        : [...new Set([env.XDG_CONFIG_HOME, join(home, ".config")])].filter((d): d is string => Boolean(d));
  return dirs.map((d) => join(d, "CurseForge", "storage.json"));
}

/** Decrypts a DPAPI blob to UTF-8 text. Injectable so tests don't need Windows. */
export type DpapiDecrypt = (file: string) => Promise<string>;

/** Windows-only: unprotected data is only readable by the same Windows user that ran CurseForge. */
export const decryptMsaCredentials: DpapiDecrypt = async (file) => {
  if (process.platform !== "win32") throw new Error("Windows DPAPI data can't be decrypted on this platform");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    `$b = [IO.File]::ReadAllBytes(${JSON.stringify(file)})`,
    "$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
    "[Console]::Out.Write([Convert]::ToBase64String($d))",
  ].join("\n");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  return Buffer.from(stdout, "base64").toString("utf8");
};

/** The modern app's user store: [uuid, info] pairs with Microsoft OAuth tokens per Minecraft account. */
type CurseforgeUser = {
  oauthTokens?: { refreshToken?: string };
  minecraftToken?: { accessToken?: string; expiresAt?: number };
  username?: string;
};

/**
 * The "cryptr" scheme the CurseForge app uses (platformService.encryptForUser):
 * salt(64) | iv(16) | authTag(16) | ciphertext, AES-256-GCM,
 * key = PBKDF2-SHA512(secret, salt, 100k iterations, 32 bytes) where secret = uid + username
 * from os.userInfo(). Only readable by the same OS user that signed in — same protection level
 * as the official launcher's DPAPI file.
 */
export function decryptCurseforge(blob: Buffer, secret = String(userInfo().uid) + userInfo().username): string {
  const key = pbkdf2Sync(secret, blob.subarray(0, 64), 100_000, 32, "sha512");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(64, 80));
  decipher.setAuthTag(blob.subarray(80, 96));
  return Buffer.concat([decipher.update(blob.subarray(96)), decipher.final()]).toString("utf8");
}

/** Reads the signed-in accounts out of the CurseForge app's storage.json. */
export async function importCurseforgeAppUsers(storagePaths = curseforgeStorageCandidates()): Promise<{ accounts: Account[]; notes: string[] }> {
  const notes: string[] = [];
  const accounts: Account[] = [];
  for (const path of storagePaths) {
    let storage: Record<string, unknown>;
    try {
      storage = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const encoded = storage["game-user-info"];
    if (typeof encoded !== "string" || !encoded) continue;
    notes.push(`Found ${path}`);
    let users: Array<[string, CurseforgeUser]>;
    try {
      // The app stores base64(hex(cryptr(json))).
      users = JSON.parse(decryptCurseforge(Buffer.from(Buffer.from(encoded, "base64").toString("utf8"), "hex")));
    } catch (e) {
      notes.push(`Couldn't decrypt CurseForge's saved sign-in (${(e as Error).message}).`);
      continue;
    }
    for (const [uuid, u] of users ?? []) {
      const id = uuid.replace(/-/g, "");
      const name = u.username;
      const refreshToken = u.oauthTokens?.refreshToken ?? "";
      if (!id || !name || !refreshToken.startsWith("M.")) continue;
      if (accounts.some((a) => a.id === id)) continue;
      const mc = u.minecraftToken;
      const usable = mc?.accessToken?.startsWith("ey") === true;
      accounts.push({
        id,
        name,
        kind: "azure",
        clientId: CURSEFORGE_CLIENT_ID,
        msScope: CURSEFORGE_SCOPE,
        msRefreshToken: refreshToken,
        mcAccessToken: usable ? mc.accessToken! : "",
        mcExpiresAt: usable ? mc.expiresAt ?? 0 : 0,
        source: "curseforge-app",
      });
    }
  }
  return { accounts, notes };
}

interface LauncherAccount {
  accessToken?: string;
  accessTokenExpiresAt?: string;
  minecraftProfile?: { id?: string; name?: string };
  remoteId?: string;
  username?: string;
}

/** The decrypted shape of launcher_msa_credentials.bin. */
interface MsaStore {
  activeUserXuid?: string;
  credentials?: Record<string, Record<string, string>>;
}

/** Per-user Microsoft refresh tokens from the decrypted store, keyed by Xbox user id (xuid). */
function refreshTokensByXuid(store: MsaStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const [user, entries] of Object.entries(store.credentials ?? {})) {
    if (user === "common") continue;
    let foci: string | undefined;
    let userScoped: string | undefined;
    for (const [key, value] of Object.entries(entries)) {
      if (!/^Xal\..*\.Msa\./.test(key)) continue;
      try {
        const token = JSON.parse(value)?.refresh_token;
        if (typeof token !== "string" || !token.startsWith("M.")) continue;
        if (/\.Foci\./.test(key)) foci ??= token;
        else userScoped ??= token;
      } catch {
        // not JSON; ignore
      }
    }
    // The Foci ("family") token is redeemable by any Microsoft client; prefer it.
    const token = foci ?? userScoped;
    if (token) out.set(user, token);
  }
  return out;
}

async function msaRefreshTokens(bin: string, decrypt: DpapiDecrypt, notes: string[]): Promise<Map<string, string>> {
  try {
    await readFile(bin); // fail early (and quietly) if the file doesn't exist
    const store = JSON.parse(await decrypt(bin)) as MsaStore;
    const tokens = refreshTokensByXuid(store);
    // For accounts whose xuid we can't match, the signed-in user's token is the best guess.
    if (store.activeUserXuid && tokens.has(store.activeUserXuid)) tokens.set("__active__", tokens.get(store.activeUserXuid)!);
    return tokens;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return new Map(); // no encrypted sign-in here; fine
    notes.push(`Couldn't read CurseForge's encrypted sign-in (${err.message}); importing tokens only.`);
    return new Map();
  }
}

export interface CurseforgeImportOptions {
  /** launcher_accounts.json candidates (bundled-launcher fallback). */
  accountFiles?: string[];
  /** The CurseForge app's storage.json candidates (primary source). */
  storageFiles?: string[];
  now?: number;
  /** DPAPI decryptor for launcher_msa_credentials.bin; injectable for tests. */
  decrypt?: DpapiDecrypt;
}

export async function importCurseforgeAccounts(opts: CurseforgeImportOptions = {}): Promise<ImportResult> {
  const { accountFiles = curseforgeAccountFileCandidates(), storageFiles = curseforgeStorageCandidates(), now = Date.now(), decrypt = decryptMsaCredentials } = opts;
  const notes: string[] = [];
  const accounts: Account[] = [];

  // Modern app: full Microsoft sign-ins with refresh tokens, straight from storage.json.
  const app = await importCurseforgeAppUsers(storageFiles);
  notes.push(...app.notes);
  accounts.push(...app.accounts);

  // Fallback: the bundled official launcher's files.
  const bins = new Map<string, Map<string, string>>(); // install dir → refresh tokens
  for (const path of accountFiles) {
    let json: { accounts?: Record<string, LauncherAccount> };
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    notes.push(`Found ${path}`);
    const dir = dirname(path);
    if (!bins.has(dir)) bins.set(dir, await msaRefreshTokens(join(dir, "launcher_msa_credentials.bin"), decrypt, notes));
    const refreshTokens = bins.get(dir)!;
    for (const a of Object.values(json.accounts ?? {})) {
      const id = a.minecraftProfile?.id?.replace(/-/g, "");
      const name = a.minecraftProfile?.name;
      if (!id || !name) continue; // signed in to Microsoft but has no Java profile
      if (accounts.some((x) => x.id === id)) continue;
      const refreshToken = (a.remoteId && refreshTokens.get(a.remoteId)) ?? refreshTokens.get("__active__");
      const token = a.accessToken ?? "";
      const expiresAt = Date.parse(a.accessTokenExpiresAt ?? "") || 0;
      if (refreshToken) {
        // A real Microsoft refresh token: this account stays signed in like one we signed in ourselves.
        // Leave the Minecraft token empty when unreadable so it's refreshed on first use.
        const usable = token.startsWith("ey");
        accounts.push({
          id,
          name,
          kind: "live",
          clientId: "00000000402b5328",
          msRefreshToken: refreshToken,
          mcAccessToken: usable ? token : "",
          mcExpiresAt: usable ? expiresAt : 0,
          source: "curseforge-app",
        });
        continue;
      }
      if (!token.startsWith("ey")) {
        notes.push(`CurseForge keeps ${name}'s sign-in encrypted, so it can't be imported. Use "Sign in with Microsoft" instead; you only do it once.`);
        continue;
      }
      if (expiresAt - now < 10 * 60_000) {
        notes.push(`${name}'s CurseForge-bundled sign-in has expired. Modern CurseForge launches Minecraft through its own account instead, so this file may never refresh — sign in here (once) or import from the Modrinth App.`);
        continue;
      }
      accounts.push({
        id,
        name,
        kind: "live",
        clientId: "00000000402b5328",
        msRefreshToken: "",
        mcAccessToken: token,
        mcExpiresAt: expiresAt,
        source: "curseforge-app",
      });
    }
  }
  if (!notes.length) notes.push("CurseForge's Minecraft data not found on this PC.");
  return { accounts, notes };
}
