/**
 * Imports Minecraft accounts the CurseForge app already signed in. CurseForge runs a copy of the
 * official Minecraft launcher out of its own folder, so the accounts are in that launcher's
 * launcher_accounts.json. Only the Minecraft access token is readable there (the Microsoft
 * refresh token is in an encrypted .bin), so imported accounts work until that token expires,
 * usually within a day; after that, import again or sign in here.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIVE_CLIENT_ID, type Account } from "./microsoft.js";
import type { ImportResult } from "./modrinth-app.js";

export function curseforgeAccountFileCandidates(home = homedir()): string[] {
  const installs = [join(home, "curseforge", "minecraft", "Install"), join(home, "Documents", "Curseforge", "Minecraft", "Install")];
  return installs.flatMap((d) => [join(d, "launcher_accounts.json"), join(d, "launcher_accounts_microsoft_store.json")]);
}

interface LauncherAccount {
  accessToken?: string;
  accessTokenExpiresAt?: string;
  minecraftProfile?: { id?: string; name?: string };
  username?: string;
}

export async function importCurseforgeAccounts(paths = curseforgeAccountFileCandidates(), now = Date.now()): Promise<ImportResult> {
  const notes: string[] = [];
  const accounts: Account[] = [];
  for (const path of paths) {
    let json: { accounts?: Record<string, LauncherAccount> };
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    notes.push(`Found ${path}`);
    for (const a of Object.values(json.accounts ?? {})) {
      const id = a.minecraftProfile?.id?.replace(/-/g, "");
      const name = a.minecraftProfile?.name;
      if (!id || !name) continue; // signed in to Microsoft but has no Java profile
      const token = a.accessToken ?? "";
      const expiresAt = Date.parse(a.accessTokenExpiresAt ?? "") || 0;
      if (!token.startsWith("ey")) {
        notes.push(`CurseForge keeps ${name}'s sign-in encrypted, so it can't be imported. Use "Sign in with Microsoft" instead; you only do it once.`);
        continue;
      }
      if (expiresAt - now < 10 * 60_000) {
        notes.push(`${name}'s CurseForge sign-in has expired; launch Minecraft from CurseForge once, then import again.`);
        continue;
      }
      if (accounts.some((x) => x.id === id)) continue;
      accounts.push({
        id,
        name,
        kind: "live",
        clientId: LIVE_CLIENT_ID,
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
