import { getJson, type Fetcher } from "../http.js";

export interface CfFile {
  id: number;
  modId: number;
  fileName: string;
  fileLength: number;
  /** null when the author disallows third-party downloads. */
  downloadUrl: string | null;
  hashes: { value: string; algo: 1 | 2 }[];
}

export interface CfMod {
  id: number;
  name: string;
  slug: string;
  classId: number | null;
  links: { websiteUrl: string };
  allowModDistribution: boolean | null;
}

/** CurseForge class ids → instance folder. */
export const CF_FOLDERS: Record<number, string> = {
  6: "mods",
  12: "resourcepacks",
  6552: "shaderpacks",
  6945: "datapacks",
};

export const cfSha1 = (f: CfFile) => f.hashes.find((h) => h.algo === 1)?.value;

/** CurseForge Core API client. Requires a key from console.curseforge.com; keep it on the backend. */
export class CurseForgeClient {
  private readonly mods = new Map<number, CfMod>();

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly base = "https://api.curseforge.com",
  ) {}

  private headers(json = false): Record<string, string> {
    return { "x-api-key": this.apiKey, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  async getFile(modId: number, fileId: number) {
    const r = await getJson<{ data: CfFile }>(this.fetcher, `${this.base}/v1/mods/${modId}/files/${fileId}`, {
      headers: this.headers(),
    });
    return r.data;
  }

  async getFiles(fileIds: number[]): Promise<CfFile[]> {
    const out: CfFile[] = [];
    for (const chunk of chunks(fileIds, 500)) {
      const r = await getJson<{ data: CfFile[] }>(this.fetcher, `${this.base}/v1/mods/files`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ fileIds: chunk }),
      });
      out.push(...r.data);
    }
    return out;
  }

  /** Batch mod lookup, cached per client. */
  async getMods(modIds: number[]): Promise<Map<number, CfMod>> {
    const missing = [...new Set(modIds)].filter((id) => !this.mods.has(id));
    for (const chunk of chunks(missing, 500)) {
      const r = await getJson<{ data: CfMod[] }>(this.fetcher, `${this.base}/v1/mods`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ modIds: chunk, filterPcOnly: true }),
      });
      for (const m of r.data) this.mods.set(m.id, m);
    }
    return new Map(modIds.flatMap((id) => (this.mods.has(id) ? [[id, this.mods.get(id)!] as const] : [])));
  }
}

function* chunks<T>(xs: T[], n: number) {
  for (let i = 0; i < xs.length; i += n) yield xs.slice(i, i + n);
}
