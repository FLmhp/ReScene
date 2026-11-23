/**
 * Public demo scene for apps/site.
 *
 * Only the Vite config loads this module; the browser bundle never imports it.
 * The pinned commit, byte count and digest are the only accepted source, so a
 * changed upstream file fails the build instead of shipping a different model.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get } from "node:https";

export const DEMO_MODEL_PATH = "/assets/houseplant-ce9d490b18f1.splat";
export const DEMO_MODEL_SOURCE =
  "https://raw.githubusercontent.com/marcelpadilla/splats/c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411/data/plant/plant.splat";
export const DEMO_MODEL_BYTES = 3_636_736;
export const DEMO_MODEL_SHA256 = "ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd";
const TIMEOUT_MS = 45_000;

function download(): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const request = get(
    DEMO_MODEL_SOURCE,
    { timeout: TIMEOUT_MS, headers: { "user-agent": "rescene-site-build/1.0" } },
    (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200 || response.headers.location) {
        response.resume();
        reject(new Error(status === 200 ? "拒绝重定向" : `仅接受 200，收到 HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          response.destroy();
          return;
        }
        resolve(Buffer.concat(chunks, total));
      };
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > DEMO_MODEL_BYTES) finish(new Error(`超过 ${DEMO_MODEL_BYTES} 字节上限`));
        else chunks.push(chunk);
      });
      response.on("end", () => finish());
      response.on("error", (error) => finish(error));
    },
  );
  request.on("timeout", () => request.destroy(new Error(`超过 ${TIMEOUT_MS} 毫秒`)));
  request.on("error", reject);
  return promise;
}

/** Read the demo scene from `RESCENE_SITE_DEMO_FILE` or the pinned HTTPS source. */
export async function loadDemoModel(): Promise<Buffer> {
  const override = process.env.RESCENE_SITE_DEMO_FILE;
  let bytes: Buffer;
  try {
    bytes = override ? await readFile(override) : await download();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取演示模型（${override ? `RESCENE_SITE_DEMO_FILE=${override}` : DEMO_MODEL_SOURCE}）：${reason}`);
  }
  if (bytes.length !== DEMO_MODEL_BYTES) {
    throw new Error(`演示模型应为 ${DEMO_MODEL_BYTES} 字节，实际 ${bytes.length} 字节`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DEMO_MODEL_SHA256) {
    throw new Error(`演示模型 SHA-256 不匹配：期望 ${DEMO_MODEL_SHA256}，实际 ${digest}`);
  }
  return bytes;
}
