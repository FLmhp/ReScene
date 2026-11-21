export const SAMPLE_SIDE = 96;

export class MediaPreflightError extends Error {}

const formats: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", mp4: "video/mp4",
  mov: "video/quicktime", m4v: "video/x-m4v", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo",
};

export function mediaType(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return extension && Object.prototype.hasOwnProperty.call(formats, extension) ? formats[extension] : undefined;
}

export function matchesMediaHeader(type: string, header: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte);
  const tag = (offset: number) => String.fromCharCode(...header.slice(offset, offset + 4));
  switch (type) {
    case "image/jpeg": return starts(255, 216, 255);
    case "image/png": return starts(137, 80, 78, 71, 13, 10, 26, 10);
    case "video/avi":
    case "video/x-msvideo": return tag(0) === "RIFF" && tag(8) === "AVI ";
    case "video/webm":
    case "video/x-matroska": return starts(26, 69, 223, 163);
    default: return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(tag(4));
  }
}

type ImageSample = { blurred: boolean; grid: Uint8Array };

export function analyzeSample(pixels: ArrayLike<number>): ImageSample {
  const side = SAMPLE_SIDE;
  if (pixels.length !== side * side * 4) throw new Error("无法读取图片像素");
  const gray = new Int16Array(side * side);
  const cells = new Uint32Array(64);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const index = y * side + x;
      const offset = index * 4;
      const alpha = pixels[offset + 3] / 255;
      const luminance = (77 * pixels[offset] + 150 * pixels[offset + 1] + 29 * pixels[offset + 2]) / 256;
      gray[index] = Math.round(luminance * alpha + 255 * (1 - alpha));
      cells[Math.floor(y / 12) * 8 + Math.floor(x / 12)] += gray[index];
    }
  }
  let sum = 0;
  let squares = 0;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const i = y * side + x;
      const laplacian = gray[i - 1] + gray[i + 1] + gray[i - side] + gray[i + side] - 4 * gray[i];
      sum += laplacian;
      squares += laplacian ** 2;
    }
  }
  const count = (side - 2) ** 2;
  return { blurred: squares / count - (sum / count) ** 2 < 12, grid: Uint8Array.from(cells, (cell) => Math.round(cell / 144)) };
}

export async function inspectMedia<T extends { name: string; size: number }>(
  files: T[],
  header: (file: T) => Promise<Uint8Array>,
  sample: (file: T) => Promise<ArrayLike<number> | null>,
): Promise<string[]> {
  const seen: { name: string; grid: Uint8Array }[] = [];
  const warnings: string[] = [];
  const invalid: string[] = [];
  for (const file of files) {
    try {
      const type = mediaType(file.name);
      if (!type || !file.size || !matchesMediaHeader(type, await header(file))) {
        throw new Error("文件格式不受支持或内容与扩展名不符");
      }
      if (!type.startsWith("image/")) continue;
      const pixels = await sample(file);
      if (!pixels) {
        warnings.push(`${file.name}：本机无法检查清晰度和重复度`);
        continue;
      }
      const { blurred, grid } = analyzeSample(pixels);
      if (blurred) warnings.push(`${file.name}：可能模糊或缺少可识别纹理`);
      // Low-resolution similarity is advisory, including when two valid views look alike.
      const duplicate = seen.find((previous) => grid.every((value, i) => Math.abs(previous.grid[i] - value) <= 5));
      if (duplicate) warnings.push(`${file.name}：与 ${duplicate.name} 可能重复`);
      seen.push({ name: file.name, grid });
    } catch (error) {
      invalid.push(`${file.name}：${error instanceof Error ? error.message : "无法读取文件"}`);
    }
  }
  if (invalid.length) throw new MediaPreflightError(`请重新选择素材。\n${summarizeMediaWarnings(invalid)}`);
  return warnings;
}

export function summarizeMediaWarnings(warnings: string[]): string {
  const limit = 6;
  return [...warnings.slice(0, limit), ...(warnings.length > limit ? [`另有 ${warnings.length - limit} 项`] : [])].join("\n");
}
