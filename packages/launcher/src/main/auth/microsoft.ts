/**
 * Microsoft → Xbox Live → XSTS → Minecraft sign-in chain.
 *
 * Two ways to get the Microsoft token:
 *  - "live": the official launcher's public client id with the login.live.com desktop redirect,
 *    shown in an Electron window. Works today without registering anything.
 *  - "azure": our own Azure app (device-code flow). Needs Mojang to approve the app id for the
 *    Minecraft API; switch to it by setting msaClientId in settings once approved.
 */
import type { Fetcher } from "@remix/core";

export const LIVE_CLIENT_ID = "00000000402b5328";
export const LIVE_REDIRECT = "https://login.live.com/oauth20_desktop.srf";
export const LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const LIVE_TOKEN = "https://login.live.com/oauth20_token.srf";
const AZURE = "https://login.microsoftonline.com/consumers/oauth2/v2.0";

export type MsaKind = "live" | "azure";

export interface Account {
  /** Minecraft profile UUID without dashes. */
  id: string;
  name: string;
  kind: MsaKind;
  clientId: string;
  msRefreshToken: string;
  mcAccessToken: string;
  /** epoch ms */
  mcExpiresAt: number;
  /** Where it came from, for the UI. */
  source: "signin" | "modrinth-app";
}

export interface MsToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class AuthError extends Error {}

export function liveAuthorizeUrl() {
  const q = new URLSearchParams({
    client_id: LIVE_CLIENT_ID,
    response_type: "code",
    scope: LIVE_SCOPE,
    redirect_uri: LIVE_REDIRECT,
    prompt: "select_account",
  });
  return `https://login.live.com/oauth20_authorize.srf?${q}`;
}

async function form<T>(fetcher: Fetcher, url: string, body: Record<string, string>): Promise<T> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
  if (!res.ok) throw Object.assign(new AuthError(json.error_description ?? json.error ?? `HTTP ${res.status}`), { code: json.error });
  return json;
}

async function postJson<T>(fetcher: Fetcher, url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

export const exchangeLiveCode = (fetcher: Fetcher, code: string) =>
  form<MsToken>(fetcher, LIVE_TOKEN, {
    client_id: LIVE_CLIENT_ID,
    code,
    grant_type: "authorization_code",
    redirect_uri: LIVE_REDIRECT,
    scope: LIVE_SCOPE,
  });

export function refreshMs(fetcher: Fetcher, kind: MsaKind, clientId: string, refreshToken: string) {
  return kind === "live"
    ? form<MsToken>(fetcher, LIVE_TOKEN, {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        redirect_uri: LIVE_REDIRECT,
        scope: LIVE_SCOPE,
      })
    : form<MsToken>(fetcher, `${AZURE}/token`, {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "XboxLive.signin offline_access",
      });
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
  message: string;
}

export const startDeviceCode = (fetcher: Fetcher, clientId: string) =>
  form<DeviceCode>(fetcher, `${AZURE}/devicecode`, { client_id: clientId, scope: "XboxLive.signin offline_access" });

export async function pollDeviceCode(
  fetcher: Fetcher,
  clientId: string,
  dc: DeviceCode,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<MsToken> {
  const deadline = Date.now() + dc.expires_in * 1000;
  let interval = dc.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      return await form<MsToken>(fetcher, `${AZURE}/token`, {
        client_id: clientId,
        device_code: dc.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5000;
        continue;
      }
      throw e;
    }
  }
  throw new AuthError("The sign-in code expired. Try again.");
}

const XERR: Record<number, string> = {
  2148916233: "This Microsoft account has no Xbox profile. Sign in once at minecraft.net to create one.",
  2148916235: "Xbox Live isn't available in this account's country.",
  2148916236: "This account needs adult verification on xbox.com.",
  2148916237: "This account needs adult verification on xbox.com.",
  2148916238: "This is a child account; an adult must add it to a Microsoft family first.",
};

/** Microsoft access token → Minecraft access token + profile. */
export async function minecraftFromMs(fetcher: Fetcher, kind: MsaKind, msAccessToken: string) {
  const xbl = await postJson<{ Token: string; DisplayClaims: { xui: { uhs: string }[] } }>(
    fetcher,
    "https://user.auth.xboxlive.com/user/authenticate",
    {
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: kind === "azure" ? `d=${msAccessToken}` : msAccessToken },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    },
  );
  if (xbl.status !== 200) throw new AuthError(`Xbox Live sign-in failed (HTTP ${xbl.status}).`);
  const uhs = xbl.json.DisplayClaims.xui[0]?.uhs;

  const xsts = await postJson<{ Token: string; XErr?: number }>(fetcher, "https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: { SandboxId: "RETAIL", UserTokens: [xbl.json.Token] },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  });
  if (xsts.status !== 200) {
    throw new AuthError(XERR[xsts.json.XErr ?? 0] ?? `Xbox authorization failed (HTTP ${xsts.status}, XErr ${xsts.json.XErr}).`);
  }

  const mc = await postJson<{ access_token: string; expires_in: number }>(
    fetcher,
    "https://api.minecraftservices.com/authentication/login_with_xbox",
    { identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}` },
  );
  if (mc.status !== 200) {
    throw new AuthError(
      mc.status === 403
        ? "Minecraft refused this sign-in app (it isn't approved for the Minecraft API)."
        : `Minecraft sign-in failed (HTTP ${mc.status}).`,
    );
  }
  const profile = await getProfile(fetcher, mc.json.access_token);
  return { accessToken: mc.json.access_token, expiresAt: Date.now() + mc.json.expires_in * 1000, profile };
}

export async function getProfile(fetcher: Fetcher, mcAccessToken: string) {
  const res = await fetcher("https://api.minecraftservices.com/minecraft/profile", {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) throw new AuthError("This Microsoft account doesn't own Minecraft: Java Edition.");
  if (!res.ok) throw new AuthError(`Couldn't read the Minecraft profile (HTTP ${res.status}).`);
  return (await res.json()) as { id: string; name: string };
}

export async function accountFromMs(fetcher: Fetcher, kind: MsaKind, clientId: string, ms: MsToken): Promise<Account> {
  const mc = await minecraftFromMs(fetcher, kind, ms.access_token);
  return {
    id: mc.profile.id,
    name: mc.profile.name,
    kind,
    clientId,
    msRefreshToken: ms.refresh_token,
    mcAccessToken: mc.accessToken,
    mcExpiresAt: mc.expiresAt,
    source: "signin",
  };
}

/** Returns an account with a Minecraft token good for at least 10 more minutes, refreshing if needed. */
export async function ensureFresh(fetcher: Fetcher, account: Account): Promise<Account> {
  if (account.mcExpiresAt - Date.now() > 10 * 60_000) return account;
  if (!account.msRefreshToken) throw new AuthError(`${account.name}'s sign-in expired. Sign in again.`);
  const ms = await refreshMs(fetcher, account.kind, account.clientId, account.msRefreshToken);
  const fresh = await accountFromMs(fetcher, account.kind, account.clientId, ms);
  return { ...fresh, source: account.source };
}
