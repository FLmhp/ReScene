import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResceneApiError,
  ResceneClient,
  explainError,
  isOfflineError,
  nextPollDelay,
  nextReconnectDelay,
  type JobEvent,
} from "./index";

const project = { id: "p1", name: "Kitchen", owner_id: "u1", effective_role: "owner", created_at: "2026-01-01T00:00:00Z" };
const job = {
  id: "j1", project_id: "p1", profile: "balanced", status: "SUCCEEDED", progress: 1,
  current_stage: "done", attempt: 1, cancel_requested: false, error_code: null, error_message: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:10:00Z", reconstruction_id: "r1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request handling", () => {
  it("uses the platform transport when the runtime has no fetch binding", async () => {
    vi.stubGlobal("fetch", undefined);
    const transport = vi.fn(async () => jsonResponse([project]));
    const projects = await new ResceneClient("https://api.example", "token-1", transport).listProjects();
    expect(projects[0]?.id).toBe("p1");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("sends the bearer token and validates the payload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([project]));
    vi.stubGlobal("fetch", fetchMock);

    const projects = await new ResceneClient("https://api.example", "token-1").listProjects();

    expect(projects[0]?.name).toBe("Kitchen");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("surfaces the server detail as a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "All assets must be ready" }, 422)));

    await expect(new ResceneClient("https://api.example", "t").createJob("p1", "balanced", ["a"])).rejects.toMatchObject({
      status: 422,
      detail: "All assets must be ready",
    });
  });

  it("rejects a payload that drifts from the contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "p1" })));

    await expect(new ResceneClient("https://api.example", "t").getProject("p1")).rejects.toThrow();
  });
});

describe("account, project and share contracts", () => {
  it("reads the current production workspace through its full project response", async () => {
    const cover = { id: "image", filename: "cover.PNG", size: 12, status: "READY" };
    const assets = [cover, { id: "video", filename: "clip.mp4", size: 15, status: "READY" }];
    const runningJob = { ...job, status: "RUNNING" };
    const transport = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ ...project, assets, jobs: [runningJob] }));
    const client = new ResceneClient("https://api.example", "t", transport);

    await expect(client.getWorkspace("p1")).resolves.toMatchObject({
      assets: assets.slice().reverse(), jobs: [runningJob], nextAssetCursor: null, nextJobCursor: null,
    });
    await expect(client.getProjectSummary("p1")).resolves.toMatchObject({
      asset_count: 2, job_count: 1, has_active_jobs: true, cover, latest_job: runningJob,
    });
    expect(transport.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("https://api.example/v1/projects/p1?view=summary"));
  });

  it("keeps native pagination when the server supports project summaries", async () => {
    const summary = { ...project, asset_count: 0, job_count: 1, has_active_jobs: false, cover: null, latest_job: job };
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("?view=summary")) return jsonResponse(summary);
      if (String(input).endsWith("/assets?cursor=old")) return jsonResponse({ items: [], next_cursor: null });
      if (String(input).endsWith("/jobs?cursor=")) return jsonResponse({ items: [job], next_cursor: "next" });
      return jsonResponse({ detail: "Not Found" }, 404);
    });
    await expect(new ResceneClient("https://api.example", "t", transport).getWorkspace("p1", "old"))
      .resolves.toMatchObject({ ...summary, assets: [], jobs: [job], nextAssetCursor: null, nextJobCursor: "next" });
  });

  it("registers an account and adopts the returned token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ access_token: "token-2", token_type: "bearer" }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "token");
    expect(await client.register("new@example.com", "correct-horse-1")).toEqual({
      access_token: "token-2",
      token_type: "bearer",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example/v1/auth/register");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ email: "new@example.com", password: "correct-horse-1" }),
    });
    expect(client.getToken()).toBe("token-2");
  });

  it("uses the documented methods, payloads and response shapes", async () => {
    const member = { user_id: "u2", email: "member@example.com", role: "viewer" };
    const responses = [
      jsonResponse({ id: "u1", email: "owner@example.com", is_admin: false }),
      jsonResponse(project),
      jsonResponse({ ...project, assets: [], jobs: [] }),
      jsonResponse([{ user_id: "u1", email: "owner@example.com", role: "owner" }, member]),
      jsonResponse({ status: "member", user_id: "u2", role: "viewer" }, 201),
      jsonResponse({ ...member, role: "member" }),
      new Response(null, { status: 204 }),
      jsonResponse([{ id: "s1", expires_at: null, revoked_at: null, token: "must-not-leak" }]),
      jsonResponse({ id: "s1", token: "secret", expires_at: "2027-01-01T00:00:00Z" }, 201),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "token");
    expect(await client.getMe()).toMatchObject({ id: "u1" });
    expect(await client.updateProject("p/1", "Kitchen")).toEqual(project);
    expect(await client.getProject("p1")).toMatchObject({ owner_id: "u1", effective_role: "owner" });
    expect(await client.listMembers("p1")).toHaveLength(2);
    expect(await client.addMember("p1", member.email, "viewer")).toEqual({ status: "member", user_id: "u2", role: "viewer" });
    expect(await client.updateMemberRole("p1", "u2", "member")).toMatchObject({ role: "member" });
    await client.removeMember("p1", "u2");
    expect(await client.listShares("r1")).toEqual([{ id: "s1", expires_at: null, revoked_at: null }]);
    expect(await client.createShare("r1", "2027-01-01T00:00:00Z")).toMatchObject({ token: "secret" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example/v1/projects/p%2F1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ name: "Kitchen" }) });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ email: member.email, role: "viewer" }) });
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ role: "member" }) });
    expect(fetchMock.mock.calls[6]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[8]?.[1]).toMatchObject({ body: JSON.stringify({ expires_at: "2027-01-01T00:00:00Z" }) });
  });

  it("clears the local token even when logout fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const client = new ResceneClient("https://api.example", "token");
    await expect(client.logout()).rejects.toThrow("offline");
    expect(client.getToken()).toBeNull();
  });
});

