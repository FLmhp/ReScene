/**
 * Offline replay state machine shared by Android and the Mini Program.
 *
 * Platform modules only supply storage and the network handlers; ordering,
 * retry, and the conflict rule live here so both clients behave alike.
 */

export const QUEUE_PAUSED = "离线队列已暂停，请联网验证当前账户后重试。";
export const LEGACY_QUEUE_NOTICE = "设备上有旧版离线数据，账户归属无法确认。请在当前账户重新创建项目或添加所需素材。";

export type QueueCredential = { token: string; owner: string | null };
export type QueueOwner = { id: string; generation: number };
type SessionSnapshot = { token: string | null; generation: number };

export function accountQueueKey(prefix: string, owner: QueueOwner): string {
  return `${prefix}-${encodeURIComponent(owner.id).replace(/~/g, "%7E").replace(/%/g, "~")}`;
}

export function readQueueCredential(raw: string | null): QueueCredential | null {
  if (!raw) return null;
  if (!raw.startsWith("{")) return { token: raw, owner: null };
  try {
    const { token, owner } = JSON.parse(raw) as Partial<QueueCredential>;
    if (typeof token === "string" && token) {
      return { token, owner: typeof owner === "string" && owner.trim() ? owner : null };
    }
  } catch { /* Invalid local credentials require a fresh login. */ }
  return null;
}

export function createQueueSession(initial: QueueCredential | null = null) {
  let credential = initial;
  let generation = 0;
  const snapshot = (): SessionSnapshot => ({ token: credential?.token ?? null, generation });
  const matches = (value: SessionSnapshot) => value.generation === generation && value.token === (credential?.token ?? null);
  return {
    snapshot,
    matches,
    reset() {
      generation += 1;
      credential = null;
    },
    update(expected: SessionSnapshot, next: QueueCredential | null) {
      if (!matches(expected)) return false;
      if (credential?.owner && credential.owner !== next?.owner) generation += 1;
      credential = next;
      return true;
    },
    owner(): QueueOwner | null {
      return credential?.owner ? { id: credential.owner, generation } : null;
    },
    owns(owner: QueueOwner) {
      return owner.generation === generation && owner.id === credential?.owner;
    },
  };
}

/** Reads JWT expiry only for local scheduling and queue suspension. */
export function sessionExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const character of payload.replace(/-/g, "+").replace(/_/g, "/")) {
    if (character === "=") break;
    const value = alphabet.indexOf(character);
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  try {
    const claims = JSON.parse(output) as { exp?: unknown } | null;
    return typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export type QueuedUpload = {
  kind: "upload";
  id: string;
  projectId: string;
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  assetId?: string;
  createdAt: number;
};

export type QueuedProject = { kind: "project"; id: string; name: string; createdAt: number };

export type QueuedEntry = QueuedUpload | QueuedProject;

export type QueueHandlers = {
  createProject(name: string): Promise<void>;
  upload(entry: QueuedUpload, onProgress?: (percent: number) => void): Promise<void>;
};

export type ReplayResult = { remaining: QueuedEntry[]; created: number; uploaded: number; dropped: number };

function isEntry(value: unknown): value is QueuedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.createdAt !== "number") return false;
  if (entry.kind === "project") return typeof entry.name === "string";
  if (entry.kind === "upload") {
    return (
      typeof entry.projectId === "string" &&
      typeof entry.uri === "string" &&
      typeof entry.name === "string" &&
      typeof entry.mimeType === "string" &&
      typeof entry.size === "number"
    );
  }
  return false;
}

/** Storage may hold anything; a corrupt or older payload must not crash a launch. */
export function parseQueue(raw: string | null): QueuedEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function serializeQueue(entries: QueuedEntry[]): string {
  return JSON.stringify(entries);
}

/** A 409 means the server already owns this upload, so replaying it again cannot help. */
function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 409;
}

type ReplayCounts = Omit<ReplayResult, "remaining">;
type CompletedEntry = keyof ReplayCounts;

async function finishEntry(entry: QueuedEntry, handle: (entry: QueuedEntry) => Promise<void>): Promise<CompletedEntry> {
  try {
    await handle(entry);
    return entry.kind === "project" ? "created" : "uploaded";
  } catch (reason) {
    if (entry.kind === "upload" && isConflict(reason)) return "dropped";
    throw reason;
  }
}

export async function replayQueue(entries: QueuedEntry[], handlers: QueueHandlers): Promise<ReplayResult> {
  const result: ReplayResult = { remaining: [], created: 0, uploaded: 0, dropped: 0 };
  for (const entry of entries) {
    try {
      const outcome = await finishEntry(entry, (row) => row.kind === "project" ? handlers.createProject(row.name) : handlers.upload(row));
      result[outcome] += 1;
    } catch {
      result.remaining.push(entry);
    }
  }
  return result;
}

type QueueStorage = {
  read(owner: QueueOwner): Promise<QueuedEntry[]>;
  write(owner: QueueOwner, entries: QueuedEntry[]): Promise<void>;
  isCurrent(owner: QueueOwner): boolean;
};

