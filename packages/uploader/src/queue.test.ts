import { describe, expect, it, vi } from "vitest";

import { parseQueue, replayQueue, serializeQueue, type QueuedEntry, type QueuedUpload } from "./queue";

function upload(overrides: Partial<QueuedUpload> = {}): QueuedUpload {
  return {
    kind: "upload",
    id: "u1",
    projectId: "p1",
    uri: "file:///cache/a.jpg",
    name: "a.jpg",
    mimeType: "image/jpeg",
    size: 2048,
    createdAt: 1,
    ...overrides,
  };
}

const project: QueuedEntry = { kind: "project", id: "q1", name: "厨房", createdAt: 0 };

describe("queue storage", () => {
  it("starts empty when storage holds nothing, junk, or a non-array", () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue("not json")).toEqual([]);
    expect(parseQueue('{"kind":"upload"}')).toEqual([]);
    expect(parseQueue('[{"kind":"upload","id":"u1"}]')).toEqual([]);
  });

  it("round-trips queued entries in order", () => {
    const entries: QueuedEntry[] = [project, upload()];
    expect(parseQueue(serializeQueue(entries))).toEqual(entries);
  });
});

describe("replayQueue", () => {
  it("removes a project once it exists on the server", async () => {
    const createProject = vi.fn(async () => undefined);
    const result = await replayQueue([project], { createProject, upload: vi.fn() });
    expect(createProject).toHaveBeenCalledWith("厨房");
    expect(result).toMatchObject({ remaining: [], created: 1, uploaded: 0, dropped: 0 });
  });

  it("keeps a project that could not be created", async () => {
    const result = await replayQueue([project], {
      createProject: async () => {
        throw new Error("offline");
      },
      upload: vi.fn(),
    });
    expect(result.remaining).toEqual([project]);
    expect(result.created).toBe(0);
  });

  it("drops an upload the server reports as already known", async () => {
    const result = await replayQueue([upload()], {
      createProject: vi.fn(),
      upload: async () => {
        throw { status: 409, detail: "Asset is not awaiting upload" };
      },
    });
    expect(result).toMatchObject({ remaining: [], uploaded: 0, dropped: 1 });
  });

  it("keeps an upload that failed for network reasons", async () => {
    const pending = upload();
    const result = await replayQueue([pending], {
      createProject: vi.fn(),
      upload: async () => {
        throw new TypeError("Network request failed");
      },
    });
    expect(result).toMatchObject({ remaining: [pending], uploaded: 0, dropped: 0 });
  });

  it("keeps processing after a failure and reports each outcome", async () => {
    const first = upload({ id: "u1" });
    const second = upload({ id: "u2", name: "b.jpg" });
    const seen: string[] = [];
    const result = await replayQueue([project, first, second], {
      createProject: async () => undefined,
      upload: async (entry) => {
        seen.push(entry.id);
        if (entry.id === "u1") throw new Error("500");
      },
    });
    expect(seen).toEqual(["u1", "u2"]);
    expect(result).toMatchObject({ remaining: [first], created: 1, uploaded: 1, dropped: 0 });
  });
});
