import { describe, expect, it } from "vitest";

import { MINIAPP_FILE_LIMIT, formatBytes, postObjectFields } from "./index";

describe("upload constraints", () => {
  it("keeps the mini program limit at 10MB", () => {
    expect(MINIAPP_FILE_LIMIT).toBe(10 * 1024 * 1024);
  });

  it("keeps the file field last for PostObject", () => {
    const fields = postObjectFields({ key: "k", file: "ignored", policy: "p" });
    expect(fields).toEqual([
      ["key", "k"],
      ["policy", "p"],
    ]);
  });

  it("formats sizes for the upload list", () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(2 * 1024 ** 2)).toBe("2.0 MB");
    expect(formatBytes(512)).toBe("1 KB");
  });
});
