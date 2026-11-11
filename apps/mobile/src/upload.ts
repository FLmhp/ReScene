import type { ResceneClient } from "@rescene/api-client";
import { File } from "expo-file-system";

export type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

export type JobFile = { uri: string; name: string; type: string };

/** Native streaming digest: never materializes the video in the JS heap. */
export function sha256Of(file: PickedFile): Promise<string> {
  return new File(file.uri).digest("SHA-256");
}

function postToOss(
  url: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(99, Math.floor((event.loaded / event.total) * 99)));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        console.warn("OSS upload rejected", request.status, request.responseText);
        reject(new Error(`OSS 上传失败：HTTP ${request.status}`));
      }
    };
    request.onerror = () => reject(new Error("OSS 上传失败：网络错误，请重试"));
    request.onabort = () => reject(new Error("OSS 上传已取消，请重试"));
    request.ontimeout = () => reject(new Error("OSS 上传超时，请重试"));
    request.send(form);
  });
}

/**
 * Each call obtains a fresh PostObject grant, so retrying the whole upload is
 * safe: the previous grant is simply discarded and the local file is untouched.
 */
export async function uploadFile(
  client: ResceneClient,
  projectId: string,
  file: PickedFile,
  onProgress?: (percent: number) => void,
  options?: { assetId?: string; onAsset?: (assetId: string) => void | Promise<void> },
): Promise<string> {
  onProgress?.(0);
  const digest = await sha256Of(file);
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
  if (!grant.url || !grant.fields) throw new Error("服务端未返回 PostObject 表单");
  const form = new FormData();
  for (const [key, value] of Object.entries(grant.fields)) form.append(key, value);
  form.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  await postToOss(grant.url, form, onProgress);
  await client.completeAsset(grant.asset_id, file.size, digest);
  onProgress?.(100);
  return grant.asset_id;
}
