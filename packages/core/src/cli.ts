#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { FsBlobStore } from "./blobs.js";
import { resolveRemix } from "./resolve.js";
import { CurseForgeClient } from "./sources/curseforge.js";
import { ModrinthClient } from "./sources/modrinth.js";

const usage = `Usage: remix resolve <remix.json> [--out lockfile.json] [--blobs .blobs] [--side client|server]

Resolves a remix against CurseForge/Modrinth and writes the lockfile.
Set CURSEFORGE_API_KEY to resolve CurseForge packs and mods.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      blobs: { type: "string", default: ".blobs" },
      side: { type: "string", default: "client" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, file] = positionals;
  if (values.help || cmd !== "resolve" || !file) {
    console.log(usage);
    process.exit(values.help ? 0 : 1);
  }
  if (values.side !== "client" && values.side !== "server") throw new Error("--side must be client or server");

  const key = process.env.CURSEFORGE_API_KEY;
  const { lockfile, warnings } = await resolveRemix(JSON.parse(await readFile(file, "utf8")), {
    blobs: new FsBlobStore(resolvePath(values.blobs!)),
    modrinth: new ModrinthClient(),
    curseforge: key ? new CurseForgeClient(key) : undefined,
    side: values.side,
  });

  const out = values.out ?? file.replace(/\.json$/, "") + `.${values.side}.lock.json`;
  await writeFile(out, JSON.stringify(lockfile, null, 2));
  const blocked = lockfile.files.filter((f) => f.blocked).length;
  console.log(`${lockfile.name}: Minecraft ${lockfile.minecraft}, ${lockfile.loader?.type ?? "vanilla"} ${lockfile.loader?.version ?? ""}`);
  console.log(`${lockfile.files.length} files, ${blocked} need manual download → ${out}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
