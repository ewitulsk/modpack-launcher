import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ModrinthClient, type RemixInput } from "@remix/core";
import { Api } from "./api.js";
import {
  AuthError,
  LIVE_REDIRECT,
  accountFromMs,
  ensureFresh,
  exchangeLiveCode,
  liveAuthorizeUrl,
  pollDeviceCode,
  startDeviceCode,
  type Account,
} from "./auth/microsoft.js";
import { importModrinthAccounts } from "./auth/modrinth-app.js";
import { DEFAULT_CAPTURE_IGNORE, captureChanges } from "./game/capture.js";
import { installGame } from "./game/install.js";
import { launchGame } from "./game/launch.js";
import { fillBlocked, readState, syncInstance } from "./game/sync.js";
import { SettingsStore, type Settings } from "./settings.js";

const dirs = {
  get data() {
    return app.getPath("userData");
  },
  get game() {
    return join(this.data, "game");
  },
  get java() {
    return join(this.data, "java");
  },
  instance(slug: string) {
    return join(this.data, "instances", slug);
  },
};

const settings = new SettingsStore(app.getPath("userData"));

/**
 * Server preset. REMIX_SERVER_URL at runtime wins over MAIN_VITE_SERVER_URL, which electron-vite
 * bakes in at build time from packages/launcher/.env.production (for friends' builds).
 * `npm run dev` defaults to the local backend (npm run dev:backend), signed in as admin with token "dev".
 */
// Not import.meta.env.DEV: electron-vite builds main in production mode even under `npm run dev`.
const dev = !app.isPackaged;
const preset = {
  serverUrl: (process.env.REMIX_SERVER_URL || import.meta.env?.MAIN_VITE_SERVER_URL || (dev ? "http://localhost:3000" : "")).trim().replace(/\/$/, ""),
  token: (process.env.REMIX_TOKEN || (dev ? "dev" : "")).trim(),
};

const cleanUrl = (u: string) => u.trim().replace(/\/$/, "");

/** Remember a sign-in for this server (saved per server so switching keeps both). */
async function signIn(serverUrl: string, token: string) {
  const me = await new Api(serverUrl, token).me();
  const s = await settings.get();
  return settings.update({ serverUrl, token, displayName: me.username, servers: { ...s.servers, [serverUrl]: { token, displayName: me.username } } });
}

/** Point at a server, reusing a saved sign-in for it. Browsing works without one. */
async function useServer(serverUrl: string) {
  const s = await settings.get();
  const saved = s.servers[serverUrl];
  return settings.update({ serverUrl, token: saved?.token ?? "", displayName: saved?.displayName ?? "" });
}

/** Switch to the preset server on startup, reusing a saved sign-in for it or the preset token. */
async function applyPreset() {
  if (!preset.serverUrl) return;
  const s = await settings.get();
  if (s.serverUrl === preset.serverUrl && s.token) return;
  if (!s.servers[preset.serverUrl] && preset.token) {
    try {
      return void (await signIn(preset.serverUrl, preset.token));
    } catch (e) {
      console.warn(`Couldn't sign in to ${preset.serverUrl}: ${(e as Error).message}`);
    }
  }
  await useServer(preset.serverUrl);
}
const modrinth = new ModrinthClient();
let win: BrowserWindow | null = null;

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);
const log = (line: string) => send("log", line);

async function api() {
  const s = await settings.get();
  if (!s.serverUrl) throw new Error("Set the pack server address first (Settings).");
  return new Api(s.serverUrl, s.token);
}

/** For publishing: needs a signed-in pack account. */
async function authed() {
  const s = await settings.get();
  if (!s.token) throw new Error("Sign in to your pack account first (Remix & publish).");
  return api();
}

/** What the renderer is allowed to see of settings (no tokens). */
function publicSettings(s: Settings) {
  return {
    serverUrl: s.serverUrl,
    serverLocked: Boolean(preset.serverUrl),
    hasServer: Boolean(s.serverUrl),
    signedIn: Boolean(s.token),
    displayName: s.displayName,
    accounts: s.accounts.map((a) => ({ id: a.id, name: a.name, source: a.source })),
    selectedAccountId: s.selectedAccountId,
    msaClientId: s.msaClientId,
    memoryMb: s.memoryMb,
    captureIgnore: s.captureIgnore ?? DEFAULT_CAPTURE_IGNORE,
  };
}

async function saveAccount(a: Account) {
  const s = await settings.get();
  const accounts = [...s.accounts.filter((x) => x.id !== a.id), a];
  return settings.update({ accounts, selectedAccountId: s.selectedAccountId ?? a.id });
}

