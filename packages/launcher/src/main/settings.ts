import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Account } from "./auth/microsoft.js";

export interface Settings {
  serverUrl: string;
  /** Friend token from redeeming an invite, or the admin token. */
  token: string;
  displayName: string;
  /** Every server joined before, so switching between local dev and the real server keeps both logins. */
  servers: Record<string, { token: string; displayName: string }>;
  /** Pack keys typed in by the player, per server. A key baked into the build is used otherwise. */
  packKeys: Record<string, string>;
  accounts: Account[];
  selectedAccountId: string | null;
  /** Set once Mojang approves our own Azure app id; switches sign-in to the device-code flow. */
  msaClientId: string;
  memoryMb: number;
  captureIgnore: string[] | null;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  token: "",
  displayName: "",
  servers: {},
  packKeys: {},
  accounts: [],
  selectedAccountId: null,
  msaClientId: "",
  memoryMb: 6144,
  captureIgnore: null,
};

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(private readonly dir: string) {}

  private get file() {
    return join(this.dir, "settings.json");
  }

  async get(): Promise<Settings> {
    if (!this.cache) {
      try {
        this.cache = { ...DEFAULT_SETTINGS, ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<Settings>) };
      } catch {
        this.cache = { ...DEFAULT_SETTINGS };
      }
    }
    return this.cache;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    this.cache = next;
    await writeFile(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
