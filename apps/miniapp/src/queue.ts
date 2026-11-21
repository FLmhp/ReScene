import type { ResceneClient } from "@rescene/api-client";
import { accountQueueKey, createNativeQueue, parseQueue, serializeQueue, type QueuedUpload, type QueueOwner } from "@rescene/uploader";
import Taro from "@tarojs/taro";

import { isQueueOwnerCurrent, queueClient } from "./api";
import { uploadFile } from "./upload";

const LEGACY_QUEUE_KEY = "rescene-queue";

export function hasLegacyQueue(): boolean {
  try { return Taro.getStorageInfoSync().keys.includes(LEGACY_QUEUE_KEY); }
  catch { return false; }
}

const queue = createNativeQueue({
  async read(owner) {
    return parseQueue(Taro.getStorageSync<string>(accountQueueKey(LEGACY_QUEUE_KEY, owner)) || null);
  },
  async write(owner, entries) {
    Taro.setStorageSync(accountQueueKey(LEGACY_QUEUE_KEY, owner), serializeQueue(entries));
  },
  isCurrent: isQueueOwnerCurrent,
});

export const enqueue = queue.enqueue;

function transfer(owner: QueueOwner, client: ResceneClient, onProgress: (entry: QueuedUpload, percent: number) => void) {
  return (entry: QueuedUpload, onAsset: (assetId: string) => Promise<void>) => uploadFile(
    owner,
    client,
    entry.projectId,
    { path: entry.uri, name: entry.name, size: entry.size, contentType: entry.mimeType },
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
    createProject: async (name) => { await client.createProject(name); },
    upload: transfer(owner, client, onProgress),
  });
}
