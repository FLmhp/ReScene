import { ResceneApiError, ResceneClient } from "@rescene/api-client";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "rescene-token";
const RENEW_BEFORE_MS = 60_000;

export const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? "https://api.rescene.xyz";
export const webBaseUrl = process.env.EXPO_PUBLIC_WEB_URL ?? "https://app.rescene.xyz";

export const client = new ResceneClient(apiBaseUrl);

export type RestoredSession = "signed-in" | "signed-out" | "offline";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Minimal base64url decoder: React Native has no guaranteed global `atob`. */
function decodeBase64Url(input: string): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const character of input.replace(/-/g, "+").replace(/_/g, "/")) {
    if (character === "=") break;
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

/** Reads the JWT `exp` claim without trusting it for authorization; null means opaque/undecodable. */
export function sessionExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    if (typeof claims !== "object" || claims === null || !("exp" in claims)) return null;
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function discardSession(): Promise<void> {
  client.setToken(null);
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function restoreSessionOnce(): Promise<RestoredSession> {
  const token = client.getToken() ?? (await SecureStore.getItemAsync(TOKEN_KEY));
  if (!token) return "signed-out";
  client.setToken(token);

  const expiry = sessionExpiry(token);
  if (expiry !== null && expiry <= Date.now()) {
    await discardSession();
    return "signed-out";
  }

  if (expiry !== null && expiry - Date.now() <= RENEW_BEFORE_MS) {
    try {
      const renewed = await client.refresh();
      await persistSession(renewed.access_token);
    } catch (error) {
      if (error instanceof ResceneApiError && (error.status === 401 || error.status === 403)) {
        await discardSession();
        return "signed-out";
      }
      // Renewal is best-effort; the current token may still validate below.
    }
  }

  try {
    await client.getMe();
    return "signed-in";
  } catch (error) {
    if (error instanceof ResceneApiError && (error.status === 401 || error.status === 403)) {
      await discardSession();
      return "signed-out";
    }
    return "offline";
  }
}

let inFlightRestore: Promise<RestoredSession> | null = null;

/**
 * Restores the stored credential, renews it when it is close to expiry, and
 * verifies it with `getMe`. Network failure keeps the credential (offline);
 * a rejected credential is discarded (signed-out). Concurrent callers share
 * one validation/renewal so app-resume races cannot double-refresh.
 */
export function restoreSession(): Promise<RestoredSession> {
  if (!inFlightRestore) {
    inFlightRestore = restoreSessionOnce().finally(() => {
      inFlightRestore = null;
    });
  }
  return inFlightRestore;
}

export async function persistSession(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    client.setToken(token);
  } catch (error) {
    client.setToken(null);
    throw error;
  }
}

export type LogoutResult = { revoked: boolean; cleared: boolean };

/** Best-effort server revocation; local credentials are always removed when the device allows it. */
export async function clearSession(): Promise<LogoutResult> {
  let revoked = false;
  try {
    await client.logout();
    revoked = true;
  } catch {
    revoked = false;
  }
  let cleared = false;
  try {
    await discardSession();
    cleared = true;
  } catch {
    cleared = false;
  }
  return { revoked, cleared };
}
