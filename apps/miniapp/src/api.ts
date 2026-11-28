import { miniappFetch } from "./polyfill";

import { ResceneClient } from "@rescene/api-client";
import {
  createQueueSession, QUEUE_PAUSED, readQueueCredential, sessionExpiry,
  type QueueCredential, type QueueOwner,
} from "@rescene/uploader";
import Taro from "@tarojs/taro";
import { HOME_PAGE, openHome } from "./navigation";

const TOKEN_KEY = "rescene-token";
const EXPIRY_NOTICE_KEY = "rescene-session-expired";

export const apiBaseUrl = process.env.TARO_APP_API_URL;
export const webBaseUrl = process.env.TARO_APP_WEB_URL;

function storedCredential(): QueueCredential | null {
  try { return readQueueCredential(Taro.getStorageSync<string>(TOKEN_KEY) || null); }
  catch { return null; }
}

const session = createQueueSession(storedCredential());
type Snapshot = ReturnType<typeof session.snapshot>;

// A stored token only hints at a session. Appearance and other signed-in
// surfaces stay anonymous until this process has confirmed the credential with
// the server (login, recovery, or an authenticated token rotation for a known
// owner). The session generation changes whenever that owner changes, so a
// snapshot match keeps the verified flag bound to the active credential.
let verifiedSession: Snapshot | null = null;
const sessionListeners = new Set<() => void>();

function sessionFetch(expected: Snapshot, owner?: QueueOwner): typeof fetch {
  return async (input, init) => {
    if (owner) assertQueueOwner(owner);
    const response = await miniappFetch(input, init);
    if (response.status === 401 && expected.token && session.matches(expected)) expireSession();
    return response;
  };
}

export const client = new ResceneClient(apiBaseUrl, session.snapshot().token, (input, init) => sessionFetch(session.snapshot())(input, init));

const expiryListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => { expiryListeners.delete(listener); };
}

function notifySessionChange(): void {
  for (const listener of [...sessionListeners]) {
    try { listener(); } catch { /* One screen must not block the others. */ }
  }
}

