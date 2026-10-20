import { getJson, type Fetcher } from "../http.js";
import type { EnvSupport } from "./env.js";

export interface MrFile {
  hashes: { sha1: string; sha512: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
}

export interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  files: MrFile[];
  loaders: string[];
  game_versions: string[];
}

export type MrProjectType = "mod" | "modpack" | "resourcepack" | "shader" | "datapack" | "plugin";

export interface MrProject {
  id: string;
  slug: string;
  title: string;
  project_type: MrProjectType;
  client_side: EnvSupport | "unknown";
  server_side: EnvSupport | "unknown";
}

/** Thin Modrinth v2 client. No API key needed; Modrinth asks for a descriptive User-Agent (set in http.ts). */
export class ModrinthClient {
  private readonly projects = new Map<string, Promise<MrProject>>();

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly base = "https://api.modrinth.com/v2",
  ) {}

  getVersion(versionId: string) {
    return getJson<MrVersion>(this.fetcher, `${this.base}/version/${encodeURIComponent(versionId)}`);
  }

  /** Accepts an id or a slug. Cached, since ops and matching look the same projects up repeatedly. */
  getProject(idOrSlug: string) {
    let p = this.projects.get(idOrSlug);
    if (!p) {
      p = getJson<MrProject>(this.fetcher, `${this.base}/project/${encodeURIComponent(idOrSlug)}`);
      this.projects.set(idOrSlug, p);
    }
    return p;
  }

  /** Looks files up by SHA-1. Returns only the hashes Modrinth knows. */
  async versionsBySha1(sha1s: string[]): Promise<Record<string, MrVersion>> {
    if (sha1s.length === 0) return {};
    return getJson<Record<string, MrVersion>>(this.fetcher, `${this.base}/version_files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: sha1s, algorithm: "sha1" }),
    });
  }
}

export function primaryFile(v: MrVersion): MrFile {
  const f = v.files.find((x) => x.primary) ?? v.files[0];
  if (!f) throw new Error(`Modrinth version ${v.id} has no files`);
  return f;
}

export const MODRINTH_FOLDERS: Record<MrProjectType, string> = {
  mod: "mods",
  plugin: "mods",
  modpack: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
  datapack: "datapacks",
};
