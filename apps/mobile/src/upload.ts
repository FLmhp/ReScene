import type { ResceneClient } from "@rescene/api-client";
import { accountQueueKey, inspectMedia, QueuedMediaMissing, SAMPLE_SIDE, type QueueOwner } from "@rescene/uploader";
import { Directory, File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { decode } from "jpeg-js";

import { assertQueueOwner, isQueueOwnerCurrent } from "./api";

export type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

export type JobFile = { uri: string; name: string; type: string };

const MEDIA_ROOT = `${FileSystem.documentDirectory}rescene-media/`;

/** An upload writes a full second copy to the cache, so reserve trailer and metadata overhead. */
const COPY_HEADROOM = 1024 * 1024;
const UPLOAD_BODY = /^rescene-.+\.post$/;

/** The device cannot hold the copy this upload needs; retrying cannot help until space is freed. */
export class StorageShortageError extends Error {
  constructor() {
    super("设备存储不足，请清理空间后重试。");
    this.name = "StorageShortageError";
  }
}

export function isStorageShortage(error: unknown): boolean {
  return error instanceof StorageShortageError;
}

function requireFreeSpace(bytes: number): void {
  const available = Paths.availableDiskSpace;
  if (Number.isFinite(available) && available > 0 && bytes > 0 && available < bytes) throw new StorageShortageError();
}

/** A native write reports a full disk as a platform message, not a typed error. */
function isOutOfSpace(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return /ENOSPC|no space left|not enough space|存储空间不足|磁盘空间不足/i.test(text);
}

function deleteQuietly(file: File): void {
  try { if (file.exists) file.delete(); } catch { /* the launch sweep collects an orphaned body */ }
}

/** The picker's cache copy is redundant once the managed copy is verified. */
async function removePickerCacheCopy(uri: string): Promise<void> {
  const cache = FileSystem.cacheDirectory;
  if (!cache || !uri.startsWith(cache)) return;
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* locked or already claimed */ }
}

/**
 * A crash or a killed process can leave a whole-file body in the cache. Sweep
 * them at launch so repeated large uploads cannot fill the device.
 */
export function clearOrphanUploadBodies(): void {
  let entries: (Directory | File)[];
  try { entries = Paths.cache.list(); } catch { return; }
  for (const entry of entries) {
    if (entry instanceof File && UPLOAD_BODY.test(entry.name)) deleteQuietly(entry);
  }
}

/** Keep the queue-owned copy inside the account's directory, never the picker cache. */
export function managedMediaDirectory(owner: QueueOwner): string {
  return MEDIA_ROOT + accountQueueKey("queue", owner) + "/";
}

function managedMediaName(id: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "media";
  return `${id}-${safe}`;
}

/**
 * Copy a picked file into app storage before the queue may promise to keep it.
 * Returns the stored size so the entry records what was actually persisted.
 */
export async function persistPickedFile(
  owner: QueueOwner,
  id: string,
  file: PickedFile,
): Promise<{ uri: string; size: number }> {
  const directory = managedMediaDirectory(owner);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  requireFreeSpace(file.size + COPY_HEADROOM);
  const uri = directory + managedMediaName(id, file.name);
  try {
    await FileSystem.copyAsync({ from: file.uri, to: uri });
    const stored = new File(uri);
    if (!stored.exists) throw new Error("素材副本不可读，请检查设备存储。");
    const size = stored.size;
    if (typeof size !== "number" || size <= 0) throw new Error("素材副本不可读，请检查设备存储。");
    if (file.size > 0 && size !== file.size) throw new Error("素材副本不完整，请重新选择该文件。");
    await removePickerCacheCopy(file.uri);
    return { uri, size };
  } catch (reason) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    throw isOutOfSpace(reason) ? new StorageShortageError() : reason;
  }
}

export async function managedMediaExists(uri: string): Promise<boolean> {
  return (await FileSystem.getInfoAsync(uri)).exists;
}

/** Best effort: a leftover copy must never fail a successful upload. */
export async function removeManagedMedia(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch { /* the entry is already complete; an orphan file is harmless */ }
}

export async function requireQueuedMedia(uri: string): Promise<void> {
  if (!(await managedMediaExists(uri))) throw new QueuedMediaMissing();
}

