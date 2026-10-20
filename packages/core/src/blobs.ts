import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./hash.js";

/** Content-addressed storage for uploaded files and extracted pack overrides. */
export interface BlobStore {
  /** Stores bytes and returns their sha256 hex. Idempotent. */
  put(data: Uint8Array): Promise<string>;
  get(sha256Hex: string): Promise<Uint8Array>;
  /** Public URL launchers download the blob from. */
  url(sha256Hex: string): string;
}

export const blobKey = (hex: string) => `blobs/${hex.slice(0, 2)}/${hex}`;

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  constructor(private readonly baseUrl = "https://files.example/") {}
  async put(data: Uint8Array) {
    const hex = sha256(data);
    this.blobs.set(hex, data);
    return hex;
  }
  async get(hex: string) {
    const b = this.blobs.get(hex);
    if (!b) throw new Error(`blob ${hex} not found`);
    return b;
  }
  url(hex: string) {
    return this.baseUrl + blobKey(hex);
  }
}

/** Blobs on local disk, laid out like the Spaces bucket. Handy for the CLI and tests. */
export class FsBlobStore implements BlobStore {
  constructor(
    private readonly dir: string,
    private readonly baseUrl = `file://${dir.replace(/\\/g, "/")}/`,
  ) {}
  async put(data: Uint8Array) {
    const hex = sha256(data);
    const file = join(this.dir, blobKey(hex));
    try {
      await access(file);
    } catch {
      await mkdir(join(this.dir, "blobs", hex.slice(0, 2)), { recursive: true });
      await writeFile(file, data);
    }
    return hex;
  }
  async get(hex: string) {
    return new Uint8Array(await readFile(join(this.dir, blobKey(hex))));
  }
  url(hex: string) {
    return this.baseUrl + blobKey(hex);
  }
}
