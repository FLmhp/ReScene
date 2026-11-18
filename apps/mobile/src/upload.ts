import type { ResceneClient } from "@rescene/api-client";
import { File, Paths } from "expo-file-system";

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

async function postToOss(
  url: string,
  fields: Record<string, string>,
  file: PickedFile,
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
  body.create();
  try {
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
    const result = await body.upload(url, {
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      onProgress: ({ bytesSent, totalBytes }) => {
        if (totalBytes > 0) onProgress?.(Math.min(99, Math.floor((bytesSent / totalBytes) * 99)));
      },
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`OSS 上传失败：HTTP ${result.status}`);
  } finally {
    body.delete();
  }
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
  await postToOss(grant.url, grant.fields, file, onProgress);
  await client.completeAsset(grant.asset_id, file.size, digest);
  onProgress?.(100);
  return grant.asset_id;
}
