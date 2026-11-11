/**
 * Browser/desktop STS multipart uploader with IndexedDB checkpoints.
 *
 * A refresh mid-upload resumes from the stored checkpoint instead of restarting
 * the whole object, and a completed object is only marked READY after the API
 * HEAD check succeeds.
 */

import { ResceneApiError, type ResceneClient } from "@rescene/api-client";
import type { UploadGrant } from "@rescene/schemas";
import { createSHA256 } from "hash-wasm";
import OSS, { type Checkpoint as OssCheckpoint } from "ali-oss";

import type { ProgressReporter, UploadAdapter, UploadRequest, UploadResult } from "./index";

const CHUNK = 8 * 1024 * 1024;
const STORE = "checkpoints";

/** The OSS checkpoint minus the selected file, which is never persisted. */
type StoredCheckpoint = Omit<OssCheckpoint, "file">;

type Checkpoint = {
  asset_id: string;
  object_key: string;
  checkpoint?: StoredCheckpoint;
  uploaded?: boolean;
};

export class ResceneApiConflict extends Error {
  override name = "ResceneApiConflict";
}

async function checkpointTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const opened = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open("rescene-uploads", 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  request.onerror = () => opened.reject(request.error);
  request.onsuccess = () => opened.resolve(request.result);
  const database = await opened.promise;

  const result = Promise.withResolvers<T>();
  let transaction: IDBTransaction;
  let stored: IDBRequest<T>;
  try {
    transaction = database.transaction(STORE, mode);
    stored = operation(transaction.objectStore(STORE));
  } catch (error) {
    database.close();
    throw error;
  }
  const fail = () => {
    database.close();
    result.reject(transaction.error ?? stored.error ?? new Error("Checkpoint transaction failed"));
  };
  transaction.oncomplete = () => {
    database.close();
    result.resolve(stored.result);
  };
  transaction.onerror = fail;
  transaction.onabort = fail;
  return result.promise;
}

export async function readCheckpoint(key: string): Promise<Checkpoint | undefined> {
  return checkpointTransaction("readonly", (store) => store.get(key));
}

export async function writeCheckpoint(key: string, value: Checkpoint | null): Promise<void> {
  await checkpointTransaction<void>("readwrite", (store) =>
    (value === null ? store.delete(key) : store.put(value, key)) as IDBRequest<void>,
  );
}

export async function sha256File(file: File): Promise<string> {
  const hash = await createSHA256();
  hash.init();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
  }
  return hash.digest();
}

export function createWebUploader(client: ResceneClient): UploadAdapter {
  return {
    async upload({ projectId, file }: UploadRequest, onProgress: ProgressReporter): Promise<UploadResult> {
      let reported = -1;
      const report = (value: number): void => {
        const percent = Math.max(0, Math.min(100, Math.round(value)));
        if (percent <= reported) return;
        reported = percent;
        onProgress(percent);
      };
      report(0);

      const digest = await sha256File(file);
      const checkpointKey = `${projectId}:${file.name}:${digest}`;
      const contentType = file.type || "application/octet-stream";

      // Resume bookkeeping is best effort: browser storage can be unavailable
      // (private mode, quota) and must never block an otherwise valid upload.
      // Progress fires after every part, so writes are coalesced to the newest
      // checkpoint instead of queueing one transaction per part.
      let checkpointing = true;
      let latest: Checkpoint | null = null;
      let pending = false;
      let flushing: Promise<void> | null = null;
      const persist = (value: Checkpoint | null): Promise<void> => {
        if (!checkpointing) return Promise.resolve();
        latest = value;
        pending = true;
        if (flushing) return flushing;
        const flush = async (): Promise<void> => {
          while (pending) {
            pending = false;
            try {
              await writeCheckpoint(checkpointKey, latest);
            } catch {
              checkpointing = false;
              pending = false;
              break;
            }
          }
          flushing = null;
        };
        flushing = flush();
        return flushing;
      };

      let saved: Checkpoint | undefined;
      try {
        saved = await readCheckpoint(checkpointKey);
      } catch {
        checkpointing = false;
      }

      if (saved) {
        try {
          await client.completeAsset(saved.asset_id, file.size, digest);
          await persist(null);
          report(100);
          return { assetId: saved.asset_id };
        } catch (error) {
          if (error instanceof ResceneApiError && error.status === 404) {
            // The asset behind the checkpoint is gone; start a fresh session.
            saved = undefined;
            await persist(null);
          } else if (error instanceof ResceneApiError && error.status === 409) {
            if (saved.uploaded) {
              await persist(null);
              throw new ResceneApiConflict(
                "The previous upload failed server verification. Its checkpoint was discarded; retry to upload the file again.",
              );
            }
          } else {
            throw error;
          }
        }
      }

      const createSession = () =>
        client.createUploadSession(projectId, {
          filename: file.name,
          size: file.size,
          content_type: contentType,
          sha256: digest,
        });
      let grant: UploadGrant;
      try {
        grant = saved ? await client.refreshUploadSession(saved.asset_id, "sts") : await createSession();
      } catch (error) {
        const stale = error instanceof ResceneApiError && (error.status === 404 || error.status === 409);
        if (!saved || !stale) throw error;
        // Stale sessions cannot be refreshed; discard them and re-initiate.
        await persist(null);
        saved = undefined;
        grant = await createSession();
      }
      if (!grant.oss) throw new Error("Upload grant is missing STS credentials");

      const resume =
        saved?.asset_id === grant.asset_id && saved.object_key === grant.object_key ? saved.checkpoint : undefined;
      if (resume && file.size > 0) {
        report(Math.min(99, (resume.doneParts.length * resume.partSize / file.size) * 100));
      }

      const oss = new OSS({
        region: grant.oss.region,
        endpoint: grant.oss.endpoint,
        bucket: grant.oss.bucket,
        accessKeyId: grant.oss.access_key_id,
        accessKeySecret: grant.oss.access_key_secret,
        stsToken: grant.oss.security_token,
        secure: true,
      });
      const checkpoint = (value: StoredCheckpoint | undefined, uploaded = false): Checkpoint => ({
        asset_id: grant.asset_id,
        object_key: grant.object_key,
        checkpoint: value,
        uploaded,
      });
      await persist(checkpoint(resume));
      await oss.multipartUpload(grant.object_key, file, {
        parallel: 4,
        partSize: CHUNK,
        checkpoint: resume ? { ...resume, file } : undefined,
        progress: (value: number, next: OssCheckpoint | null | undefined) => {
          report(value * 100);
          if (!next) return;
          const { file: _selected, ...stored } = next;
          void persist(checkpoint(stored));
        },
      });
      await persist(checkpoint(undefined, true));
      try {
        const completed = await client.completeAsset(grant.asset_id, file.size, digest);
        if (completed.status !== "READY") throw new Error("Uploaded asset did not reach READY");
      } catch (error) {
        if (error instanceof ResceneApiError && error.status === 409) {
          await persist(null);
          throw new ResceneApiConflict(
            "The uploaded object failed server verification. Its checkpoint was discarded; retry to upload the file again.",
          );
        }
        throw error;
      }
      await persist(null);
      report(100);
      return { assetId: grant.asset_id };
    },
  };
}
