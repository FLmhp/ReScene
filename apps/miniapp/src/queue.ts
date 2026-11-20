import {
  accountQueueKey,
  parseQueue,
  replayQueue,
  serializeQueue,
  type QueuedEntry,
  type QueuedUpload,
  type QueueOwner,
} from "@rescene/uploader";
import Taro from "@tarojs/taro";

import { assertQueueOwner, isQueueOwnerCurrent, queueClient } from "./api";
import { uploadFile } from "./upload";

const LEGACY_QUEUE_KEY = "rescene-queue";

export function hasLegacyQueue(): boolean {
  try { return Taro.getStorageInfoSync().keys.includes(LEGACY_QUEUE_KEY); }
  catch { return false; }
}

/** Storage is the only platform concern; the state machine lives in @rescene/uploader. */
export async function loadQueue(owner: QueueOwner): Promise<QueuedEntry[]> {
  return parseQueue(Taro.getStorageSync<string>(accountQueueKey(LEGACY_QUEUE_KEY, owner)) || null);
}

export async function saveQueue(owner: QueueOwner, entries: QueuedEntry[]): Promise<void> {
  Taro.setStorageSync(accountQueueKey(LEGACY_QUEUE_KEY, owner), serializeQueue(entries));
}

export async function enqueue(owner: QueueOwner, entry: QueuedEntry): Promise<void> {
  assertQueueOwner(owner);
  const entries = await loadQueue(owner);
  assertQueueOwner(owner);
  await saveQueue(owner, [...entries, entry]);
}

/**
 * Replay in enqueue order. The asset id of an interrupted upload is persisted
 * before its bytes move, so a later replay resumes the same asset row instead
 * of creating a duplicate.
 */
export async function replayQueued(
  owner: QueueOwner,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<{ created: number; uploaded: number; dropped: number }> {
  const client = queueClient(owner);
  const entries = await loadQueue(owner);
  const result = await replayQueue(entries, {
    createProject: async (name) => {
      await client.createProject(name);
    },
    upload: async (entry, report) => {
      await uploadFile(
        owner,
        client,
        entry.projectId,
        { path: entry.uri, name: entry.name, size: entry.size, contentType: entry.mimeType },
        (percent) => {
          report?.(percent);
          onProgress(entry, percent);
        },
        {
          assetId: entry.assetId,
          onAsset: async (assetId) => {
            entry.assetId = assetId;
            const stored = await loadQueue(owner);
            await saveQueue(owner, stored.map((item) => item.kind === "upload" && item.id === entry.id ? { ...item, assetId } : item));
          },
        },
      );
    },
  });
  if (isQueueOwnerCurrent(owner)) await saveQueue(owner, result.remaining);
  return { created: result.created, uploaded: result.uploaded, dropped: result.dropped };
}