type NativeUpload = (entry: QueuedUpload, rememberAsset: (assetId: string) => Promise<void>) => Promise<void>;
type EntryResult = CompletedEntry | "missing" | "busy";

class QueueStorageError extends Error {
  constructor(cause: unknown) {
    super("无法保存或读取本地离线队列，请检查设备存储后重试。", { cause });
  }
}

export function createNativeQueue(storage: QueueStorage) {
  const writes = new Map<string, Promise<void>>();
  const claimed = new Map<string, { generation: number; task: Promise<EntryResult> }>();
  const replaying = new Map<string, { generation: number; task: Promise<ReplayCounts> }>();

  function assertCurrent(owner: QueueOwner): void {
    if (!storage.isCurrent(owner)) throw new Error(QUEUE_PAUSED);
  }

  async function read(owner: QueueOwner): Promise<QueuedEntry[]> {
    try { return await storage.read(owner); }
    catch (reason) { throw new QueueStorageError(reason); }
  }

  function mutate(owner: QueueOwner, change: (entries: QueuedEntry[]) => QueuedEntry[]): Promise<void> {
    const previous = writes.get(owner.id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const entries = await read(owner);
      const next = change(entries);
      if (next === entries) return;
      try { await storage.write(owner, next); }
      catch (reason) { throw new QueueStorageError(reason); }
    }).finally(() => {
      if (writes.get(owner.id) === task) writes.delete(owner.id);
    });
    writes.set(owner.id, task);
    return task;
  }

  async function load(owner: QueueOwner): Promise<QueuedEntry[]> {
    await writes.get(owner.id)?.catch(() => undefined);
    return read(owner);
  }

  function enqueue(owner: QueueOwner, entry: QueuedEntry): Promise<void> {
    return mutate(owner, (entries) => {
      assertCurrent(owner);
      return entries.some((row) => row.id === entry.id) ? entries : [...entries, entry];
    });
  }

  function remove(owner: QueueOwner, id: string): Promise<void> {
    return mutate(owner, (entries) => entries.filter((row) => row.id !== id));
  }

  function remember(owner: QueueOwner, id: string, assetId: string): Promise<void> {
    return mutate(owner, (entries) => entries.map((row) => row.id === id && row.kind === "upload" ? { ...row, assetId } : row));
  }

  function runEntry(
    owner: QueueOwner,
    id: string,
    handle: (entry: QueuedEntry) => Promise<void>,
    skipClaimed: boolean,
  ): Promise<EntryResult> {
    const key = JSON.stringify([owner.id, id]);
    const existing = claimed.get(key);
    if (existing) {
      if (skipClaimed) return Promise.resolve("busy");
      if (existing.generation === owner.generation) return existing.task;
      return existing.task.catch(() => undefined).then(() => runEntry(owner, id, handle, skipClaimed));
    }

    const task = (async (): Promise<EntryResult> => {
      assertCurrent(owner);
      const entry = (await load(owner)).find((row) => row.id === id);
      if (!entry) return "missing";
      assertCurrent(owner);
      const outcome = await finishEntry(entry, handle);
      await remove(owner, id);
      return outcome;
    })().finally(() => { claimed.delete(key); });
    claimed.set(key, { generation: owner.generation, task });
    return task;
  }

  function upload(owner: QueueOwner, id: string, handle: NativeUpload): Promise<EntryResult> {
    return runEntry(owner, id, async (entry) => {
      if (entry.kind !== "upload") throw new Error("找不到待上传素材。");
      await handle(entry, (assetId) => remember(owner, entry.id, assetId));
    }, false);
  }

  async function replayOnce(owner: QueueOwner, handlers: { createProject: QueueHandlers["createProject"]; upload: NativeUpload }): Promise<ReplayCounts> {
    assertCurrent(owner);
    const ids = (await load(owner)).map((entry) => entry.id);
    const result = { created: 0, uploaded: 0, dropped: 0 };
    let storageError: QueueStorageError | undefined;
    for (const id of ids) {
      if (!storage.isCurrent(owner)) break;
      try {
        const outcome = await runEntry(owner, id, (entry) => entry.kind === "project"
          ? handlers.createProject(entry.name)
          : handlers.upload(entry, (assetId) => remember(owner, entry.id, assetId)), true);
        if (outcome !== "busy" && outcome !== "missing") result[outcome] += 1;
      } catch (reason) {
        if (reason instanceof QueueStorageError) storageError ??= reason;
      }
    }
    if (storageError) throw storageError;
    return result;
  }

  function replay(owner: QueueOwner, handlers: Parameters<typeof replayOnce>[1]): Promise<ReplayCounts> {
    const existing = replaying.get(owner.id);
    if (existing) {
      if (existing.generation === owner.generation) return existing.task;
      return existing.task.catch(() => undefined).then(() => replay(owner, handlers));
    }
    const task = replayOnce(owner, handlers).finally(() => { replaying.delete(owner.id); });
    replaying.set(owner.id, { generation: owner.generation, task });
    return task;
  }

  return { enqueue, load, replay, upload };
}
