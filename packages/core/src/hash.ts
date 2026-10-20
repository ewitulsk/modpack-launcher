import { createHash } from "node:crypto";

export const sha1 = (data: Uint8Array) => createHash("sha1").update(data).digest("hex");
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const sha512 = (data: Uint8Array) => createHash("sha512").update(data).digest("hex");
