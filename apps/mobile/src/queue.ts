import type { ResceneClient } from "@rescene/api-client";
import { accountQueueKey, createNativeQueue, parseQueue, serializeQueue, type QueuedUpload, type QueueOwner } from "@rescene/uploader";
import * as FileSystem from "expo-file-system/legacy";

import { isQueueOwnerCurrent, queueClient } from "./api";
import { uploadFile } from "./upload";

const LEGACY_QUEUE_FILE = `${FileSystem.documentDirectory}rescene-queue.json`;

function queueFile(owner: QueueOwner): string {
  return FileSystem.documentDirectory + accountQueueKey("rescene-queue", owner) + ".json";
}

export async function hasLegacyQueue(): Promise<boolean> {
  return (await FileSystem.getInfoAsync(LEGACY_QUEUE_FILE)).exists;
}

const queue = createNativeQueue({
  async read(owner) {
    const file = queueFile(owner);
    if (!(await FileSystem.getInfoAsync(file)).exists) return [];
    return parseQueue(await FileSystem.readAsStringAsync(file));
  },
  async write(owner, entries) {
    const file = queueFile(owner);
    const temporary = file + ".tmp";
    try {
      await FileSystem.writeAsStringAsync(temporary, serializeQueue(entries));
      await FileSystem.moveAsync({ from: temporary, to: file });
    } catch (reason) {
      await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
      throw reason;
    }
  },
  isCurrent: isQueueOwnerCurrent,
});

export const enqueue = queue.enqueue;

function transfer(owner: QueueOwner, client: ResceneClient, onProgress: (entry: QueuedUpload, percent: number) => void) {
  return (entry: QueuedUpload, onAsset: (assetId: string) => Promise<void>) => uploadFile(
    owner,
    client,
    entry.projectId,
    { uri: entry.uri, name: entry.name, mimeType: entry.mimeType, size: entry.size },
    (percent) => onProgress(entry, percent),
    { assetId: entry.assetId, onAsset },
  ).then(() => undefined);
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
