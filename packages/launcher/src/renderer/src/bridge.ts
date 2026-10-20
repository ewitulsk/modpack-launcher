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
  displayName: string;
  accounts: { id: string; name: string; source: "signin" | "modrinth-app" }[];
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
  installedRevision: number | null;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface RevisionSummary {
  revision: number;
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
