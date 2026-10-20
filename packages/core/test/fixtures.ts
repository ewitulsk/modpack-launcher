import { strToU8, zipSync } from "fflate";
import type { Fetcher } from "../src/http.js";

type Route = (req: { url: string; method: string; body: unknown; headers: Record<string, string> }) => unknown;

/** Fake fetch: routes are "METHOD url" → JSON value, Uint8Array, or a function of the request. */
export function fakeFetch(routes: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    let r = routes[`${method} ${url}`];
    if (r === undefined) return new Response(`no route ${method} ${url}`, { status: 404 });
    if (typeof r === "function") {
      r = (r as Route)({
        url,
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      });
    }
    if (r instanceof Uint8Array) return new Response(r);
    return Response.json(r);
  };
  return Object.assign(f, { calls });
}

export const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));

export const MR = "https://api.modrinth.com/v2";
export const CF = "https://api.curseforge.com";

export const mrFile = (project: string, version: string, filename: string, sha1: string) => ({
  hashes: { sha1, sha512: sha1.repeat(4) },
  url: `https://cdn.modrinth.com/data/${project}/versions/${version}/${filename}`,
  filename,
  primary: true,
  size: 100,
});
