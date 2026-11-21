import { ResceneApiError, ResceneClient } from "@rescene/api-client";
import {
  createQueueSession, QUEUE_PAUSED, readQueueCredential, sessionExpiry,
  type QueueCredential, type QueueOwner,
} from "@rescene/uploader";
import * as SecureStore from "expo-secure-store";

export { sessionExpiry };

const TOKEN_KEY = "rescene-token";
const RENEW_BEFORE_MS = 60_000;

export const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? "https://api.rescene.xyz";
export const webBaseUrl = process.env.EXPO_PUBLIC_WEB_URL ?? "https://app.rescene.xyz";

const session = createQueueSession();
type Snapshot = ReturnType<typeof session.snapshot>;
const expiryListeners = new Set<() => void>();

function sessionFetch(expected: Snapshot, owner?: QueueOwner): typeof fetch {
  return async (input, init) => {
    if (owner) assertQueueOwner(owner);
    const request = fetch(input, init);
    let response: Response;
    try {
      response = await request;
    } catch (error) {
      if (!owner) throw error;
      const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
      const aborted = error && typeof error === "object" && "name" in error && error.name === "AbortError";
      if (signal?.aborted || aborted) throw error;
      // Expo rejects failed native requests with FetchError, which is not a TypeError.
      throw new ResceneApiError(0, "网络连接失败，请检查网络后重试。");
    }
    if (response.status === 401 && expected.token && session.matches(expected)) {
      void discardSession().catch(() => undefined);
      for (const listener of expiryListeners) listener();
    }
    return response;
  };
}

export const client = new ResceneClient(apiBaseUrl, null, (input, init) => sessionFetch(session.snapshot())(input, init));

export type RestoredSession = "signed-in" | "signed-out" | "offline" | null;

export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => { expiryListeners.delete(listener); };
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

let storageWrite: Promise<unknown> = Promise.resolve();

function persistCredential(expected: Snapshot, next: QueueCredential): Promise<boolean> {
  const write = storageWrite.catch(() => undefined).then(async () => {
    if (!session.matches(expected)) return false;
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
    if (!session.update(expected, next)) return false;
    client.setToken(next.token);
    return true;
  });
  storageWrite = write;
  return write;
}

export function discardSession(): Promise<void> {
  session.reset();
  client.setToken(null);
  // An older in-flight storage write must settle before the durable binding is removed.
  const write = storageWrite.catch(() => undefined).then(() => SecureStore.deleteItemAsync(TOKEN_KEY));
  storageWrite = write;
  return write;
}

export async function authenticate(mode: "login" | "register", email: string, password: string): Promise<boolean> {
  const clearing = discardSession();
  const expected = session.snapshot();
  await clearing;
  if (!session.matches(expected)) return false;
  const auth = new ResceneClient(apiBaseUrl);
  const { access_token: token } = await auth[mode](email, password);
  if (!session.matches(expected)) return false;
  const user = await auth.getMe();
  return persistCredential(expected, { token, owner: user.id });
}

export async function changeSessionPassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const expected = session.snapshot();
  const owner = session.owner();
  const auth = new ResceneClient(apiBaseUrl, expected.token, sessionFetch(expected));
  const result = await auth.changePassword(currentPassword, newPassword);
  return persistCredential(expected, { token: result.access_token, owner: owner?.id ?? null });
}

async function endRestore(): Promise<RestoredSession> {
  const clearing = discardSession();
  const expected = session.snapshot();
  await clearing;
  return session.matches(expected) ? "signed-out" : null;
}

async function restoreSessionOnce(expected: Snapshot): Promise<RestoredSession> {
  if (!expected.token) {
    if (expected.generation !== 0) return null;
    const credential = readQueueCredential(await SecureStore.getItemAsync(TOKEN_KEY));
    if (!session.matches(expected)) return null;
    if (!credential) return "signed-out";
    session.update(expected, credential);
    client.setToken(credential.token);
    expected = session.snapshot();
  }
  const token = expected.token;
  if (!token) return "signed-out";
  const expiry = sessionExpiry(token);
  if (expiry !== null && expiry <= Date.now()) {
    return endRestore();
  }

  const auth = new ResceneClient(apiBaseUrl, token, sessionFetch(expected));
  try {
    const user = await auth.getMe();
    if (!session.matches(expected)) return null;
    const shouldRenew = expiry !== null && expiry - Date.now() <= RENEW_BEFORE_MS;
    const renewed = shouldRenew ? await auth.refresh() : null;
    if (!renewed && session.owns({ id: user.id, generation: expected.generation })) return "signed-in";
    return await persistCredential(expected, { token: renewed?.access_token ?? token, owner: user.id })
      ? "signed-in" : null;
  } catch (error) {
    if (!session.matches(expected)) return null;
    if (error instanceof ResceneApiError && (error.status === 401 || error.status === 403)) {
      return endRestore();
    }
    return "offline";
  }
}

let inFlightRestore: { generation: number; task: Promise<RestoredSession> } | undefined;

export function restoreSession(): Promise<RestoredSession> {
  const expected = session.snapshot();
  if (inFlightRestore?.generation === expected.generation) return inFlightRestore.task;
  const task = restoreSessionOnce(expected).finally(() => {
    if (inFlightRestore?.task === task) inFlightRestore = undefined;
  });
  inFlightRestore = { generation: expected.generation, task };
  return task;
}

export type LogoutResult = { revoked: boolean; cleared: boolean };

export async function clearSession(): Promise<LogoutResult> {
  const auth = new ResceneClient(apiBaseUrl, session.snapshot().token);
  const clearing = discardSession();
  const [revoked, cleared] = await Promise.all([
    auth.logout().then(() => true, () => false),
    clearing.then(() => true, () => false),
  ]);
  return { revoked, cleared };
}
