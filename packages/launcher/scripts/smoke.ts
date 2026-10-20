/**
 * End-to-end check without the Electron UI, against the real Modrinth/Mojang servers:
 *   resolve a pack → sync the instance → install Minecraft + loader + Java → (optionally) launch offline.
 *
 *   npm run smoke -w @remix/launcher -- --modrinth <versionId> [--launch]
 *   npm run smoke -w @remix/launcher -- --remix my-remix.json --server http://localhost:3000 --token dev
 *
 * With --server, the remix is published through the backend and the lockfile is fetched from it,
 * exactly as a friend's launcher would.
 */
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CurseForgeClient, FsBlobStore, ModrinthClient, resolveRemix, type Fetcher, type Lockfile, type RemixInput } from "@remix/core";
import { Api } from "../src/main/api.js";
import { installGame } from "../src/main/game/install.js";
import { launchGame } from "../src/main/game/launch.js";
import { fillBlocked, syncInstance } from "../src/main/game/sync.js";

const { values } = parseArgs({
  options: {
    modrinth: { type: "string" },
    remix: { type: "string" },
    dir: { type: "string", default: ".smoke" },
    server: { type: "string" },
    token: { type: "string" },
    launch: { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
    seconds: { type: "string", default: "240" },
  },
});

const t0 = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

/** fetch, plus file:// for blobs stored locally by FsBlobStore. */
const fetcher: Fetcher = async (url, init) =>
  url.startsWith("file:") ? new Response(new Uint8Array(await readFile(fileURLToPath(url)))) : fetch(url, init);

async function main() {
  const dir = resolve(values.dir!);
  if (values.clean) await rm(dir, { recursive: true, force: true });

  const remix: RemixInput = values.remix
    ? JSON.parse(await readFile(values.remix, "utf8"))
    : values.modrinth
      ? { schema: 1, name: `Modrinth ${values.modrinth}`, base: { source: "modrinth", versionId: values.modrinth } }
      : (() => {
          throw new Error("Pass --modrinth <versionId> or --remix <file>");
        })();

  let lockfile: Lockfile;
  let revision = 1;
  if (values.server) {
    const api = new Api(values.server, values.token ?? "");
    step(`Publishing through ${values.server}`);
    const pack = await api.createPack(`${remix.name} ${Date.now()}`, "smoke test");
    const rev = await api.publish(pack.id, remix, "smoke test");
    for (const w of rev.warnings) console.warn(`  ! ${w}`);
    lockfile = (await api.revision(pack.id, "latest")).client;
    revision = rev.revision;
  } else {
    step("Resolving against Modrinth" + (process.env.CURSEFORGE_API_KEY ? " and CurseForge" : ""));
    const blobDir = resolve(dir, "blobs");
    const r = await resolveRemix(remix, {
      blobs: new FsBlobStore(blobDir, `${pathToFileURL(blobDir).href}/`),
      modrinth: new ModrinthClient(),
      curseforge: process.env.CURSEFORGE_API_KEY ? new CurseForgeClient(process.env.CURSEFORGE_API_KEY) : undefined,
    });
    for (const w of r.warnings) console.warn(`  ! ${w}`);
    lockfile = r.lockfile;
  }
  step(`${lockfile.name}: Minecraft ${lockfile.minecraft}, ${lockfile.loader ? `${lockfile.loader.type} ${lockfile.loader.version}` : "vanilla"}, ${lockfile.files.length} files`);

  const instanceDir = resolve(dir, "instance");
  let last = 0;
  const sync = await syncInstance({
    instanceDir,
    packId: "smoke",
    packName: lockfile.name,
    revision,
    lockfile,
    fetcher,
    onProgress: (p) => {
      if (p.phase === "download" && p.done - last >= 25) step(`  downloaded ${(last = p.done)}/${p.total}`);
    },
  });
  const missing = await fillBlocked(instanceDir, sync.blocked);
  step(`Synced: ${sync.downloaded} downloaded, ${sync.removed} removed, ${sync.unchanged} unchanged, ${missing.length} need manual download`);
  for (const b of missing) console.warn(`  manual: ${b.blocked?.fileName} ${b.blocked?.pageUrl}`);

  const installed = await installGame({
    root: resolve(dir, "game"),
    javaRoot: resolve(dir, "java"),
    minecraft: lockfile.minecraft,
    loader: lockfile.loader,
    onProgress: (p) => step(`  install ${p.step}${p.detail ? ` ${p.detail}` : ""}`),
  });
  step(`Installed ${installed.versionId}; Java at ${installed.javaPath}`);

  if (!values.launch) return step("Done (pass --launch to start the game offline)");
  if (missing.length) throw new Error("Can't launch: some mods need a manual download first.");

  step("Launching offline");
  const proc = await launchGame({ root: resolve(dir, "game"), instanceDir, versionId: installed.versionId, javaPath: installed.javaPath, memoryMb: lockfile.memoryMb ?? 4096 });
  const ok = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), Number(values.seconds) * 1000);
    const onData = (b: Buffer) => {
      const text = b.toString();
      process.stdout.write(text.replace(/^/gm, "    | "));
      // Reaching the title screen: the sound engine starts after mods finish loading.
      if (/Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas/i.test(text)) {
        clearTimeout(timer);
        done(true);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      step(`Game exited with code ${code}`);
      done(false);
    });
  });
  proc.kill();
  if (!ok) throw new Error("The game didn't reach the title screen.");
  step("Reached the title screen. Smoke test passed.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
