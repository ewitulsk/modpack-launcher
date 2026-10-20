import type { ChildProcess } from "node:child_process";
import { launch } from "@xmcl/core";

export interface LaunchOptions {
  root: string;
  instanceDir: string;
  versionId: string;
  javaPath: string;
  /** Omit for an offline (singleplayer-only) test launch. */
  account?: { id: string; name: string; accessToken: string };
  memoryMb?: number;
  javaArgs?: string[];
}

export function launchGame(o: LaunchOptions): Promise<ChildProcess> {
  const maxMemory = o.memoryMb ?? 4096;
  return launch({
    gamePath: o.instanceDir,
    resourcePath: o.root,
    javaPath: o.javaPath,
    version: o.versionId,
    gameProfile: o.account ? { id: o.account.id, name: o.account.name } : { id: "00000000000000000000000000000000", name: "Playtester" },
    accessToken: o.account?.accessToken ?? "0",
    userType: o.account ? "mojang" : "legacy",
    minMemory: Math.min(1024, maxMemory),
    maxMemory,
    extraJVMArgs: o.javaArgs ?? [],
    launcherName: "remix-launcher",
    launcherBrand: "remix-launcher",
    extraExecOption: { detached: false },
  });
}
