import { describe, expect, it } from "vitest";
import { inspectMedia, mediaType, SAMPLE_SIDE } from "./media-preflight";

const jpg = Uint8Array.of(255, 216, 255, 224);
const photo = { name: "first.JPG", size: 150 };
const flat = new Uint8Array(SAMPLE_SIDE ** 2 * 4).fill(255);
const sharp = Uint8Array.from(flat, (_, index) => index % 4 === 3 || Math.floor(index / 4) % 7 > 2 ? 255 : 0);

describe("material selection preflight", () => {
  it("recognizes allowed extensions and blocks a renamed or unreadable file", async () => {
    expect(mediaType("pic.PNG")).toBe("image/png");
    expect(mediaType("jpg")).toBeUndefined();
    expect(mediaType("file.constructor")).toBeUndefined();
    await expect(inspectMedia([photo], async () => Uint8Array.of(1, 2), async () => sharp)).rejects.toThrow(/first.JPG.*扩展名/);
    await expect(inspectMedia([photo], async () => jpg, async () => { throw new Error("无法解码"); })).rejects.toThrow(/无法解码/);
  });
  it("exposes blur and similar photos as advisory warnings", async () => {
    expect(await inspectMedia([photo], async () => jpg, async () => sharp)).toEqual([]);
    const warnings = await inspectMedia([photo, { ...photo, name: "copy.jpg" }], async () => jpg, async () => flat);
    expect(warnings).toEqual(["first.JPG：可能模糊或缺少可识别纹理", "copy.jpg：可能模糊或缺少可识别纹理", "copy.jpg：与 first.JPG 可能重复"]);
  });
  it("checks video headers without decoding or reading the whole video", async () => {
    const header = Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112);
    expect(await inspectMedia([{ name: "movie.mp4", size: 2 ** 30 }], async () => header, async () => { throw new Error("unexpected"); })).toEqual([]);
  });
});
