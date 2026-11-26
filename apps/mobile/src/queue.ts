import type { ResceneClient } from "@rescene/api-client";
import { accountQueueKey, createNativeQueue, parseQueue, QueuedMediaMissing, serializeQueue, type QueuedEntry, type QueuedUpload, type QueueOwner } from "@rescene/uploader";
import * as FileSystem from "expo-file-system/legacy";

import { isQueueOwnerCurrent, queueClient } from "./api";
import { clearOrphanUploadBodies, managedMediaExists, persistPickedFile, removeManagedMedia, requireQueuedMedia, uploadFile } from "./upload";

// Cache sweeps run before any upload this launch, so a killed process cannot
// leave whole-file bodies behind across sessions.
clearOrphanUploadBodies();

const LEGACY_QUEUE_FILE = `${FileSystem.documentDirectory}rescene-queue.json`;

function queueFile(owner: QueueOwner): string {
  return FileSystem.documentDirectory + accountQueueKey("rescene-queue", owner) + ".json";
}

export async function hasLegacyQueue(): Promise<boolean> {
  return (await FileSystem.getInfoAsync(LEGACY_QUEUE_FILE)).exists;
}

async function writeQueue(owner: QueueOwner, entries: QueuedEntry[]): Promise<void> {
  const file = queueFile(owner);
  const temporary = file + ".tmp";
  try {
    await FileSystem.writeAsStringAsync(temporary, serializeQueue(entries));
    await FileSystem.moveAsync({ from: temporary, to: file });
  } catch (reason) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    throw reason;
  }
}

/** Entries queued before managed copies existed still point at picker temporaries. */
async function adoptLegacyMedia(owner: QueueOwner, entries: QueuedEntry[]): Promise<QueuedEntry[]> {
  let changed = false;
  const adopted: QueuedEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "upload" || entry.managed === true) {
      adopted.push(entry);
      continue;
    }
    if (!(await managedMediaExists(entry.uri))) {
      adopted.push(entry);
      continue;
    }
    try {
      const stored = await persistPickedFile(owner, entry.id, {
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
      });
      adopted.push({ ...entry, uri: stored.uri, size: stored.size, managed: true });
      changed = true;
    } catch {
      adopted.push(entry);
    }
  }
  if (changed) await writeQueue(owner, adopted);
  return adopted;
}

const queue = createNativeQueue({
  async read(owner) {
    const file = queueFile(owner);
    if (!(await FileSystem.getInfoAsync(file)).exists) return [];
    return adoptLegacyMedia(owner, parseQueue(await FileSystem.readAsStringAsync(file)));
  },
  write: writeQueue,
  isCurrent: isQueueOwnerCurrent,
}, {
  onDropped: async (entry) => { if (entry.managed) await removeManagedMedia(entry.uri); },
});

export const enqueue = queue.enqueue;
export const discard = queue.discard;

export async function discardQueued(owner: QueueOwner, id: string): Promise<void> {
  const entry = (await queue.load(owner)).find((row) => row.id === id);
  await queue.discard(owner, id);
  if (entry?.kind === "upload" && entry.managed) await removeManagedMedia(entry.uri);
}

function transfer(owner: QueueOwner, client: ResceneClient, onProgress: (entry: QueuedUpload, percent: number) => void) {
  return async (entry: QueuedUpload, onAsset: (assetId: string) => Promise<void>) => {
    await requireQueuedMedia(entry.uri);
    await uploadFile(
      owner,
      client,
      entry.projectId,
      { uri: entry.uri, name: entry.name, mimeType: entry.mimeType, size: entry.size },
      (percent) => onProgress(entry, percent),
      { assetId: entry.assetId, onAsset },
    );
    if (entry.managed) await removeManagedMedia(entry.uri);
  };
}

export async function uploadQueued(owner: QueueOwner, id: string, onProgress: (percent: number) => void): Promise<void> {
  await queue.upload(owner, id, transfer(owner, queueClient(owner), (_, percent) => onProgress(percent)));
}

export { QueuedMediaMissing };

export function replayQueued(owner: QueueOwner, onProgress: (entry: QueuedUpload, percent: number) => void) {
  const client = queueClient(owner);
  return queue.replay(owner, {
    createProject: async (name, idempotencyKey) => { await client.createProject(name, idempotencyKey); },
    upload: transfer(owner, client, onProgress),
  });
}
