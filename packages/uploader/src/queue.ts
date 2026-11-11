/**
 * Offline replay state machine shared by Android and the Mini Program.
 *
 * Platform modules only supply storage and the network handlers; ordering,
 * retry, and the conflict rule live here so both clients behave alike.
 */

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
