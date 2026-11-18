import { miniappFetch, setUnauthorizedHandler } from "./polyfill";

import { ResceneClient } from "@rescene/api-client";
import Taro from "@tarojs/taro";

const TOKEN_KEY = "rescene-token";
const LOGIN_PAGE = "/pages/index/index";
// api.ts relaunches the login page; this marker survives that remount so the
// notice stays actionable even when another page saw the 401 first.
const EXPIRY_NOTICE_KEY = "rescene-session-expired";
// Wrong credentials also answer 401; these calls never mean an expired session.
const ANONYMOUS_AUTH_PATHS = ["/v1/auth/login", "/v1/auth/register"];

export const apiBaseUrl = process.env.TARO_APP_API_URL;
export const webBaseUrl = process.env.TARO_APP_WEB_URL;

export const client = new ResceneClient(apiBaseUrl, Taro.getStorageSync<string>(TOKEN_KEY) || null, miniappFetch);

const expiryListeners = new Set<() => void>();
let expired = false;

/** Subscribe screens to an expired credential; returns an unsubscribe function. */
export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => {
    expiryListeners.delete(listener);
  };
}

function expireSession(): void {
  if (expired) return;
  expired = true;
  client.setToken(null);
  Taro.removeStorageSync(TOKEN_KEY);
  Taro.setStorageSync(EXPIRY_NOTICE_KEY, "1");
  for (const listener of [...expiryListeners]) {
    try {
      listener();
    } catch {
      // One screen's listener must not block the others.
    }
  }
  // A relaunch from the login page would only discard its own state.
  let current: string | undefined;
  try {
    const stack = Taro.getCurrentPages();
    current = stack[stack.length - 1]?.route;
  } catch {
    current = undefined;
  }
  if (current && `/${current}` === LOGIN_PAGE) return;
  void Taro.reLaunch({ url: LOGIN_PAGE }).catch(() => undefined);
}

setUnauthorizedHandler(({ url, authorization }) => {
  if (ANONYMOUS_AUTH_PATHS.some((path) => url.includes(path))) return;
  const token = client.getToken();
  // Only the credential that actually failed expires; a newer login wins.
  if (!token || authorization !== `Bearer ${token}`) return;
  expireSession();
});

export function persistToken(token: string): void {
  expired = false;
  client.setToken(token);
  Taro.setStorageSync(TOKEN_KEY, token);
}

export function clearToken(): void {
  expired = false;
  client.setToken(null);
  Taro.removeStorageSync(TOKEN_KEY);
}

export function hasToken(): boolean {
  return Boolean(Taro.getStorageSync<string>(TOKEN_KEY));
}
