import type { LauncherBridge } from "../../preload/index";

declare global {
  interface Window {
    launcher: LauncherBridge;
  }
}

export const invoke = <T,>(channel: string, ...args: unknown[]) => window.launcher.invoke<T>(channel, ...args);
export const on = window.launcher.on;

export interface PublicSettings {
  serverUrl: string;
  /** Address fixed by an environment variable or the build. */
  serverLocked: boolean;
  hasServer: boolean;
  /** Signed in to a pack account (needed to publish, not to play). */
  signedIn: boolean;
  /** A pack key is saved or built in. */
  hasPackKey: boolean;
  displayName: string;
  accounts: { id: string; name: string; source: "signin" | "modrinth-app" | "curseforge-app" }[];
  selectedAccountId: string | null;
  msaClientId: string;
  memoryMb: number;
  captureIgnore: string[];
}

export interface Loader {
  type: string;
  version: string;
}

export interface PackSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  latestRevision: number | null;
  latestVersion: string | null;
  installedRevision: number | null;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface Changes {
  added: string[];
  updated: string[];
  removed: string[];
  downloadBytes: number;
}

export interface RevisionSummary {
  revision: number;
  version?: string;
  changes?: Changes;
  changelog: string;
  warnings: string[];
  minecraft: string;
  loader: Loader | null;
  fileCount: number;
  blockedCount: number;
  publishedBy?: string;
  createdAt: string;
}

export interface PackDetail extends PackSummary {
  revisions: RevisionSummary[];
}

export interface Progress {
  packId: string;
  kind: "sync" | "install";
  phase?: string;
  step?: string;
  done?: number;
  total?: number;
  current?: string;
  detail?: string;
}

export interface BlockedFile {
  path: string;
  fileName?: string;
  pageUrl?: string;
}

/** "v1.2 (r3)" when the version has a name, else "r3". */
export const versionLabel = (r: { revision: number; version?: string | null }) => (r.version ? `${r.version} (r${r.revision})` : `r${r.revision}`);

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** The server turned us away for a missing or wrong pack key. */
export const isPackKeyError = (message: string) => /pack key/i.test(message);
