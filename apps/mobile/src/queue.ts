import { accountQueueKey, parseQueue, type QueuedEntry, type QueuedUpload, type QueueOwner, replayQueue, serializeQueue } from "@rescene/uploader";
import * as FileSystem from "expo-file-system/legacy";

import { assertQueueOwner, isQueueOwnerCurrent, queueClient } from "./api";
import { uploadFile } from "./upload";

const LEGACY_QUEUE_FILE = `${FileSystem.documentDirectory}rescene-queue.json`;

function queueFile(owner: QueueOwner): string {
  return FileSystem.documentDirectory + accountQueueKey("rescene-queue", owner) + ".json";
}

export async function hasLegacyQueue(): Promise<boolean> {
  return (await FileSystem.getInfoAsync(LEGACY_QUEUE_FILE)).exists;
}

export type ReplaySummary = { created: number; uploaded: number; dropped: number };

/** A missing or unreadable queue file is an empty queue, never a launch failure. */
export async function loadQueue(owner: QueueOwner): Promise<QueuedEntry[]> {
  try {
    return parseQueue(await FileSystem.readAsStringAsync(queueFile(owner)));
  } catch {
    return [];
  }
}

export async function saveQueue(owner: QueueOwner, entries: QueuedEntry[]): Promise<void> {
  await FileSystem.writeAsStringAsync(queueFile(owner), serializeQueue(entries));
}

export async function enqueue(owner: QueueOwner, entry: QueuedEntry): Promise<void> {
  assertQueueOwner(owner);
  const entries = await loadQueue(owner);
  assertQueueOwner(owner);
  await saveQueue(owner, [...entries, entry]);
}

async function rememberAsset(owner: QueueOwner, id: string, assetId: string): Promise<void> {
  const entries = await loadQueue(owner);
  await saveQueue(owner, entries.map((entry) => (entry.kind === "upload" && entry.id === id ? { ...entry, assetId } : entry)));
}

/** Retried uploads reuse their asset id, so a dropped connection cannot create a second asset. */
async function replayOnce(
  owner: QueueOwner,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<ReplaySummary> {
  const client = queueClient(owner);
  const result = await replayQueue(await loadQueue(owner), {
    createProject: async (name) => {
      await client.createProject(name);
    },
    upload: async (entry, progress) => {
      await uploadFile(
        owner,
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
            await rememberAsset(owner, entry.id, assetId);
          },
        },
      );
    },
  });
  if (isQueueOwnerCurrent(owner)) await saveQueue(owner, result.remaining);
  return { created: result.created, uploaded: result.uploaded, dropped: result.dropped };
}

let inFlightReplay: { owner: QueueOwner; task: Promise<ReplaySummary> } | undefined;

/** Single-flight so a mount and a foreground event cannot upload the same entry twice. */
export function replayQueued(
  owner: QueueOwner,
  onProgress: (entry: QueuedUpload, percent: number) => void,
): Promise<ReplaySummary> {
  assertQueueOwner(owner);
  if (inFlightReplay?.owner.id === owner.id && inFlightReplay.owner.generation === owner.generation) {
    return inFlightReplay.task;
  }
  const task = replayOnce(owner, onProgress).finally(() => {
    if (inFlightReplay?.task === task) inFlightReplay = undefined;
  });
  inFlightReplay = { owner, task };
  return task;
}
