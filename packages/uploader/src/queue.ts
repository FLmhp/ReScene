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

/**
 * Replay in enqueue order. One failing entry never blocks the ones behind it:
 * projects that fail and uploads that fail for network reasons stay queued.
 */
export async function replayQueue(entries: QueuedEntry[], handlers: QueueHandlers): Promise<ReplayResult> {
  const remaining: QueuedEntry[] = [];
  let created = 0;
  let uploaded = 0;
  let dropped = 0;
  for (const entry of entries) {
    try {
      if (entry.kind === "project") {
        await handlers.createProject(entry.name);
        created += 1;
      } else {
        await handlers.upload(entry);
        uploaded += 1;
      }
    } catch (error) {
      if (entry.kind === "upload" && isConflict(error)) {
        dropped += 1;
        continue;
      }
      remaining.push(entry);
    }
  }
  return { remaining, created, uploaded, dropped };
}
