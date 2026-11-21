import { isOfflineError, ResceneApiError, type ResceneClient } from "@rescene/api-client";
import { sha256 } from "@noble/hashes/sha2.js";
import type { UploadGrant } from "@rescene/schemas";
import { inspectMedia, mediaType, SAMPLE_SIDE, type QueueOwner } from "@rescene/uploader";
import Taro from "@tarojs/taro";

import { accountQueueKey, QueuedMediaMissing, type QueueOwner as MediaQueueOwner } from "@rescene/uploader";

import { assertQueueOwner, isQueueOwnerCurrent } from "./api";

export const MINIAPP_FILE_LIMIT = 10 * 1024 * 1024;
export const MINIAPP_FILE_COUNT = 8;

export type ChosenFile = {
  path: string;
  size: number;
  name: string;
  contentType: string;
};

/** Keep the queue-owned copy in app user storage, not the temporary picker path. */
export function managedMediaDirectory(owner: MediaQueueOwner): string {
  const root = (Taro.env as { USER_DATA_PATH?: string }).USER_DATA_PATH ?? "wxfile://usr";
  return `${root}/rescene-media/${accountQueueKey("queue", owner)}/`;
}

function managedMediaName(id: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "media";
  return `${id}-${safe}`;
}

/** Copy a chosen file into app storage before the queue may promise to keep it. */
export function persistChosenFile(owner: MediaQueueOwner, id: string, file: ChosenFile): { path: string; size: number } {
  const fs = Taro.getFileSystemManager();
  const directory = managedMediaDirectory(owner);
  fs.mkdirSync(directory, true);
  const path = directory + managedMediaName(id, file.name);
  try {
    fs.copyFileSync(file.path, path);
    const stats = fs.statSync(path) as { size?: number };
    const size = typeof stats.size === "number" ? stats.size : 0;
    if (size <= 0) throw new Error("素材副本不可读，请检查设备存储。");
    if (file.size > 0 && size !== file.size) throw new Error("素材副本不完整，请重新选择该文件。");
    return { path, size };
  } catch (reason) {
    try { fs.unlinkSync(path); } catch { /* nothing to roll back */ }
    throw reason;
  }
}

export function managedMediaExists(path: string): boolean {
  try { Taro.getFileSystemManager().accessSync(path); return true; } catch { return false; }
}

/** Best effort: an orphan copy must never fail a successful upload. */
export function removeManagedMedia(path: string): void {
  try { Taro.getFileSystemManager().unlinkSync(path); } catch { /* already gone */ }
}

export function requireQueuedMedia(path: string): void {
  if (!managedMediaExists(path)) throw new QueuedMediaMissing();
}

/** Selection refused; `cancelled` means the user backed out, not a failure. */
export class UploadSelectionError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = "UploadSelectionError";
  }
}

/** A specific file failed; keep `file` so the caller can retry just that upload. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly file: ChosenFile,
    readonly stage: "hash" | "session" | "transfer" | "complete",
    /** HTTP status of the failed step, so the queue can inspect a 409. */
    readonly status?: number,
    /** No response arrived; the queue keeps the entry for a later replay. */
    readonly offline = false,
    /** The API's stable error code; only `asset.not_awaiting_upload` is a duplicate. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Taro rejects with `{ errMsg }` objects, not always real Errors. */
function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (reason && typeof reason === "object" && "errMsg" in reason) {
    return String(reason.errMsg);
  }
  return String(reason);
}

function hashOf(path: string): string {
  const bytes = new Uint8Array(Taro.getFileSystemManager().readFileSync(path) as ArrayBuffer);
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inspectChosenFiles(files: ChosenFile[]): Promise<string[]> {
  return inspectMedia(files, async (file) => new Uint8Array(
    Taro.getFileSystemManager().readFileSync(file.path, undefined, 0, Math.min(file.size, 16)) as ArrayBuffer,
  ), async (file) => {
    if (typeof Taro.createOffscreenCanvas !== "function") {
      await Taro.getImageInfo({ src: file.path });
      return null;
    }
    const canvas = Taro.createOffscreenCanvas({ type: "2d", width: SAMPLE_SIDE, height: SAMPLE_SIDE });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) {
      await Taro.getImageInfo({ src: file.path });
      return null;
    }
    const image = canvas.createImage();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("图片检查超时")), 10000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("无法解码图片")); };
      image.src = file.path;
    });
    context.drawImage(image as unknown as CanvasImageSource, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
    return context.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data;
  });
}

/**
 * WeChat requires privacy authorization before media APIs. The agreement itself
 * is configured in the MP console; this only surfaces the platform prompt and
 * turns a refusal into an actionable message.
 */
async function ensurePrivacy(): Promise<void> {
  const getSetting = Taro.getPrivacySetting;
  if (typeof getSetting !== "function") return;
  const setting = await new Promise<{ needAuthorization?: boolean } | null>((resolve) => {
    getSetting({
      success: (result) => resolve(result as { needAuthorization?: boolean }),
      fail: () => resolve(null),
    });
  });
  if (!setting?.needAuthorization) return;
  await new Promise<void>((resolve, reject) => {
    Taro.requirePrivacyAuthorize({
      success: () => resolve(),
      fail: () => reject(new UploadSelectionError("需要先同意小程序隐私协议才能选择图片或视频；请在设置中允许后重试。")),
    });
  });
}