/** Subscribe to verified-session changes that affect shared signed-in rendering. */
export function onSessionChange(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

export function hasVerifiedSession(): boolean {
  const snapshot = session.snapshot();
  return Boolean(
    verifiedSession
    && snapshot.token
    && session.matches(verifiedSession)
    && (sessionExpiry(snapshot.token) ?? Infinity) > Date.now(),
  );
}

function markSessionVerified(ownerId: string | null | undefined): void {
  const snapshot = session.snapshot();
  if (!ownerId || !snapshot.token) return;
  verifiedSession = snapshot;
  notifySessionChange();
}

function clearVerifiedSession(): void {
  if (!verifiedSession) return;
  verifiedSession = null;
  notifySessionChange();
}

function expireSession(): void {
  try {
    clearToken();
    Taro.setStorageSync(EXPIRY_NOTICE_KEY, "1");
  } catch { /* The local in-memory session was already ended. */ }
  for (const listener of [...expiryListeners]) {
    try { listener(); } catch { /* One screen must not block the others. */ }
  }
  let current: string | undefined;
  try {
    const stack = Taro.getCurrentPages();
    current = stack[stack.length - 1]?.route;
  } catch {
    current = undefined;
  }
  if (current && `/${current}` === HOME_PAGE) return;
  void openHome().catch(() => undefined);
}

function persistCredential(expected: Snapshot, next: QueueCredential): boolean {
  if (!session.matches(expected)) return false;
  Taro.setStorageSync(TOKEN_KEY, JSON.stringify(next));
  session.update(expected, next);
  client.setToken(next.token);
  return true;
}

function clearToken(): void {
  session.reset();
  client.setToken(null);
  clearVerifiedSession();
  Taro.removeStorageSync(TOKEN_KEY);
}

export function hasToken(): boolean {
  return Boolean(session.snapshot().token);
}

export function currentQueueOwner(): QueueOwner | null {
  const { token } = session.snapshot();
  return token && (sessionExpiry(token) ?? Infinity) > Date.now() ? session.owner() : null;
}

export function isQueueOwnerCurrent(owner: QueueOwner): boolean {
  return session.owns(owner) && currentQueueOwner() !== null;
}

export function assertQueueOwner(owner: QueueOwner): void {
  if (!isQueueOwnerCurrent(owner)) throw new Error(QUEUE_PAUSED);
}

export function queueClient(owner: QueueOwner): ResceneClient {
  assertQueueOwner(owner);
  const expected = session.snapshot();
  return new ResceneClient(apiBaseUrl, expected.token, sessionFetch(expected, owner));
}

async function establishSession(action: (auth: ResceneClient) => Promise<{ access_token: string }>) {
  clearToken();
  const expected = session.snapshot();
  const auth = new ResceneClient(apiBaseUrl, null, miniappFetch);
  try {
    const { access_token: token } = await action(auth);
    if (!session.matches(expected)) return null;
    const user = await auth.getMe();
    if (!persistCredential(expected, { token, owner: user.id })) return null;
    markSessionVerified(user.id);
    return user;
  } catch (reason) {
    if (session.matches(expected)) throw reason;
    return null;
  }
}

export function authenticate(mode: "login" | "register", identifier: string, password: string) {
  // Login accepts either an email or a username; register still requires an email.
  return establishSession((auth) => auth[mode](identifier, password));
}

export async function sendEmailCode(email: string, purpose: "login" | "reset"): Promise<void> {
  const auth = new ResceneClient(apiBaseUrl, null, miniappFetch);
  await auth.requestEmailCode(email, purpose);
}

export function authenticateWithCode(email: string, code: string) {
  return establishSession((auth) => auth.loginWithEmailCode(email, code));
}

export function resetPasswordWithCode(email: string, code: string, newPassword: string) {
  return establishSession((auth) => auth.resetPasswordWithEmailCode(email, code, newPassword));
}

export async function verifySession() {
  const expected = session.snapshot();
  const token = expected.token;
  if (!token) return null;
  const expiry = sessionExpiry(token);
  if (expiry !== null && expiry <= Date.now()) {
    expireSession();
    return null;
  }
  const auth = new ResceneClient(apiBaseUrl, token, sessionFetch(expected));
  try {
    const user = await auth.getMe();
    if (!session.matches(expected)) return null;
    if (!session.owns({ id: user.id, generation: expected.generation })) {
      if (!persistCredential(expected, { token, owner: user.id })) return null;
    }
    markSessionVerified(user.id);
    return user;
  } catch (reason) {
    if (session.matches(expected)) throw reason;
    return null;
  }
}

async function rotateToken(action: (auth: ResceneClient) => Promise<{ access_token: string }>): Promise<boolean> {
  const expected = session.snapshot();
  const owner = session.owner();
  const auth = new ResceneClient(apiBaseUrl, expected.token, sessionFetch(expected));
  try {
    const result = await action(auth);
    if (!persistCredential(expected, { token: result.access_token, owner: owner?.id ?? null })) return false;
    markSessionVerified(owner?.id);
    return true;
  } catch (reason) {
    if (session.matches(expected)) throw reason;
    return false;
  }
}

export function renewSession(): Promise<boolean> {
  return rotateToken((auth) => auth.refresh());
}

export function changeSessionPassword(currentPassword: string, newPassword: string): Promise<boolean> {
  return rotateToken((auth) => auth.changePassword(currentPassword, newPassword));
}

export async function signOutSession(): Promise<boolean> {
  const auth = new ResceneClient(apiBaseUrl, session.snapshot().token, miniappFetch);
  let cleared = true;
  try { clearToken(); } catch { cleared = false; }
  try { await auth.logout(); return cleared; } catch { return false; }
}
