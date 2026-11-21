import { describe, expect, it, vi } from "vitest";

import {
  accountQueueKey, createNativeQueue, createQueueSession, isQueuedMediaMissing, parseQueue, QueuedMediaMissing,
  readQueueCredential, replayQueue, serializeQueue, sessionExpiry, type QueuedEntry, type QueuedUpload, type QueueOwner,
} from "./queue";

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
    expect(createProject).toHaveBeenCalledWith("厨房", undefined);
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


describe("queue account ownership", () => {
  it("keeps legacy records unclaimed and uses a stable key per verified account", () => {
    const legacyKey = "rescene-queue";
    const legacy = serializeQueue([project]);
    const storage = new Map([[legacyKey, legacy]]);
    const session = createQueueSession(readQueueCredential("old-session"));
    expect(session.owner()).toBeNull();
    const a = { id: "account/a", generation: 1 };
    const b = { id: "account~2Fa", generation: 2 };
    const aKey = accountQueueKey(legacyKey, a);
    storage.set(aKey, serializeQueue([upload()]));
    expect(accountQueueKey(legacyKey, { ...a, generation: 12 })).toBe(aKey);
    expect(parseQueue(storage.get(accountQueueKey(legacyKey, b)) ?? null)).toEqual([]);
    expect(storage.get(legacyKey)).toBe(legacy);
    expect(parseQueue(storage.get(aKey) ?? null)).toEqual([upload()]);
  });

  it("restores a persisted binding for its exact token and ignores malformed metadata", () => {
    const stored = readQueueCredential(JSON.stringify({ token: "verified-a", owner: "a" }));
    const session = createQueueSession(stored);
    expect(session.snapshot().token).toBe("verified-a");
    expect(session.owner()?.id).toBe("a");
    expect(readQueueCredential('{"token":"older","owner":42}')?.owner).toBeNull();
    expect(readQueueCredential('{"token":')).toBeNull();
    expect(sessionExpiry("jwt.eyJleHAiOjF9.signature")).toBe(1000);
  });

  it("keeps the queue generation across a verified same-account refresh", () => {
    const session = createQueueSession({ token: "a-first", owner: "a" });
    const before = session.snapshot();
    const owner = session.owner()!;
    expect(session.update(before, { token: "a-renewed", owner: "a" })).toBe(true);
    expect(session.owns(owner)).toBe(true);
    expect(session.snapshot().token).toBe("a-renewed");
    expect(session.update(before, { token: "a-first", owner: "a" })).toBe(false);
  });

  it("rejects an old identity response and keeps the original key available when A returns", () => {
    const session = createQueueSession({ token: "a-first", owner: "a" });
    const pending = session.snapshot();
    const a = session.owner()!;
    session.reset();
    expect(session.update(session.snapshot(), { token: "b-first", owner: "b" })).toBe(true);
    expect(session.update(pending, { token: "a-first", owner: "a" })).toBe(false);
    expect(session.owns(a)).toBe(false);
    expect(session.owner()?.id).toBe("b");
    session.reset();
    expect(session.update(session.snapshot(), { token: "a-first", owner: "a" })).toBe(true);
    expect(session.matches(pending)).toBe(false);
    expect(session.owns(a)).toBe(false);
    expect(accountQueueKey("queue", session.owner()!)).toBe(accountQueueKey("queue", a));
  });

  it("keeps entries queued when replay's original generation loses the session", async () => {
    const session = createQueueSession({ token: "a-first", owner: "a" });
    const owner = session.owner()!;
    const request = vi.fn(async () => {
      if (!session.owns(owner)) throw new Error("stale");
      session.reset();
      session.update(session.snapshot(), { token: "b-first", owner: "b" });
    });
    const result = await replayQueue([project, upload()], {
      createProject: request,
      upload: async () => { if (!session.owns(owner)) throw new Error("stale"); },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.remaining).toEqual([upload()]);
    expect(session.owner()?.id).toBe("b");
  });
});


describe("managed media", () => {
  it("round-trips the managed flag and rejects other types", () => {
    const managed = upload({ managed: true });
    expect(parseQueue(serializeQueue([managed]))).toEqual([managed]);
    expect(parseQueue(JSON.stringify([{ ...upload(), managed: "yes" }]))).toEqual([]);
  });

  it("discards only the abandoned entry and keeps the rest", async () => {
    const { owner, queue } = queueFixture();
    const kept = upload({ id: "kept" });
    await queue.enqueue(owner, kept);
    await queue.enqueue(owner, upload({ id: "abandoned" }));

    await queue.discard(owner, "abandoned");

    expect(await queue.load(owner)).toEqual([kept]);
  });

  it("surfaces a typed error for a missing copy", () => {
    const error = new QueuedMediaMissing();
    expect(isQueuedMediaMissing(error)).toBe(true);
    expect(isQueuedMediaMissing(new Error("其它"))).toBe(false);
  });
});

describe("idempotency keys", () => {
  it("gives a legacy project draft a key before the first attempt and reuses it on retry", async () => {
    const { owner, queue, write } = queueFixture();
    const legacy = { kind: "project" as const, id: "legacy-project", name: "Studio", createdAt: 1 };
    await queue.enqueue(owner, legacy);
    const seen: (string | undefined)[] = [];
    let attempt = 0;
    const handlers = {
      createProject: vi.fn(async (_name: string, key?: string) => {
        seen.push(key);
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
      }),
      upload: vi.fn(),
    };

    await expect(queue.replay(owner, handlers)).resolves.toEqual({ created: 0, uploaded: 0, dropped: 0 });
    expect(seen[0]).toMatch(/^[0-9a-f-]{32,36}$/);
    const [stored] = await queue.load(owner);
    expect(stored).toMatchObject({ id: "legacy-project", idempotencyKey: seen[0] });
    expect(write).toHaveBeenCalled();

    await expect(queue.replay(owner, handlers)).resolves.toEqual({ created: 1, uploaded: 0, dropped: 0 });
    expect(seen).toEqual([seen[0], seen[0]]);
    expect(await queue.load(owner)).toEqual([]);
  });

  it("keeps the key supplied by the enqueueing client", async () => {
    const { owner, queue } = queueFixture();
    await queue.enqueue(owner, { ...project, idempotencyKey: "minted-earlier" });
    const createProject = vi.fn(async () => undefined);
    await queue.replay(owner, { createProject, upload: vi.fn() });
    expect(createProject).toHaveBeenCalledWith(project.name, "minted-earlier");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function queueFixture() {
  const owner = { id: "a", generation: 1 };
  let current = owner;
  const data = new Map<string, string>();
  const read = vi.fn(async (account: QueueOwner) => parseQueue(data.get(account.id) ?? null));
  const write = vi.fn(async (account: QueueOwner, entries: QueuedEntry[]) => {
    data.set(account.id, serializeQueue(entries));
  });
  const queue = createNativeQueue({
    read,
    write,
    isCurrent: (account) => current.id === account.id && current.generation === account.generation,
  });
  return { owner, queue, read, write, switchTo: (next: QueueOwner) => { current = next; } };
}

describe("native queue concurrency", () => {
  it("serializes queued appends and keeps their order", async () => {
    const { owner, queue, read } = queueFixture();
    const firstRead = deferred();
    read.mockImplementationOnce(async () => { await firstRead.promise; return []; });
    const first = queue.enqueue(owner, project);
    const second = queue.enqueue(owner, upload());
    firstRead.resolve();

    await Promise.all([first, second]);
    await queue.enqueue(owner, project);
    expect(await queue.load(owner)).toEqual([project, upload()]);
  });

  it("shares replay and foreground work while preserving an entry added during replay", async () => {
    const { owner, queue } = queueFixture();
    const queued = upload();
    await queue.enqueue(owner, queued);
    const started = deferred();
    const finish = deferred();
    const send = vi.fn(async () => { started.resolve(); await finish.promise; });
    const foreground = vi.fn();
    const handlers = { createProject: vi.fn(), upload: send };
    const replay = queue.replay(owner, handlers);
    await started.promise;
    expect(queue.replay(owner, handlers)).toBe(replay);
    const joined = queue.upload(owner, queued.id, foreground);
    await queue.enqueue(owner, project);
    expect(await queue.load(owner)).toEqual([queued, project]);
    finish.resolve();

    expect(await replay).toEqual({ created: 0, uploaded: 1, dropped: 0 });
    await expect(joined).resolves.toBe("uploaded");
    expect(send).toHaveBeenCalledTimes(1);
    expect(foreground).not.toHaveBeenCalled();
    expect(await queue.load(owner)).toEqual([project]);
  });

  it("skips a claimed entry during replay and preserves simultaneous asset ID updates", async () => {
    const { owner, queue } = queueFixture();
    const first = upload({ id: "first" });
    const second = upload({ id: "second" });
    await queue.enqueue(owner, first);
    await queue.enqueue(owner, second);
    const firstClaimed = deferred();
    const secondClaimed = deferred();
    const saveIds = deferred();
    const idsSaved = deferred();
    const finish = deferred();
    const firstUpload = queue.upload(owner, first.id, async (_, onAsset) => {
      firstClaimed.resolve();
      await saveIds.promise;
      await onAsset("asset-first");
      idsSaved.resolve();
      await finish.promise;
    });
    await firstClaimed.promise;

    const send = vi.fn(async (entry: QueuedUpload, onAsset: (assetId: string) => Promise<void>) => {
      expect(entry.id).toBe(second.id);
      secondClaimed.resolve();
      await saveIds.promise;
      await onAsset("asset-second");
      await finish.promise;
    });
    const replay = queue.replay(owner, { createProject: vi.fn(), upload: send });
    await secondClaimed.promise;
    saveIds.resolve();
    await idsSaved.promise;
    const rows = await queue.load(owner);
    expect(rows).toEqual([{ ...first, assetId: "asset-first" }, { ...second, assetId: "asset-second" }]);
    finish.resolve();

    await expect(replay).resolves.toEqual({ created: 0, uploaded: 1, dropped: 0 });
    await expect(firstUpload).resolves.toBe("uploaded");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await queue.load(owner)).toEqual([]);
  });

  it("keeps the queued entry when storage fails before transfer and reuses the persisted asset ID on retry", async () => {
    const { owner, queue, write } = queueFixture();
    const item = upload();
    await queue.enqueue(owner, item);
    write.mockRejectedValueOnce(new Error("storage full"));
    const sendBytes = vi.fn().mockRejectedValueOnce(new Error("network interrupted"));
    const attempt = (row: QueuedUpload, remember: (id: string) => Promise<void>) =>
      remember(row.assetId ?? "asset-current").then(sendBytes);

    await expect(queue.upload(owner, item.id, attempt)).rejects.toThrow("本地离线队列");
    expect(sendBytes).not.toHaveBeenCalled();
    expect(await queue.load(owner)).toEqual([item]);

    await queue.enqueue(owner, project);
    await expect(queue.upload(owner, item.id, attempt)).rejects.toThrow("network interrupted");
    expect(await queue.load(owner)).toEqual([{ ...item, assetId: "asset-current" }, project]);
    const resumed = vi.fn();
    await queue.upload(owner, item.id, resumed);
    expect(resumed.mock.calls[0][0].assetId).toBe("asset-current");
    expect(await queue.load(owner)).toEqual([project]);
  });

  it("leaves storage alone after a read error and reports a replay write failure", async () => {
    const { owner, queue, read, write } = queueFixture();
    const item = upload();
    await queue.enqueue(owner, item);
    read.mockRejectedValueOnce(new Error("temporarily unreadable"));
    await expect(queue.enqueue(owner, project)).rejects.toThrow("本地离线队列");
    expect(write).toHaveBeenCalledTimes(1);
    expect(await queue.load(owner)).toEqual([item]);

    write.mockRejectedValueOnce(new Error("storage full"));
    const uploadWithAssetId = vi.fn(async (_, onAsset) => { await onAsset("asset-current"); });
    await expect(queue.replay(owner, { createProject: vi.fn(), upload: uploadWithAssetId })).rejects.toThrow("本地离线队列");
    expect(await queue.load(owner)).toEqual([item]);
    await queue.enqueue(owner, project);
    expect(await queue.load(owner)).toEqual([item, project]);
  });

  it("commits an in-flight success under its captured account and drops completed conflicts", async () => {
    const { owner, queue, switchTo } = queueFixture();
    const item = upload();
    await queue.enqueue(owner, item);
    const started = deferred();
    const finish = deferred();
    const old = queue.upload(owner, item.id, async () => { started.resolve(); await finish.promise; });
    await started.promise;
    const other = { id: "b", generation: 2 };
    switchTo(other);
    await queue.enqueue(other, item);
    await queue.enqueue(other, project);
    const conflict = vi.fn().mockRejectedValue({ status: 409 });
    await expect(queue.upload(other, item.id, conflict)).resolves.toBe("dropped");
    await queue.enqueue(other, item);
    finish.resolve();

    await expect(old).resolves.toBe("uploaded");
    expect(await queue.load(owner)).toEqual([]);
    expect(await queue.load(other)).toEqual([project, item]);
  });
});