describe("job streaming", () => {
  it("delivers stage events and the final job", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'id: 1\nevent: stage\ndata: {"stage":"training","status":"running","progress":0.4,"message":null,"metrics":{}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: final\ndata: {"id":"j1","project_id":"p1","profile":"balanced","status":"SUCCEEDED","progress":1,"current_stage":"done","attempt":1,"cancel_requested":false,"error_code":null,"error_message":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:10:00Z","reconstruction_id":"r1"}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );

    const events: JobEvent[] = [];
    const stop = new ResceneClient("https://api.example", "t").subscribeJob("j1", (event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(2));
    stop();

    expect(events[0]).toMatchObject({ stage: "training", progress: 0.4 });
    expect(events[1]).toMatchObject({ status: "SUCCEEDED", reconstruction_id: "r1" });
  });
});

describe("subscription recovery and disposal", () => {
  it.each(["sse", "polling"] as const)("stops %s immediately on expired credentials", async (transport) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ detail: "Invalid token" }, 401));
      vi.stubGlobal("fetch", fetchMock);
      const onError = vi.fn();
      const stop = new ResceneClient("https://api.example", "expired").subscribeJob(
        "j1", vi.fn(), onError, { transport, pollIntervalMs: 10 },
      );
      await vi.runAllTimersAsync();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ status: 401, message: "Session expired. Please sign in again." });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a cleanly ended stream using the opaque query cursor", async () => {
    const stage = JSON.stringify({ stage: "training", status: "running", progress: 0.4, message: null, metrics: {} });
    const streamResponse = (data: string) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    let calls = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ++calls === 1
        ? streamResponse(`id: stage-uuid%1\r\nevent: stage\r\ndata: ${stage}\r\n\r\n`)
        : streamResponse(`id: stage-uuid%1\nevent: stage\ndata: ${stage}\n\nevent: final\ndata: ${JSON.stringify(job)}\n\n`),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events: JobEvent[] = [];
    const stop = new ResceneClient("https://api.example", "token").subscribeJob("j1", (event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 3000 });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example/v1/jobs/j1/events?lastEventId=stage-uuid%251");
    expect(events[1]).toMatchObject({ status: "SUCCEEDED", reconstruction_id: "r1" });
    stop();
  });

  it("refreshes the job immediately when a reconnect cursor is rejected", async () => {
    const stage = JSON.stringify({ stage: "training", status: "running", progress: 0.4, message: null, metrics: {} });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(`id: expired-stage\nevent: stage\ndata: ${stage}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(jsonResponse(job));
    vi.stubGlobal("fetch", fetchMock);
    const events: JobEvent[] = [];
    const onError = vi.fn();
    const stop = new ResceneClient("https://api.example", "token").subscribeJob("j1", (event) => events.push(event), onError);
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 3000 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example/v1/jobs/j1/events",
      "https://api.example/v1/jobs/j1/events?lastEventId=expired-stage",
      "https://api.example/v1/jobs/j1",
    ]);
    expect(events[1]).toMatchObject({ status: "SUCCEEDED", reconstruction_id: "r1" });
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("polls immediately without streaming dependencies and delivers terminal identity", async () => {
    vi.stubGlobal("AbortController", undefined);
    const fetchMock = vi.fn(async () => jsonResponse(job));
    vi.stubGlobal("fetch", fetchMock);
    const events: JobEvent[] = [];
    const stop = new ResceneClient("https://api.example", "token").subscribeJob(
      "j1", (event) => events.push(event), undefined, { transport: "polling", pollIntervalMs: 10 },
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ status: "SUCCEEDED", reconstruction_id: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not deliver an in-flight polling response after disposal", async () => {
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    const onEvent = vi.fn();
    const onError = vi.fn();
    const stop = new ResceneClient("https://api.example", "token").subscribeJob(
      "j1", onEvent, onError, { transport: "polling" },
    );
    stop();
    resolveResponse(jsonResponse(job));
    await vi.waitFor(() => expect(resolveResponse).toBeDefined());
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("error identity", () => {
  it("keeps the request id for support", () => {
    const error = new ResceneApiError(500, "boom", "req-9");
    expect(error.requestId).toBe("req-9");
    expect(error.message).toBe("boom");
  });
});

describe("error codes and retry hints", () => {
  it("exposes the machine code, retry delay and request id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Too many requests" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-Error-Code": "auth.rate_limited",
              "Retry-After": "42",
              "X-Request-Id": "req-1",
            },
          }),
      ),
    );

    await expect(new ResceneClient("https://api.example").login("a@example.com", "secret")).rejects.toMatchObject({
      status: 429,
      code: "auth.rate_limited",
      retryAfterSeconds: 42,
      requestId: "req-1",
    });
  });

  it("maps stable codes to Chinese copy and otherwise keeps the server detail", () => {
    expect(explainError(new ResceneApiError(409, "Asset is used by a job", undefined, "asset.in_use"), "操作失败")).toBe(
      "该素材已被任务使用，无法删除。",
    );
    expect(explainError(new ResceneApiError(500, "boom"), "操作失败")).toBe("boom");
    expect(explainError(new Error("Failed to fetch"), "操作失败")).toBe("操作失败");
  });

  it("separates transport failures from server answers", () => {
    expect(isOfflineError(new TypeError("Network request failed"))).toBe(true);
    expect(isOfflineError({ errMsg: "request:fail timeout" })).toBe(true);
    expect(isOfflineError(new ResceneApiError(503, "unavailable"))).toBe(false);
    expect(isOfflineError(new Error("boom"))).toBe(false);
  });

  it("backs off polling and stream reconnects", () => {
    expect([0, 1, 2, 3, 4].map((failures) => nextPollDelay(2000, failures))).toEqual([
      2000, 4000, 8000, 15000, 15000,
    ]);
    expect([0, 1, 2, 3, 4].map((failures) => nextReconnectDelay(failures))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });
});

describe("asset, stage, notification and admin contracts", () => {
  const stage = {
    id: "s1", stage: "colmap", status: "success", progress: 0.5, message: null,
    metrics: { registered: 12 }, created_at: "2026-01-01T00:00:00Z",
  };
  const notification = {
    id: "n1", kind: "job.succeeded", title: "重建已完成", body: "项目「厨房」的重建已完成",
    project_id: "p1", job_id: "j1", announcement_id: null, read_at: null, created_at: "2026-01-01T00:00:00Z",
  };
  const invitation = { id: "i1", email: "guest@example.com", role: "viewer", created_at: "2026-01-01T00:00:00Z" };
  const adminUser = {
    id: "u2", email: "member@example.com", is_admin: false, active: true, created_at: "2026-01-01T00:00:00Z",
  };
  const entry = {
    id: "l1", actor_email: null, action: "job.complete", target_type: "job", target_id: "j1",
    project_id: null, project_name: null, metadata: { worker_id: "w1" }, created_at: "2026-01-01T00:00:00Z",
  };

  it("calls every new endpoint with its documented method, path and payload", async () => {
    const responses = [
      new Response(null, { status: 204 }),
      jsonResponse([stage]),
      jsonResponse({ access_token: "token-3", token_type: "bearer" }),
      jsonResponse([notification]),
      jsonResponse({ updated: 1 }),
      jsonResponse({ total: 1, items: [adminUser] }),
      jsonResponse({ ...adminUser, active: false }),
      new Response(null, { status: 204 }),
      jsonResponse([invitation]),
      new Response(null, { status: 204 }),
      jsonResponse({ total: 1, items: [entry] }),
      jsonResponse({ status: "invited", email: "guest@example.com", role: "viewer" }, 201),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "token");

    await client.deleteAsset("a/1");
    expect((await client.getJobStages("j1"))[0]).toMatchObject({ stage: "colmap", metrics: { registered: 12 } });
    expect(await client.changePassword("old-horse-1", "new-horse-12")).toEqual({
      access_token: "token-3",
      token_type: "bearer",
    });
    expect(client.getToken()).toBe("token-3");
    expect(await client.listNotifications(true, 20)).toEqual([notification]);
    expect(await client.markNotificationsRead(["n1"])).toEqual({ updated: 1 });
    expect(await client.listUsers({ query: "example", limit: 5 })).toEqual({ total: 1, items: [adminUser] });
    expect(await client.updateUser("u2", { active: false })).toMatchObject({ active: false });
    await client.resetUserPassword("u2", "fresh-horse-1");
    expect(await client.listInvitations("p1")).toEqual([invitation]);
    await client.revokeInvitation("p1", "i1");
    expect(await client.listProjectAudit("p1")).toEqual({ total: 1, items: [entry] });
    expect(await client.addMember("p1", "guest@example.com", "viewer")).toEqual({
      status: "invited",
      email: "guest@example.com",
      role: "viewer",
    });

    const calls = fetchMock.mock.calls.map(([input, init]) => [
      String(input),
      (init as RequestInit | undefined)?.method ?? "GET",
    ]);
    expect(calls).toEqual([
      ["https://api.example/v1/assets/a%2F1", "DELETE"],
      ["https://api.example/v1/jobs/j1/stages", "GET"],
      ["https://api.example/v1/auth/password", "POST"],
      ["https://api.example/v1/notifications?unread=1&limit=20&offset=0", "GET"],
      ["https://api.example/v1/notifications/read", "POST"],
      ["https://api.example/v1/users?query=example&limit=5", "GET"],
      ["https://api.example/v1/users/u2", "PATCH"],
      ["https://api.example/v1/users/u2/password", "POST"],
      ["https://api.example/v1/projects/p1/invitations", "GET"],
      ["https://api.example/v1/projects/p1/invitations/i1", "DELETE"],
      ["https://api.example/v1/projects/p1/audit?limit=50", "GET"],
      ["https://api.example/v1/projects/p1/members", "POST"],
    ]);
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ current_password: "old-horse-1", new_password: "new-horse-12" }),
    );
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).body).toBeUndefined();
    expect((fetchMock.mock.calls[4]?.[1] as RequestInit).body).toBe(JSON.stringify({ ids: ["n1"] }));
    expect((fetchMock.mock.calls[11]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ email: "guest@example.com", role: "viewer" }),
    );
    expect(client.shareQrUrl("tok/en")).toBe("https://api.example/v1/public/shares/tok%2Fen/qr.png");
  });

  it("parses the member outcome of the same endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "member", user_id: "u2", role: "member" }, 201)),
    );

    expect(
      await new ResceneClient("https://api.example", "t").addMember("p1", "member@example.com", "member"),
    ).toEqual({ status: "member", user_id: "u2", role: "member" });
  });

  it("keeps the issued code and accepts it in an authenticated request body", async () => {
    const invitation = {
      status: "invited", email: "guest@example.com", role: "viewer",
      claim_code: "issued-invitation", expires_at: "2026-11-27T00:00:00Z",
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(invitation, 201))
      .mockResolvedValueOnce(jsonResponse({ project_id: "p1", role: "viewer" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ResceneClient("https://api.example", "token");
    expect(await client.addMember("p1", "guest@example.com", "viewer")).toEqual(invitation);
    expect(await client.acceptInvitation(" issued-invitation ")).toEqual({ project_id: "p1", role: "viewer" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://api.example/v1/project-invitations/accept");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(String(init?.body))).toEqual({ code: "issued-invitation" });
  });
});

describe("admin console endpoints", () => {
  const adminUser = {
    id: "u2", email: "ops@example.com", is_admin: false, active: true, created_at: "2026-01-01T00:00:00Z",
  };
  const detail = { ...adminUser, memberships: [{ project_id: "p1", name: "厨房", role: "member" }] };
  const announcement = {
    id: "a1", title: "维护", body: "今晚 23:00", level: "warning", created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
  };
  const entry = {
    id: "l1", actor_email: "ops@example.com", action: "user.update", target_type: "user", target_id: "u2",
    project_id: null, project_name: null, metadata: {}, created_at: "2026-01-01T00:00:00Z",
  };
  const logLine = { id: 7, level: "error", message: "gsplat failed", created_at: "2026-01-01T00:00:00Z" };

  it("pages the user directory and loads one account", async () => {
    const responses = [jsonResponse({ total: 3, items: [adminUser] }), jsonResponse(detail)];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "t");

    const page = await client.listUsers({ query: "ops", active: false, isAdmin: true, offset: 20, limit: 20 });
    expect(page.total).toBe(3);
    expect(page.items[0]?.email).toBe("ops@example.com");
    expect((await client.getUser("u 2")).memberships).toEqual([{ project_id: "p1", name: "厨房", role: "member" }]);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.example/v1/users?query=ops&active=false&is_admin=true&offset=20&limit=20",
      "https://api.example/v1/users/u%202",
    ]);
  });

  it("publishes, lists and retracts announcements", async () => {
    const responses = [
      jsonResponse(announcement, 201),
      jsonResponse([announcement]),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "t");

    expect(await client.createAnnouncement({ title: "维护", body: "今晚 23:00", level: "warning" })).toEqual(
      announcement,
    );
    expect(await client.listAnnouncements()).toEqual([announcement]);
    await client.deleteAnnouncement("a1");

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), (init as RequestInit).method ?? "GET"])).toEqual([
      ["https://api.example/v1/announcements", "POST"],
      ["https://api.example/v1/announcements?limit=50", "GET"],
      ["https://api.example/v1/announcements/a1", "DELETE"],
    ]);
  });

  it("filters the global trail and downloads it as CSV", async () => {
    const responses = [
      jsonResponse({ total: 1, items: [entry] }),
      jsonResponse(["project.create", "user.update"]),
      new Response("time,actor\n", { status: 200, headers: { "content-type": "text/csv" } }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "t");

    expect((await client.listAudit({ actor: "ops", action: "user.", projectId: "p1", limit: 10 })).total).toBe(1);
    expect(await client.auditActionList()).toEqual(["project.create", "user.update"]);
    expect(await (await client.auditCsv({ since: "2026-01-01T00:00:00Z" })).text()).toBe("time,actor\n");

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.example/v1/audit?actor=ops&action=user.&project_id=p1&limit=10",
      "https://api.example/v1/audit/actions",
      "https://api.example/v1/audit.csv?since=2026-01-01T00%3A00%3A00Z",
    ]);
  });

  it("tails job logs and reads the unread badge", async () => {
    const responses = [jsonResponse({ items: [logLine] }), jsonResponse({ unread: 4 })];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResceneClient("https://api.example", "t");

    expect(await client.listJobLogs("j1", { afterId: 12, level: "error", limit: 50 })).toEqual([logLine]);
    expect(await client.notificationCount()).toBe(4);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.example/v1/jobs/j1/logs?after_id=12&level=error&limit=50",
      "https://api.example/v1/notifications/count",
    ]);
  });
});
