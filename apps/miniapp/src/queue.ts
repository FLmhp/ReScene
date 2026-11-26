import type { ResceneClient } from "@rescene/api-client";
import { accountQueueKey, createNativeQueue, parseQueue, QueuedMediaMissing, serializeQueue, type QueuedEntry, type QueuedUpload, type QueueOwner } from "@rescene/uploader";
import Taro from "@tarojs/taro";

import { isQueueOwnerCurrent, queueClient } from "./api";
import { managedMediaExists, persistChosenFile, removeManagedMedia, requireQueuedMedia, uploadFile } from "./upload";

const LEGACY_QUEUE_KEY = "rescene-queue";

export function hasLegacyQueue(): boolean {
  try { return Taro.getStorageInfoSync().keys.includes(LEGACY_QUEUE_KEY); }
  catch { return false; }
}

function writeQueue(owner: QueueOwner, entries: QueuedEntry[]): void {
  Taro.setStorageSync(accountQueueKey(LEGACY_QUEUE_KEY, owner), serializeQueue(entries));
}

/** Entries queued before managed copies existed still point at temporary files. */
function adoptLegacyMedia(owner: QueueOwner, entries: QueuedEntry[]): QueuedEntry[] {
  let changed = false;
  const adopted = entries.map((entry): QueuedEntry => {
    if (entry.kind !== "upload" || entry.managed === true || !managedMediaExists(entry.uri)) return entry;
    try {
      const stored = persistChosenFile(owner, entry.id, {
        path: entry.uri,
        name: entry.name,
        size: entry.size,
        contentType: entry.mimeType,
      });
      changed = true;
      return { ...entry, uri: stored.path, size: stored.size, managed: true };
    } catch {
      return entry;
    }
  });
  if (changed) writeQueue(owner, adopted);
  return adopted;
}

const queue = createNativeQueue({
  async read(owner) {
    return adoptLegacyMedia(owner, parseQueue(Taro.getStorageSync<string>(accountQueueKey(LEGACY_QUEUE_KEY, owner)) || null));
  },
  async write(owner, entries) {
    writeQueue(owner, entries);
  },
  isCurrent: isQueueOwnerCurrent,
}, {
  onDropped: (entry) => { if (entry.managed) removeManagedMedia(entry.uri); },
});

export const enqueue = queue.enqueue;

export async function discardQueued(owner: QueueOwner, id: string): Promise<void> {
  const entry = (await queue.load(owner)).find((row) => row.id === id);
  await queue.discard(owner, id);
  if (entry?.kind === "upload" && entry.managed) removeManagedMedia(entry.uri);
}

function transfer(owner: QueueOwner, client: ResceneClient, onProgress: (entry: QueuedUpload, percent: number) => void) {
  return async (entry: QueuedUpload, onAsset: (assetId: string) => Promise<void>) => {
    requireQueuedMedia(entry.uri);
    await uploadFile(
      owner,
      client,
      entry.projectId,
      { path: entry.uri, name: entry.name, size: entry.size, contentType: entry.mimeType },
      (percent) => onProgress(entry, percent),
      { assetId: entry.assetId, onAsset },
    );
    if (entry.managed) removeManagedMedia(entry.uri);
  };
}

export async function uploadQueued(owner: QueueOwner, id: string, onProgress: (percent: number) => void): Promise<void> {
  await queue.upload(owner, id, transfer(owner, queueClient(owner), (_, percent) => onProgress(percent)));
}

export function replayQueued(owner: QueueOwner, onProgress: (entry: QueuedUpload, percent: number) => void) {
  const client = queueClient(owner);
  return queue.replay(owner, {
    createProject: async (name, idempotencyKey) => { await client.createProject(name, idempotencyKey); },
    upload: transfer(owner, client, onProgress),
  });
}

export { QueuedMediaMissing };
