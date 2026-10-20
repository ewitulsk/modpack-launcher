/**
 * Installs Minecraft, the mod loader and a matching Java runtime with @xmcl/installer.
 * Versions, libraries and assets live in one shared folder so packs on the same
 * Minecraft version don't download them twice.
 */
import { join } from "node:path";
import { MinecraftFolder, Version, type ResolvedVersion } from "@xmcl/core";
import {
  DEFAULT_RUNTIME_ALL_URL,
  createDefaultNodeInstallRuntime,
  createFabricInstallWorkflow,
  createJavaRuntimeInstallWorkflow,
  createModernForgeInstallWorkflow,
  createQuiltInstallWorkflow,
  executeInstallManifest,
  executeInstallWorkflow,
  getVersionList,
  resolveAssetMetadataInstallFiles,
  resolveAssetObjectInstallFiles,
  resolveForgeArtifactVersion,
  resolveForgeInstallerFile,
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  resolveMinecraftVersionJsonInstallFile,
  resolveNeoForgedInstallerFile,
  type InstallFile,
  type InstallRuntime,
  type JavaRuntimes,
} from "@xmcl/installer";
import type { Loader } from "@remix/core";
import { exists } from "./files.js";

export interface InstallProgress {
  step: "minecraft" | "java" | "loader" | "libraries" | "assets" | "done";
  detail?: string;
}

export interface InstalledVersion {
  /** Version id to launch, e.g. "1.21.1" or "neoforge-21.1.77". */
  versionId: string;
  javaPath: string;
}

async function runFiles(runtime: InstallRuntime, id: string, files: (InstallFile | undefined)[]) {
  const list = files.filter((f): f is InstallFile => Boolean(f));
  if (list.length === 0) return;
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id, type: "files", files: list }] }, runtime);
}

/** Libraries, client jar, asset index and asset objects for a resolved version. */
async function installResolved(runtime: InstallRuntime, mc: MinecraftFolder, v: ResolvedVersion, report: (p: InstallProgress) => void) {
  report({ step: "libraries", detail: v.id });
  await runFiles(runtime, `${v.id}:libraries`, [resolveMinecraftJarInstallFile(v), ...resolveLibraryInstallFiles(v.libraries, mc)]);
  report({ step: "assets", detail: v.assets });
  await runFiles(runtime, `${v.id}:asset-index`, resolveAssetMetadataInstallFiles(v, mc));
  await runFiles(runtime, `${v.id}:assets`, await resolveAssetObjectInstallFiles(v, mc));
}

function platformKey(): keyof JavaRuntimes {
  const arm = process.arch === "arm64";
  if (process.platform === "win32") return arm ? "windows-arm64" : process.arch === "ia32" ? "windows-x86" : "windows-x64";
  if (process.platform === "darwin") return arm ? "mac-os-arm64" : "mac-os";
  return process.arch === "ia32" ? "linux-i386" : "linux";
}

/** Mojang's own Java build for this Minecraft version (the same one the official launcher uses). */
export async function ensureJava(javaRoot: string, version: ResolvedVersion, runtime: InstallRuntime): Promise<string> {
  const component = version.javaVersion?.component ?? "jre-legacy";
  const destination = join(javaRoot, component);
  const exe = process.platform === "win32" ? join(destination, "bin", "javaw.exe") : join(destination, "bin", "java");
  if (await exists(exe)) return exe;

  const all = (await (await fetch(DEFAULT_RUNTIME_ALL_URL)).json()) as JavaRuntimes;
  const target = all[platformKey()]?.[component]?.[0];
  if (!target) throw new Error(`Mojang has no ${component} Java runtime for ${platformKey()}.`);
  await executeInstallWorkflow(createJavaRuntimeInstallWorkflow({ target, destination }), runtime);
  if (!(await exists(exe))) throw new Error(`Java installed but ${exe} is missing.`);
  return exe;
}

/** The java.exe console variant, which loader installers need to run processors. */
const consoleJava = (javaPath: string) => javaPath.replace(/javaw\.exe$/i, "java.exe");

export async function installGame(opts: {
  /** Shared folder for versions/, libraries/, assets/. */
  root: string;
  javaRoot: string;
  minecraft: string;
  loader: Loader | null;
  onProgress?: (p: InstallProgress) => void;
}): Promise<InstalledVersion> {
  const report = opts.onProgress ?? (() => {});
  const mc = MinecraftFolder.from(opts.root);
  const runtime = createDefaultNodeInstallRuntime({ maxConcurrency: 16 });

  report({ step: "minecraft", detail: opts.minecraft });
  if (!(await exists(mc.getVersionJson(opts.minecraft)))) {
    const info = (await getVersionList()).versions.find((v) => v.id === opts.minecraft);
    if (!info) throw new Error(`Unknown Minecraft version ${opts.minecraft}`);
    await runFiles(runtime, `${opts.minecraft}:json`, [resolveMinecraftVersionJsonInstallFile(info, mc)]);
  }
  const vanilla = await Version.parse(mc, opts.minecraft);
  await installResolved(runtime, mc, vanilla, report);

  report({ step: "java", detail: vanilla.javaVersion?.component });
  const javaPath = await ensureJava(opts.javaRoot, vanilla, runtime);

  let versionId = opts.minecraft;
  const loader = opts.loader;
  if (loader) {
    report({ step: "loader", detail: `${loader.type} ${loader.version}` });
    versionId = await installLoader(runtime, mc, opts.minecraft, loader, consoleJava(javaPath));
    await installResolved(runtime, mc, await Version.parse(mc, versionId), report);
  }
  report({ step: "done" });
  return { versionId, javaPath };
}

async function installLoader(runtime: InstallRuntime, mc: MinecraftFolder, minecraft: string, loader: Loader, java: string): Promise<string> {
  switch (loader.type) {
    case "fabric":
      return executeInstallWorkflow(createFabricInstallWorkflow({ minecraftVersion: minecraft, version: loader.version, minecraft: mc }), runtime);
    case "quilt":
      return executeInstallWorkflow(createQuiltInstallWorkflow({ minecraftVersion: minecraft, version: loader.version, minecraft: mc }), runtime);
    case "forge": {
      const artifactVersion = resolveForgeArtifactVersion(minecraft, loader.version);
      const { file } = resolveForgeInstallerFile(artifactVersion, undefined, mc, { java });
      return (await executeInstallWorkflow(forgeWorkflow(mc, minecraft, file, artifactVersion, java, `forge-${artifactVersion}`), runtime)).version;
    }
    case "neoforge": {
      // NeoForge for 1.20.1 was published as net.neoforged:forge:1.20.1-47.x; later as net.neoforged:neoforge:<ver>.
      const legacy = minecraft === "1.20.1";
      const artifactVersion = legacy ? resolveForgeArtifactVersion(minecraft, loader.version) : loader.version;
      const { file } = await resolveNeoForgedInstallerFile(legacy ? "forge" : "neoforge", artifactVersion, mc, { java });
      return (await executeInstallWorkflow(forgeWorkflow(mc, minecraft, file, artifactVersion, java, `neoforge-${artifactVersion}`), runtime)).version;
    }
  }
}

const forgeWorkflow = (mc: MinecraftFolder, minecraft: string, installer: InstallFile, artifactVersion: string, java: string, id: string) =>
  createModernForgeInstallWorkflow({ id, minecraft: mc, minecraftVersion: minecraft, installer, artifactVersion, java, installOptions: { java } });
