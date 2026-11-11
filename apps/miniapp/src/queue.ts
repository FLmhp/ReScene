import type { ResceneClient } from "@rescene/api-client";
import {
  parseQueue,
  replayQueue,
  serializeQueue,
  type QueuedEntry,
  type QueuedUpload,
} from "@rescene/uploader";
import Taro from "@tarojs/taro";

import { uploadFile } from "./upload";

const QUEUE_KEY = "rescene-queue";

/** Storage is the only platform concern; the state machine lives in @rescene/uploader. */
export async function loadQueue(): Promise<QueuedEntry[]> {
  return parseQueue(Taro.getStorageSync<string>(QUEUE_KEY) || null);
}

export async function saveQueue(entries: QueuedEntry[]): Promise<void> {
  Taro.setStorageSync(QUEUE_KEY, serializeQueue(entries));
}

export async function enqueue(entry: QueuedEntry): Promise<void> {
  await saveQueue([...(await loadQueue()), entry]);
}

/**
 * Replay in enqueue order. The asset id of an interrupted upload is persisted
 * before its bytes move, so a later replay resumes the same asset row instead
 * of creating a duplicate.
 */
export async function replayQueued(
  client: ResceneClient,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<{ created: number; uploaded: number; dropped: number }> {
  const entries = await loadQueue();
  const result = await replayQueue(entries, {
    createProject: async (name) => {
      await client.createProject(name);
    },
    upload: async (entry, report) => {
      await uploadFile(
        client,
        entry.projectId,
        { path: entry.uri, name: entry.name, size: entry.size, contentType: entry.mimeType },
        (percent) => {
          report?.(percent);
          onProgress(entry, percent);
        },
        {
          assetId: entry.assetId,
          onAsset: (assetId) => {
            entry.assetId = assetId;
            void saveQueue(entries).catch(() => undefined);
          },
        },
      );
    },
  });
  await saveQueue(result.remaining);
  return { created: result.created, uploaded: result.uploaded, dropped: result.dropped };
}