/**
 * Pick media, or throw with every rejected file named. Nothing is filtered out
 * silently: an oversized file stops the selection and must be re-picked.
 */
export async function chooseMedia(): Promise<ChosenFile[]> {
  let result: Taro.chooseMedia.SuccessCallbackResult;
  try {
    await ensurePrivacy();
    result = await Taro.chooseMedia({
      count: MINIAPP_FILE_COUNT,
      mediaType: ["image", "video"],
      sourceType: ["album", "camera"],
    });
  } catch (reason) {
    if (reason instanceof UploadSelectionError) throw reason;
    const detail = errorText(reason);
    if (/cancel/i.test(detail)) throw new UploadSelectionError("已取消选择", true);
    throw new UploadSelectionError(`选择文件失败：${detail}`);
  }
  if (result.tempFiles.length > MINIAPP_FILE_COUNT) {
    throw new UploadSelectionError(`每次最多选择 ${MINIAPP_FILE_COUNT} 个文件，请重新选择`);
  }
  const oversized = result.tempFiles.filter((file) => file.size > MINIAPP_FILE_LIMIT);
  if (oversized.length) {
    const names = oversized.map((file) => {
      const name = file.tempFilePath.split("/").pop() || "未命名文件";
      return `${name}（${formatSize(file.size)}）`;
    });
    throw new UploadSelectionError(
      `以下文件超过每个 ${formatSize(MINIAPP_FILE_LIMIT)} 的限制：${names.join("、")}。请重新选择。`,
    );
  }
  const unsupported: string[] = [];
  const files = result.tempFiles.map((file) => {
    const name = file.tempFilePath.split("/").pop() ?? "upload.jpg";
    const contentType = mediaType(name);
    if (!contentType) unsupported.push(name);
    return { path: file.tempFilePath, size: file.size, name, contentType: contentType ?? "" };
  });
  if (unsupported.length) {
    throw new UploadSelectionError(
      `以下文件格式不受支持：${unsupported.join("、")}。请选择 JPG/PNG 图片或 MP4/MOV/M4V/WebM 视频。`,
    );
  }
  return files;
}

/**
 * PostObject upload: the API signs one key, the device posts the form to OSS.
 * Retrying means calling again with the same file: a fresh session is created
 * and the previous attempt is abandoned. `onProgress` receives 0-100. Passing
 * `assetId` resumes that queued asset instead of creating another row.
 */
export async function uploadFile(
  owner: QueueOwner,
  client: ResceneClient,
  projectId: string,
  file: ChosenFile,
  onProgress?: (percent: number) => void,
  options?: { assetId?: string; onAsset?: (id: string) => void | Promise<void> },
): Promise<string> {
  assertQueueOwner(owner);
  let last = -1;
  const report = (percent: number) => {
    if (!isQueueOwnerCurrent(owner)) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    if (value <= last) return;
    last = value;
    onProgress?.(value);
  };

  report(5);
  let sha256Hex: string;
  try {
    sha256Hex = hashOf(file.path);
  } catch (reason) {
    const detail = errorText(reason);
    throw new UploadError(`读取文件失败：${detail}`, file, "hash");
  }
  report(20);

  assertQueueOwner(owner);
  let grant: UploadGrant;
  try {
    grant = options?.assetId
      ? await client.refreshUploadSession(options.assetId, "post")
      : await client.createUploadSession(projectId, {
        filename: file.name,
        size: file.size,
        content_type: file.contentType,
        sha256: sha256Hex,
        mode: "post",
      });
  } catch (reason) {
    const detail = errorText(reason);
    throw new UploadError(
      `创建上传会话失败：${detail}`,
      file,
      "session",
      reason instanceof ResceneApiError ? reason.status : undefined,
      isOfflineError(reason),
      reason instanceof ResceneApiError ? reason.code : undefined,
    );
  }
  await options?.onAsset?.(grant.asset_id);
  assertQueueOwner(owner);
  if (!grant.url || !grant.fields) throw new UploadError("服务端未返回上传表单", file, "session");

  const task = Taro.uploadFile({
    url: grant.url,
    filePath: file.path,
    name: "file",
    formData: grant.fields,
  });
  if (typeof task.onProgressUpdate === "function") {
    task.onProgressUpdate(({ progress }) => report(20 + progress * 0.65));
  }
  let uploaded: Taro.uploadFile.SuccessCallbackResult;
  try {
    uploaded = await task;
  } catch (reason) {
    const detail = errorText(reason);
    throw new UploadError(`上传中断：${detail}`, file, "transfer", undefined, isOfflineError(reason));
  }
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new UploadError(`OSS 上传失败：HTTP ${uploaded.statusCode}`, file, "transfer");
  }
  report(90);

  assertQueueOwner(owner);
  try {
    await client.completeAsset(grant.asset_id, file.size, sha256Hex);
  } catch (reason) {
    const detail = errorText(reason);
    throw new UploadError(
      `确认上传失败：${detail}`,
      file,
      "complete",
      reason instanceof ResceneApiError ? reason.status : undefined,
      isOfflineError(reason),
      reason instanceof ResceneApiError ? reason.code : undefined,
    );
  }
  report(100);
  return grant.asset_id;
}
