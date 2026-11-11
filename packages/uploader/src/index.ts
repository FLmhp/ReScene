/**
 * Upload contracts shared by the browser workbench and the Tauri desktop shell.
 *
 * Mobile and the Mini Program cannot use the multipart STS flow, so they build a
 * PostObject form from the same `UploadGrant` schema instead of importing the
 * browser adapter.
 */

export const POST_OBJECT_LIMIT = 5 * 1024 ** 3;
export const MINIAPP_FILE_LIMIT = 10 * 1024 * 1024;
export const MINIAPP_FILE_COUNT = 8;

export * from "./queue";

export type UploadRequest = {
  projectId: string;
  file: File;
};

export type UploadResult = { assetId: string };

export type ProgressReporter = (percent: number) => void;

export interface UploadAdapter {
  upload(request: UploadRequest, onProgress: ProgressReporter): Promise<UploadResult>;
}

export type PostObjectForm = {
  url: string;
  fields: Record<string, string>;
};

/**
 * PostObject requires the file field last; callers append the file after these.
 * Values are already signed by the API, so order only matters for `file`.
 */
export function postObjectFields(fields: Record<string, string>): [string, string][] {
  return Object.entries(fields).filter(([key]) => key !== "file");
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}
