export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "nicwitulski/modpack-launcher/0.1 (friends-only remix launcher)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

async function check(res: Response, url: string) {
  if (!res.ok) throw new HttpError(url, res.status, await res.text().catch(() => ""));
  return res;
}

export async function getJson<T>(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<T> {
  const res = await check(await fetcher(url, withUa(init)), url);
  return (await res.json()) as T;
}

export async function getBytes(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<Uint8Array> {
  const res = await check(await fetcher(url, withUa(init)), url);
  return new Uint8Array(await res.arrayBuffer());
}

function withUa(init: RequestInit): RequestInit {
  return { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string>) } };
}
