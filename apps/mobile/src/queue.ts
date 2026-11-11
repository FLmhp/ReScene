import type { ResceneClient } from "@rescene/api-client";
import { parseQueue, type QueuedEntry, type QueuedUpload, replayQueue, serializeQueue } from "@rescene/uploader";
import * as FileSystem from "expo-file-system/legacy";

import { uploadFile } from "./upload";

const QUEUE_FILE = `${FileSystem.documentDirectory}rescene-queue.json`;

export type ReplaySummary = { created: number; uploaded: number; dropped: number };

/** A missing or unreadable queue file is an empty queue, never a launch failure. */
export async function loadQueue(): Promise<QueuedEntry[]> {
  try {
    return parseQueue(await FileSystem.readAsStringAsync(QUEUE_FILE));
  } catch {
    return [];
  }
}

export async function saveQueue(entries: QueuedEntry[]): Promise<void> {
  await FileSystem.writeAsStringAsync(QUEUE_FILE, serializeQueue(entries));
}

export async function enqueue(entry: QueuedEntry): Promise<void> {
  const entries = await loadQueue();
  entries.push(entry);
  await saveQueue(entries);
}

async function rememberAsset(id: string, assetId: string): Promise<void> {
  const entries = await loadQueue();
  await saveQueue(entries.map((entry) => (entry.kind === "upload" && entry.id === id ? { ...entry, assetId } : entry)));
}

/** Retried uploads reuse their asset id, so a dropped connection cannot create a second asset. */
async function replayOnce(
  client: ResceneClient,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<ReplaySummary> {
  const result = await replayQueue(await loadQueue(), {
    createProject: async (name) => {
      await client.createProject(name);
    },
    upload: async (entry, progress) => {
      await uploadFile(
        client,
        entry.projectId,
        { uri: entry.uri, name: entry.name, mimeType: entry.mimeType, size: entry.size },
        (percent) => {
          progress?.(percent);
          onProgress(entry, percent);
        },
        {
          assetId: entry.assetId,
          onAsset: async (assetId) => {
            entry.assetId = assetId;
            await rememberAsset(entry.id, assetId);
          },
        },
      );
    },
  });
  await saveQueue(result.remaining);
  return { created: result.created, uploaded: result.uploaded, dropped: result.dropped };
}

let inFlightReplay: Promise<ReplaySummary> | null = null;

/** Single-flight so a mount and a foreground event cannot upload the same entry twice. */
export function replayQueued(
  client: ResceneClient,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<ReplaySummary> {
  if (!inFlightReplay) {
    inFlightReplay = replayOnce(client, onProgress).finally(() => {
      inFlightReplay = null;
    });
  }
  return inFlightReplay;
}