/** Official-launcher client id + login.live.com, in a small window. */
function liveSignIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ width: 520, height: 680, parent: win ?? undefined, modal: true, title: "Sign in to Microsoft" });
    w.setMenuBarVisibility(false);
    let settled = false;
    const check = (url: string) => {
      if (!url.startsWith(LIVE_REDIRECT)) return;
      const q = new URL(url).searchParams;
      settled = true;
      w.close();
      const code = q.get("code");
      if (code) resolve(code);
      else reject(new AuthError(q.get("error_description") ?? q.get("error") ?? "Sign-in cancelled"));
    };
    w.webContents.on("will-redirect", (_e, url) => check(url));
    w.webContents.on("did-navigate", (_e, url) => check(url));
    w.on("closed", () => settled || reject(new AuthError("Sign-in window closed")));
    void w.loadURL(liveAuthorizeUrl());
  });
}

type Handler = (...args: never[]) => Promise<unknown>;
const handlers: Record<string, Handler> = {
  "settings:get": async () => publicSettings(await settings.get()),
  "settings:update": async (patch: Partial<Pick<Settings, "memoryMb" | "msaClientId" | "captureIgnore">>) =>
    publicSettings(await settings.update(patch)),

  "server:set": async (serverUrl: string) => {
    if (preset.serverUrl) throw new Error("This launcher's server address is fixed.");
    const url = cleanUrl(serverUrl);
    await new Api(url).packs();
    return publicSettings(await useServer(url));
  },
  "server:forget": async () => {
    if (preset.serverUrl) throw new Error("This launcher's server address is fixed.");
    return publicSettings(await settings.update({ serverUrl: "", token: "", displayName: "" }));
  },
  /** The signed-in pack account, or null when browsing anonymously. */
  "account:me": async () => ((await settings.get()).token ? (await api()).me() : null),
  "account:register": async (o: { code: string; username: string; password: string }) => {
    const s = await settings.get();
    const r = await new Api(s.serverUrl).register(o.code.trim(), o.username.trim(), o.password);
    return publicSettings(await signIn(s.serverUrl, r.token));
  },
  "account:login": async (o: { username: string; password: string }) => {
    const s = await settings.get();
    const r = await new Api(s.serverUrl).login(o.username.trim(), o.password);
    return publicSettings(await signIn(s.serverUrl, r.token));
  },
  /** Sign in with a raw token, e.g. the server's ADMIN_TOKEN. */
  "account:token": async (token: string) => publicSettings(await signIn((await settings.get()).serverUrl, token.trim())),
  "account:logout": async () => {
    const s = await settings.get();
    await (await api()).logout().catch(() => undefined);
    const { [s.serverUrl]: _gone, ...servers } = s.servers;
    return publicSettings(await settings.update({ token: "", displayName: "", servers }));
  },

  "auth:signin": async () => {
    const s = await settings.get();
    if (s.msaClientId) {
      const dc = await startDeviceCode(fetch, s.msaClientId);
      send("auth:devicecode", { code: dc.user_code, url: dc.verification_uri });
      void shell.openExternal(dc.verification_uri);
      const ms = await pollDeviceCode(fetch, s.msaClientId, dc);
      return publicSettings(await saveAccount(await accountFromMs(fetch, "azure", s.msaClientId, ms)));
    }
    const code = await liveSignIn();
    const ms = await exchangeLiveCode(fetch, code);
    return publicSettings(await saveAccount(await accountFromMs(fetch, "live", "00000000402b5328", ms)));
  },
  "auth:importModrinth": async () => {
    const { accounts, notes } = await importModrinthAccounts();
    for (const a of accounts) await saveAccount(a);
    return { settings: publicSettings(await settings.get()), imported: accounts.map((a) => a.name), notes };
  },
  "auth:select": async (id: string) => publicSettings(await settings.update({ selectedAccountId: id })),
  "auth:remove": async (id: string) => {
    const s = await settings.get();
    const accounts = s.accounts.filter((a) => a.id !== id);
    return publicSettings(await settings.update({ accounts, selectedAccountId: accounts[0]?.id ?? null }));
  },

  "packs:list": async () => {
    const packs = await (await api()).packs();
    return Promise.all(packs.map(async (p) => ({ ...p, installedRevision: (await readState(dirs.instance(p.slug)))?.revision ?? null })));
  },
  "packs:get": async (id: string) => {
    const pack = await (await api()).pack(id);
    return { ...pack, installedRevision: (await readState(dirs.instance(pack.slug)))?.revision ?? null };
  },

  /** Sync, install and launch. Returns early with the blocked list if manual downloads are needed. */
  "packs:play": async (id: string, opts: { revision?: number; offline?: boolean } = {}) => {
    const client = await api();
    const pack = await client.pack(id);
    const rev = await client.revision(pack.id, opts.revision ?? "latest");
    const instanceDir = dirs.instance(pack.slug);
    const lock = rev.client;

    log(`Syncing ${pack.name} r${rev.revision} (${lock.files.length} files)`);
    const res = await syncInstance({
      instanceDir,
      packId: pack.id,
      packName: pack.name,
      revision: rev.revision,
      lockfile: lock,
      onProgress: (p) => send("progress", { packId: pack.id, kind: "sync", ...p }),
    });
    const stillBlocked = await fillBlocked(instanceDir, res.blocked);
    if (stillBlocked.length) return { status: "blocked", blocked: stillBlocked.map((e) => ({ path: e.path, ...e.blocked })) };

    const installed = await installGame({
      root: dirs.game,
      javaRoot: dirs.java,
      minecraft: lock.minecraft,
      loader: lock.loader,
      onProgress: (p) => send("progress", { packId: pack.id, kind: "install", ...p }),
    });

    const s = await settings.get();
    let account: Account | undefined;
    if (!opts.offline) {
      const selected = s.accounts.find((a) => a.id === s.selectedAccountId);
      if (!selected) throw new Error("Sign in with a Minecraft account first (Accounts).");
      account = await ensureFresh(fetch, selected);
      if (account !== selected) await saveAccount(account);
    }

    log(`Launching ${installed.versionId} with ${installed.javaPath}`);
    const proc = await launchGame({
      root: dirs.game,
      instanceDir,
      versionId: installed.versionId,
      javaPath: installed.javaPath,
      account: account && { id: account.id, name: account.name, accessToken: account.mcAccessToken },
      memoryMb: lock.memoryMb ?? s.memoryMb,
      javaArgs: lock.javaArgs,
    });
    proc.stdout?.on("data", (b: Buffer) => log(b.toString()));
    proc.stderr?.on("data", (b: Buffer) => log(b.toString()));
    proc.on("exit", (code) => send("game:exit", { packId: pack.id, code }));
    return { status: "launched", sync: { downloaded: res.downloaded, removed: res.removed } };
  },
  "packs:openFolder": async (slug: string) => shell.openPath(dirs.instance(slug)),
  "shell:open": async (url: string) => shell.openExternal(url),

  // --- remix & publish (needs a pack account) ---------------------------------------------------------------
  "admin:createInvite": async (note: string) => (await authed()).createInvite(note),
  "admin:createPack": async (name: string, description: string) => (await authed()).createPack(name, description),
  "admin:preview": async (remix: RemixInput) => (await authed()).preview(remix),
  "admin:publish": async (packId: string, remix: RemixInput, changelog: string) => (await authed()).publish(packId, remix, changelog),
  "admin:latestRemix": async (packId: string) => {
    const pack = await (await api()).pack(packId);
    if (!pack.latestRevision) return null;
    return (await (await api()).revision(pack.id, "latest")).remix;
  },
  /** Pick files from disk, upload them, and return blob refs for putFile ops. */
  "admin:uploadFiles": async () => {
    const client = await authed();
    const pick = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"] });
    const out: { name: string; blob: string }[] = [];
    for (const path of pick.filePaths) {
      const hex = await client.upload(new Uint8Array(await readFile(path)));
      out.push({ name: path.split(/[\\/]/).at(-1)!, blob: `sha256:${hex}` });
    }
    return out;
  },
  /** Diff the installed instance against the revision it was synced from. */
  "admin:capture": async (slug: string) => {
    const state = await readState(dirs.instance(slug));
    if (!state) throw new Error("Install and play this pack once before capturing changes.");
    const client = await authed();
    const s = await settings.get();
    const result = await captureChanges({
      instanceDir: dirs.instance(slug),
      lockfile: state.lockfile,
      modrinth,
      upload: (data) => client.upload(data),
      ignore: s.captureIgnore ?? undefined,
    });
    return { ...result, baseRevision: state.revision };
  },
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: "Remix Launcher",
    backgroundColor: "#16181d",
    webPreferences: { preload: join(__dirname, "../preload/index.mjs"), sandbox: false },
  });
  win.setMenuBarVisibility(false);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  await applyPreset();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
