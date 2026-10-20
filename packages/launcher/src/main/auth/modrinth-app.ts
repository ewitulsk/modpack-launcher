/**
 * Imports Minecraft accounts the Modrinth App already signed in, from its SQLite database.
 * The schema is undocumented and has changed between releases, so columns are discovered
 * by name instead of hard-coded, and any failure just means "nothing to import".
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { LIVE_CLIENT_ID, type Account } from "./microsoft.js";

export function modrinthAppDbCandidates(env = process.env, platform = process.platform): string[] {
  const home = homedir();
  const roots =
    platform === "win32"
      ? [env.APPDATA ?? join(home, "AppData", "Roaming")]
      : platform === "darwin"
        ? [join(home, "Library", "Application Support")]
        : [env.XDG_DATA_HOME ?? join(home, ".local", "share"), env.XDG_CONFIG_HOME ?? join(home, ".config")];
  return roots.flatMap((r) => [join(r, "ModrinthApp", "app.db"), join(r, "com.modrinth.theseus", "app.db")]);
}

export interface ImportResult {
  accounts: Account[];
  /** Human-readable notes on what was found, for the UI and debugging. */
  notes: string[];
}

const pick = (cols: string[], ...names: RegExp[]) => names.map((n) => cols.find((c) => n.test(c))).find(Boolean);

export async function importModrinthAccounts(paths = modrinthAppDbCandidates()): Promise<ImportResult> {
  const notes: string[] = [];
  const accounts: Account[] = [];
  const SQL = await initSqlJs();
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      continue;
    }
    notes.push(`Found ${path}`);
    const db = new SQL.Database(bytes);
    try {
      const tables = db.exec("select name from sqlite_master where type = 'table'")[0]?.values.map((v) => String(v[0])) ?? [];
      const table = tables.find((t) => /minecraft.*users?/i.test(t)) ?? tables.find((t) => /users?/i.test(t));
      if (!table) {
        notes.push(`No accounts table among: ${tables.join(", ")}`);
        continue;
      }
      const result = db.exec(`select * from "${table.replace(/"/g, "")}"`)[0];
      if (!result) {
        notes.push(`${table} is empty`);
        continue;
      }
      const cols = result.columns;
      const c = {
        id: pick(cols, /^uuid$/i, /^id$/i, /uuid/i),
        name: pick(cols, /^username$/i, /name/i),
        access: pick(cols, /^access_token$/i, /access/i),
        refresh: pick(cols, /^refresh_token$/i, /refresh/i),
        expires: pick(cols, /^expires$/i, /expir/i),
      };
      if (!c.id || !c.name || !c.access) {
        notes.push(`${table} has unexpected columns: ${cols.join(", ")}`);
        continue;
      }
      for (const row of result.values) {
        const get = (col?: string) => (col ? row[cols.indexOf(col)] : undefined);
        const expires = Number(get(c.expires) ?? 0);
        notes.push(`Account ${String(get(c.name))}`);
        // Seconds vs milliseconds vs ISO date: normalize to epoch ms.
        const expiresAt = Number.isFinite(expires) && expires > 0 ? (expires < 1e12 ? expires * 1000 : expires) : Date.parse(String(get(c.expires))) || 0;
        // Tokens are stored as plain text; fail closed if they look encrypted (a later App version might).
        const access = String(get(c.access) ?? "");
        if (!access.startsWith("ey")) {
          notes.push(`Token for ${String(get(c.name))} isn't a readable JWT; skipping`);
          continue;
        }
        const id = String(get(c.id)).replace(/-/g, "");
        if (accounts.some((a) => a.id === id)) continue;
        accounts.push({
          id,
          name: String(get(c.name)),
          kind: "live",
          clientId: LIVE_CLIENT_ID,
          msRefreshToken: String(get(c.refresh) ?? ""),
          mcAccessToken: access,
          mcExpiresAt: expiresAt,
          source: "modrinth-app",
        });
      }
    } finally {
      db.close();
    }
    if (accounts.length) break;
  }
  if (!notes.length) notes.push("Modrinth App data not found on this PC.");
  return { accounts, notes };
}