export function inspectPickedFiles(files: PickedFile[]): Promise<string[]> {
  return inspectMedia(files, async (file) => {
    const reader = new File(file.uri).open();
    try { return await reader.readBytes(Math.min(file.size, 16)); }
    finally { reader.close(); }
  }, async (file) => {
    const context = ImageManipulator.manipulate(file.uri, { maxWidth: SAMPLE_SIDE, maxHeight: SAMPLE_SIDE });
    try {
      const image = await context.resize({ width: SAMPLE_SIDE, height: SAMPLE_SIDE }).renderAsync();
      try {
        const sample = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 });
        const temporary = new File(sample.uri);
        try { return decode(await temporary.bytes(), { useTArray: true }).data; }
        finally { temporary.delete(); }
      } finally { image.release(); }
    } catch { throw new Error("无法解码图片"); }
    finally { context.release(); }
  });
}

/** Native streaming digest: never materializes the video in the JS heap. */
export function sha256Of(file: PickedFile): Promise<string> {
  return new File(file.uri).digest("SHA-256");
}

async function postToOss(
  url: string,
  fields: Record<string, string>,
  file: PickedFile,
  owner: QueueOwner,
  onProgress?: (percent: number) => void,
): Promise<void> {
  // Android's multipart encoder adds a per-part Content-Length that OSS rejects.
  const boundary = `rescene-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = new File(Paths.cache, `${boundary}.post`);
  const encode = new TextEncoder();
  const form = Object.entries(fields).map(([key, value]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("上传表单包含无效字段");
    return `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }).join("");
  if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(file.mimeType)) throw new Error("无效的上传文件类型");
  // The body duplicates the whole file in the cache; refuse before writing
  // rather than failing with ENOSPC after an hour of copying.
  requireFreeSpace(file.size + COPY_HEADROOM);
  try {
    body.create();
    const writer = body.open();
    try {
      await writer.writeBytes(encode.encode(
        `${form}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ));
      const reader = new File(file.uri).open();
      try {
        let copied = 0;
        while (copied < file.size) {
          const bytes = await reader.readBytes(Math.min(1024 * 1024, file.size - copied));
          if (!bytes.length) throw new Error("上传文件已变更，请重新选择");
          await writer.writeBytes(bytes);
          copied += bytes.length;
        }
        if ((await reader.readBytes(1)).length) throw new Error("上传文件已变更，请重新选择");
      } finally {
        reader.close();
      }
      await writer.writeBytes(encode.encode(`\r\n--${boundary}--\r\n`));
    } finally {
      writer.close();
    }
    assertQueueOwner(owner);
    const result = await body.upload(url, {
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      onProgress: ({ bytesSent, totalBytes }) => {
        if (totalBytes > 0) onProgress?.(Math.min(99, Math.floor((bytesSent / totalBytes) * 99)));
      },
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`OSS 上传失败：HTTP ${result.status}`);
  } catch (reason) {
    throw isOutOfSpace(reason) ? new StorageShortageError() : reason;
  } finally {
    deleteQuietly(body);
  }
}

/**
 * Each call obtains a fresh PostObject grant, so retrying the whole upload is
 * safe: the previous grant is simply discarded and the local file is untouched.
 */
export async function uploadFile(
  owner: QueueOwner,
  client: ResceneClient,
  projectId: string,
  file: PickedFile,
  onProgress?: (percent: number) => void,
  options?: { assetId?: string; onAsset?: (assetId: string) => void | Promise<void> },
): Promise<string> {
  assertQueueOwner(owner);
  const report = (percent: number) => { if (isQueueOwnerCurrent(owner)) onProgress?.(percent); };
  report(0);
  const digest = await sha256Of(file);
  assertQueueOwner(owner);
  // A refresh 409 means the asset stopped awaiting uploads; the API codes it
  // so the queue can drop only that duplicate, while any other 409 is retried.
  const grant = options?.assetId
    ? await client.refreshUploadSession(options.assetId, "post")
    : await client.createUploadSession(projectId, {
      filename: file.name,
      size: file.size,
      content_type: file.mimeType,
      sha256: digest,
      mode: "post",
    });
  await options?.onAsset?.(grant.asset_id);
  assertQueueOwner(owner);
  if (!grant.url || !grant.fields) throw new Error("服务端未返回 PostObject 表单");
  await postToOss(grant.url, grant.fields, file, owner, report);
  assertQueueOwner(owner);
  await client.completeAsset(grant.asset_id, file.size, digest);
  report(100);
  return grant.asset_id;
}
