import { ResceneClient, type JobEvent } from "@rescene/api-client";
import type { AdminUserPage, AppNotification, JobLog } from "@rescene/schemas";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UploadAdapter } from "@rescene/uploader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyValueStore } from "./Workbench";
import { Workbench } from "./Workbench";

const project = {
  id: "p1",
  name: "Kitchen",
  owner_id: "u1",
  effective_role: "owner",
  created_at: "2026-01-01T00:00:00Z",
};

const asset = { id: "a1", filename: "frame.jpg", size: 2048, status: "READY" };

function projectDetail(effectiveRole: "owner" | "viewer" | "member" | "admin") {
  return {
    id: "p1",
    name: "Kitchen",
    owner_id: "u1",
    effective_role: effectiveRole,
    assets: [asset],
    jobs: [],
  };
}

function routeTable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/v1/auth/login": { access_token: "token-1", token_type: "bearer" },
    "/v1/auth/register": { access_token: "token-2", token_type: "bearer" },
    "/v1/auth/me": { id: "u1", email: "ops@example.com", is_admin: false },
    "/v1/projects": [project],
    "/v1/projects/p1": projectDetail("owner"),
    "/v1/projects/p1/members": [
      { user_id: "u1", email: "ops@example.com", role: "owner" },
      { user_id: "u2", email: "teammate@example.com", role: "viewer" },
    ],
    "/v1/projects/p1/invitations": [],
    "/v1/projects/p1/audit": [],
    "/v1/jobs/j1/stages": [],
    "/v1/notifications": [],
    "/v1/workers/status": {
      online: true,
      workers: [{ id: "w1", gpu_name: "RTX 5090", online: true, last_seen_at: null }],
    },
    ...overrides,
  };
}

type RouteValue = unknown | ((url: URL) => unknown);

function summaryFields(value: unknown) {
  if (!value || typeof value !== "object" || !("assets" in value) || !("jobs" in value) || !Array.isArray(value.assets) || !Array.isArray(value.jobs)) return null;
  const assets = value.assets;
  const jobs = value.jobs;
  return { asset_count: assets.length, job_count: jobs.length, has_active_jobs: false, cover: assets[0] ?? null, latest_job: jobs[0] ?? null };
}

function stubFetch(routes: Record<string, RouteValue>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname;
      let route = routes[`${method} ${path}${url.search}`] ?? routes[`${method} ${path}`] ?? routes[path];
      if (method === "GET" && route === undefined && /^\/v1\/projects\/[^/]+\/(assets|jobs)$/.test(path)) {
        const kind = path.endsWith("/assets") ? "assets" : "jobs";
        const full = routes[path.slice(0, path.lastIndexOf("/"))] as { assets?: unknown[]; jobs?: unknown[] } | undefined;
        if (full) route = { items: full[kind] ?? [], next_cursor: null };
      }
      if (route === undefined) return new Response("{}", { status: 404 });
      let value = typeof route === "function" ? (route as (url: URL) => unknown)(url) : route;
      const summary = summaryFields(value);
      if (url.searchParams.get("view") === "summary" && summary && value && typeof value === "object") {
        value = { ...value, ...summary };
      } else if (path === "/v1/projects" && url.searchParams.get("view") === "summary" && Array.isArray(value)) {
        value = value.map((item: unknown) => {
          if (!item || typeof item !== "object" || "asset_count" in item) return item;
          const id = "id" in item && typeof item.id === "string" ? item.id : "";
          const detail = id ? routes[`/v1/projects/${id}`] : undefined;
          const resolved = typeof detail === "function" ? (detail as (url: URL) => unknown)(url) : detail;
          return { ...item, ...(summaryFields(resolved) ?? { asset_count: 0, job_count: 0, has_active_jobs: false, cover: null, latest_job: null }) };
        });
      }
      if (value && typeof value === "object" && "status" in value && typeof (value as { status: unknown }).status === "number") {
        const spec = value as { status: number; body?: unknown };
        return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
          status: spec.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

const uploader = { upload: async () => ({ assetId: "a1" }) };
const viewer = () => <div data-testid="viewer" />;

function renderWorkbench(client = new ResceneClient("https://api.example"), store = memoryStore(), adapter: UploadAdapter = uploader) {
  render(
    <Workbench
      client={client}
      uploader={adapter}
      viewer={viewer}
      tokenStore={store}
      webBaseUrl="https://app.example"
    />,
  );
  return store;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("session gate", () => {
  it("keeps off-page selections and sends both pages' asset IDs", async () => {
    const second = { ...asset, id: "a2", filename: "second.jpg" };
    const job = { id: "new-job", project_id: "p1", profile: "balanced", status: "QUEUED", progress: 0, attempt: 0,
      cancel_requested: false, created_at: "2026-01-01", updated_at: "2026-01-01" };
    const client = new ResceneClient("https://api.example");
    const submit = vi.spyOn(client, "createJob").mockResolvedValue(job as Awaited<ReturnType<typeof client.createJob>>);
    stubFetch(routeTable({
      "/v1/projects/p1/assets": (url: URL) => url.searchParams.get("cursor") === "second"
        ? { items: [second], next_cursor: null } : { items: [asset], next_cursor: "second" },
      "/v1/jobs/new-job": job,
    }));
    renderWorkbench(client, memoryStore({ "rescene-token": "token-1", "rescene-project": "p1" }));

    await userEvent.click(await screen.findByRole("checkbox", { name: /frame.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("checkbox", { name: /second.jpg/ });
    expect(screen.queryByRole("checkbox", { name: /frame.jpg/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全选本页图片" }));
    expect(screen.getAllByText(/已选 2 个/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    const previous = await screen.findByRole<HTMLInputElement>("checkbox", { name: /frame.jpg/ });
    expect(previous.checked).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "配置重建" }));
    await userEvent.click(screen.getByRole("button", { name: "开始重建" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("p1", "balanced", ["a1", "a2"], expect.any(String)));
  });

  it("reuses the retry key after a failed job submission and drops it after success", async () => {
    const job = { id: "new-job", project_id: "p1", profile: "balanced", status: "QUEUED", progress: 0, attempt: 0,
      cancel_requested: false, created_at: "2026-01-01", updated_at: "2026-01-01" };
    const client = new ResceneClient("https://api.example");
    const submit = vi.spyOn(client, "createJob")
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(job as Awaited<ReturnType<typeof client.createJob>>);
    stubFetch(routeTable({ "/v1/jobs/new-job": job }));
    renderWorkbench(client, memoryStore({ "rescene-token": "token-1", "rescene-project": "p1" }));

    await userEvent.click(await screen.findByRole("checkbox", { name: /frame.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "配置重建" }));
    const start = screen.getByRole("button", { name: "开始重建" });
    await userEvent.click(start);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await userEvent.click(start);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await userEvent.click(start);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));

    const keys = submit.mock.calls.map((call) => call[3]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);

    await submit.mock.results[2]?.value;
    await userEvent.click(await screen.findByRole("button", { name: "← 返回任务" }));
    await userEvent.click(await screen.findByRole("button", { name: "素材", pressed: false }));
    await userEvent.click(await screen.findByRole("button", { name: "配置重建" }));
    await userEvent.click(await screen.findByRole("button", { name: "开始重建" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(4));
    expect(submit.mock.calls[3]?.[3]).not.toBe(keys[0]);
  });

  it("registers a new account and keeps the token", async () => {
    stubFetch(routeTable());

    const store = renderWorkbench();

    await userEvent.click(screen.getByRole("button", { name: "注册" }));
    await userEvent.type(screen.getByLabelText("邮箱"), "new@example.com");
    await userEvent.type(screen.getByLabelText("密码"), "correct-horse-1");
    await userEvent.type(screen.getByLabelText("确认密码"), "correct-horse-1");
    await userEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-2"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
  });

  it("stores the access token and shows the signed-in account", async () => {
    stubFetch(routeTable());

    const store = renderWorkbench();

    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("邮箱"), "ops@example.com");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(await screen.findByRole("button", { name: "账户" }));
    expect(screen.getByText(/ops@example\.com/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /frame.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "配置重建" }));
    expect(await screen.findByText(/计算节点在线/)).toBeTruthy();
  });
});

describe("project gallery summaries", () => {
  it("loads twenty projects with one summary list call and no per-card summary requests", async () => {
    const summaries = Array.from({ length: 20 }, (_, index) => ({
      ...project,
      id: `p${index + 1}`,
      name: `Project ${index + 1}`,
      asset_count: index,
      job_count: 0,
      has_active_jobs: false,
      cover: null,
      latest_job: null,
    }));
    stubFetch(routeTable({ "GET /v1/projects?view=summary": summaries }));

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Project 1" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Project 8" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Project 9" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("button", { name: "Project 9" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project 16" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("button", { name: "Project 17" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project 20" })).toBeTruthy();
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)));
    const listCalls = urls.filter((url) => url.pathname === "/v1/projects" && url.searchParams.get("view") === "summary");
    const cardCalls = urls.filter((url) => /^\/v1\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.get("view") === "summary");
    expect(listCalls).toHaveLength(1);
    expect(cardCalls).toHaveLength(0);
  });
});

describe("project roles", () => {
  it("gives an owner member management and upload controls", async () => {
    stubFetch(routeTable());

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Kitchen" }));

    expect(await screen.findByText("选择图片或视频")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "配置重建" })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: /frame\.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "配置重建" }));
    const start = screen.getByRole<HTMLButtonElement>("button", { name: "开始重建" });
    expect(start.disabled).toBe(false);
    const quality = screen.getByRole("button", { name: /精细重建/ });
    await userEvent.click(quality);
    expect(quality.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(await screen.findByRole("button", { name: "返回素材" }));
    await userEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    await waitFor(() => expect(screen.getByLabelText("teammate@example.com 的角色")).toBeTruthy());
    expect(screen.getByText("owner")).toBeTruthy();
  });

  it("renders a viewer project read-only", async () => {
    stubFetch(
      routeTable({
        "/v1/projects": [{ ...project, effective_role: "viewer" }],
        "/v1/projects/p1": projectDetail("viewer"),
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Kitchen" }));

    await waitFor(() => expect(screen.getByText(/只读访问/)).toBeTruthy());
    expect(screen.queryByText("开始重建")).toBeNull();
    expect(screen.queryByRole("button", { name: "配置重建" })).toBeNull();
    expect(screen.queryByText("选择图片或视频")).toBeNull();
    expect(screen.queryByText("项目设置")).toBeNull();
    expect(screen.getByText("frame.jpg")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    expect(screen.getByText("teammate@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("teammate@example.com 的角色")).toBeNull();
  });
});

function notification(read: boolean) {
  return {
    id: "n1",
    kind: "job.succeeded",
    title: "重建已完成",
    body: "项目「Kitchen」的重建已完成",
    project_id: "p1",
    job_id: null,
    announcement_id: null,
    read_at: read ? "2026-01-01T01:00:00Z" : null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("collaboration surfaces", () => {
  it("counts unread notifications and clears them", async () => {
    let read = false;
    stubFetch(
      routeTable({
        "/v1/notifications": () => [notification(read)],
        "POST /v1/notifications/read": () => {
          read = true;
          return { updated: 1 };
        },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("button", { name: "通知（1）" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "通知（1）" }));
    await userEvent.click(await screen.findByText("全部已读"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "通知" })).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/v1/notifications/read"));
    expect(call?.[1]?.method).toBe("POST");
  });

  it("deletes an asset after confirmation", async () => {
    stubFetch(routeTable({ "/v1/assets/a1": { status: 204 } }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Kitchen" }));
    await waitFor(() => expect(screen.getByLabelText("删除 frame.jpg")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("删除 frame.jpg"));

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/v1/assets/a1") && init?.method === "DELETE"),
      ).toBe(true),
    );
    expect(screen.getByText("素材已删除")).toBeTruthy();
  });

  it("changes the password and adopts the returned token", async () => {
    stubFetch(routeTable({ "/v1/auth/password": { access_token: "token-3", token_type: "bearer" } }));

    const store = renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(screen.getByRole("button", { name: "账户" }));
    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
    await userEvent.type(screen.getByLabelText("当前密码"), "correct-horse");
    await userEvent.type(screen.getByLabelText("新密码（至少 12 位）"), "correct-horse-2");
    await userEvent.type(screen.getByLabelText("确认新密码"), "correct-horse-2");
    await userEvent.click(screen.getByText("更新密码"));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-3"));
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/v1/auth/password"));
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      current_password: "correct-horse",
      new_password: "correct-horse-2",
    });
    expect(screen.getByText("密码已更新，其他设备已退出登录。")).toBeTruthy();
  });

  it("asks for reissue when the server's invitation response has no code", async () => {
    stubFetch(
      routeTable({
        "POST /v1/projects/p1/members": { status: 201, body: { status: "invited", email: "guest@example.com", role: "viewer" } },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    await userEvent.type(screen.getByLabelText("成员邮箱"), "guest@example.com");
    await userEvent.click(screen.getByRole("button", { name: "签发邀请" }));

    expect(await screen.findByText(/当前服务端版本无法提供领取码/)).toBeTruthy();
    expect(screen.queryByLabelText("新邀请领取码")).toBeNull();
  });

  it("displays a new code in its own project and clears it when switching", async () => {
    const secondProject = { ...project, id: "p2", name: "Studio" };
    stubFetch(routeTable({
      "/v1/projects": [project, secondProject],
      "/v1/projects/p2": { ...projectDetail("owner"), id: "p2", name: "Studio" },
      "/v1/projects/p2/members": [],
      "/v1/projects/p2/invitations": [],
      "POST /v1/projects/p1/members": {
        status: 201,
        body: {
          status: "invited", email: "guest@example.com", role: "viewer",
          claim_code: "issued-invitation", expires_at: "2026-11-27T00:00:00Z",
        },
      },
    }));
    const store = renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    await userEvent.type(await screen.findByLabelText("成员邮箱"), "guest@example.com");
    await userEvent.click(screen.getByRole("button", { name: "签发邀请" }));
    expect((await screen.findByLabelText<HTMLInputElement>("新邀请领取码")).value).toBe("issued-invitation");
    expect([...store.data.values()]).not.toContain("issued-invitation");

    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Studio" }));
    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    await screen.findByLabelText("成员邮箱");
    expect(screen.queryByLabelText("新邀请领取码")).toBeNull();
  });

  it("claims a project from the authenticated project list", async () => {
    let joined = false;
    stubFetch(routeTable({
      "/v1/projects": () => joined ? [{ ...project, effective_role: "viewer" }] : [],
      "/v1/projects/p1": projectDetail("viewer"),
      "POST /v1/project-invitations/accept": () => {
        joined = true;
        return { project_id: "p1", role: "viewer" };
      },
    }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await userEvent.click(await screen.findByRole("button", { name: "领取邀请" }));
    await userEvent.type(screen.getByLabelText("领取码"), "issued-invitation");
    await userEvent.click(screen.getByRole("button", { name: "领取邀请" }));

    expect(await screen.findByRole("heading", { name: "Kitchen" })).toBeTruthy();
    expect(screen.getByText(/只读访问/)).toBeTruthy();
    expect(screen.queryByLabelText("领取码")).toBeNull();
    const request = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/v1/project-invitations/accept"));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ code: "issued-invitation" });
  });
});

describe("share state", () => {
  function sceneJob(id: string, reconstructionId: string) {
    return {
      id,
      project_id: "p1",
      profile: "balanced",
      status: "SUCCEEDED",
      progress: 1,
      attempt: 1,
      cancel_requested: false,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      reconstruction_id: reconstructionId,
    };
  }

  function shareRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [sceneJob("j1", "r1"), sceneJob("j2", "r2")] },
      "/v1/reconstructions/r1/manifest": { reconstruction_id: "r1", artifacts: [] },
      "/v1/reconstructions/r2/manifest": { reconstruction_id: "r2", artifacts: [] },
      "/v1/reconstructions/r1/shares": [],
      "/v1/reconstructions/r2/shares": [],
      ...overrides,
    });
  }

  async function openTask(index: number) {
    await userEvent.click(await screen.findByRole("button", { name: "任务" }));
    await userEvent.click((await screen.findAllByRole("button", { name: /均衡重建/ }))[index]);
    await userEvent.click(await screen.findByRole("button", { name: "查看结果" }));
  }

  async function openShare(client: ResceneClient, index = 0) {
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await openTask(index);
    await userEvent.click(await screen.findByRole("button", { name: "分享管理" }));
  }

  async function switchToShare(index: number) {
    await userEvent.click(screen.getByRole("button", { name: "← 返回成果" }));
    await userEvent.click(screen.getByRole("button", { name: "← 返回任务详情" }));
    await userEvent.click(screen.getByRole("button", { name: "← 返回任务" }));
    await openTask(index);
    await userEvent.click(await screen.findByRole("button", { name: "分享管理" }));
  }

  it("hides a created link and its QR code when the scene changes", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    stubFetch(shareRoutes());
    vi.spyOn(client, "createShare").mockResolvedValue({ id: "s1", token: "tok-a", expires_at: null });
    await openShare(client);

    await userEvent.click(screen.getByRole("button", { name: "创建分享" }));
    expect((await screen.findByLabelText<HTMLInputElement>("新分享链接")).value).toBe("https://app.example/share/tok-a");
    expect(screen.getByAltText("分享二维码").getAttribute("src")).toContain("tok-a");

    await switchToShare(1);
    await waitFor(() => expect(screen.queryByLabelText("新分享链接")).toBeNull());
    expect(screen.queryByAltText("分享二维码")).toBeNull();
  });

  it("drops a share created for the scene the user already left", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    stubFetch(shareRoutes());
    const creating = Promise.withResolvers<{ id: string; token: string; expires_at: null }>();
    vi.spyOn(client, "createShare").mockReturnValue(creating.promise);
    await openShare(client);

    await userEvent.click(screen.getByRole("button", { name: "创建分享" }));
    await switchToShare(1);
    creating.resolve({ id: "s1", token: "tok-a", expires_at: null });

    await waitFor(() => expect(screen.getByRole("button", { name: "创建分享" })).toBeTruthy());
    expect(screen.queryByLabelText("新分享链接")).toBeNull();
    expect(screen.queryByAltText("分享二维码")).toBeNull();
  });

  it("keeps the newest share list when responses arrive out of order", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    stubFetch(shareRoutes());
    const older = Promise.withResolvers<unknown[]>();
    const newest = Promise.withResolvers<unknown[]>();
    vi.spyOn(client, "listShares").mockReturnValueOnce(older.promise as never).mockReturnValue(newest.promise as never);
    vi.spyOn(client, "createShare").mockResolvedValue({ id: "s9", token: "tok-a", expires_at: null });
    await openShare(client);

    await userEvent.click(screen.getByRole("button", { name: "创建分享" }));
    newest.resolve([{ id: "bbbbbbbb-1", expires_at: null, revoked_at: null }]);
    await waitFor(() => expect(screen.getByText("bbbbbbbb")).toBeTruthy());
    older.resolve([{ id: "aaaaaaaa-1", expires_at: null, revoked_at: null }]);

    await waitFor(() => expect(screen.getByText("bbbbbbbb")).toBeTruthy());
    expect(screen.queryByText("aaaaaaaa")).toBeNull();
  });

  it("keeps the new scene's link when an older revoke returns", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    stubFetch(shareRoutes({
      "/v1/reconstructions/r1/shares": [{ id: "s1", expires_at: null, revoked_at: null }],
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const revoking = Promise.withResolvers<void>();
    vi.spyOn(client, "revokeShare").mockReturnValue(revoking.promise);
    vi.spyOn(client, "createShare").mockResolvedValue({ id: "s2", token: "tok-b", expires_at: null });
    await openShare(client);

    await userEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await switchToShare(1);
    await userEvent.click(screen.getByRole("button", { name: "创建分享" }));
    expect((await screen.findByLabelText<HTMLInputElement>("新分享链接")).value).toBe("https://app.example/share/tok-b");

    revoking.resolve();
    await waitFor(() => expect(revoking.promise).toBeTruthy());
    expect((screen.getByLabelText<HTMLInputElement>("新分享链接")).value).toBe("https://app.example/share/tok-b");
    expect(screen.queryByText(/操作失败/)).toBeNull();
  });
});

const adminSelf = { id: "u1", email: "ops@example.com", is_admin: true };

function adminUser(id: string, email: string, active: boolean, isAdmin = false) {
  return { id, email, is_admin: isAdmin, active, created_at: "2026-01-01T00:00:00Z" };
}

async function openAdminConsole() {
  await userEvent.click(await screen.findByRole("button", { name: "设置" }));
  await userEvent.click(await screen.findByRole("button", { name: "管理控制台" }));
}

function adminRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return routeTable({
    "/v1/auth/me": adminSelf,
    "/v1/users": { total: 1, items: [adminUser("u1", "ops@example.com", true, true)] },
    ...overrides,
  });
}

describe("management console", () => {
  it("opens the console from settings and lists accounts", async () => {
    stubFetch(
      adminRoutes({
        "/v1/users": {
          total: 2,
          items: [adminUser("u1", "ops@example.com", true, true), adminUser("u2", "teammate@example.com", true)],
        },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();

    await waitFor(() => expect(document.querySelector(".user-list")?.textContent).toContain("ops@example.com"));
    expect(document.querySelector(".user-list")?.textContent).toContain("teammate@example.com");
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/v1/users?"));
    expect(call).toBeTruthy();
    expect(String(call?.[0])).toContain("limit=20");
  });

  it("deactivates an account through PATCH", async () => {
    stubFetch(
      adminRoutes({
        "/v1/users": {
          total: 2,
          items: [adminUser("u1", "ops@example.com", false, true), adminUser("u2", "teammate@example.com", true)],
        },
        "PATCH /v1/users/u2": adminUser("u2", "teammate@example.com", false),
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await waitFor(() => expect(screen.getByRole("button", { name: "停用" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "停用" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/users/u2") && init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ active: false });
    });
  });

  it("keeps the newest admin search results when responses arrive out of order", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    const pending: { query: string; resolve: (page: AdminUserPage) => void }[] = [];
    vi.spyOn(client, "listUsers").mockImplementation((params) => {
      const deferred = Promise.withResolvers<AdminUserPage>();
      pending.push({ query: params?.query ?? "", resolve: deferred.resolve });
      return deferred.promise;
    });
    stubFetch(adminRoutes());
    renderWorkbench(client);
    await openAdminConsole();
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve({ total: 1, items: [adminUser("u1", "ops@example.com", true, true)] });
    await waitFor(() => expect(document.querySelector(".user-list")?.textContent).toContain("ops@example.com"));

    const input = screen.getByLabelText("搜索邮箱");
    fireEvent.change(input, { target: { value: "alice" } });
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    fireEvent.change(input, { target: { value: "bob" } });
    expect(screen.getByRole("button", { name: "停用" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(pending).toHaveLength(3), { timeout: 2000 });
    expect(pending[1]?.query).toBe("alice");
    expect(pending[2]?.query).toBe("bob");

    pending[2].resolve({ total: 1, items: [adminUser("u2", "bob@example.com", true)] });
    await waitFor(() => expect(document.querySelector(".user-list")?.textContent).toContain("bob@example.com"));
    expect(screen.getByRole("button", { name: "停用" }).hasAttribute("disabled")).toBe(false);
    pending[1].resolve({ total: 1, items: [adminUser("u3", "alice@example.com", true)] });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".user-list")?.textContent).toContain("bob@example.com");
    expect(document.querySelector(".user-list")?.textContent).not.toContain("alice@example.com");
  });

  it("publishes an announcement and renders it in the list", async () => {
    const published: unknown[] = [];
    stubFetch(
      adminRoutes({
        "/v1/announcements": () => published,
        "POST /v1/announcements": () => {
          const created = {
            id: "an1",
            title: "维护公告",
            body: "今晚 23:00 起维护一小时。",
            level: "warning",
            created_by: "u1",
            created_at: "2026-01-01T00:00:00Z",
          };
          published.push(created);
          return created;
        },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await userEvent.click(screen.getByRole("tab", { name: "公告" }));
    await userEvent.type(screen.getByLabelText("标题"), "维护公告");
    await userEvent.type(screen.getByLabelText("正文"), "今晚 23:00 起维护一小时。");
    await userEvent.click(screen.getByRole("button", { name: "发布公告" }));

    await waitFor(() => expect(screen.getByText("维护公告")).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/announcements") && init?.method === "POST");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ title: "维护公告", body: "今晚 23:00 起维护一小时。", level: "info" });
  });

  it("filters the global audit log and downloads the CSV", async () => {
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:audit"), configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });
    stubFetch(
      adminRoutes({
        "/v1/audit/actions": ["project.rename", "user.update"],
        "/v1/audit": {
          total: 1,
          items: [
            {
              id: "l1",
              actor_email: "ops@example.com",
              action: "project.rename",
              target_type: "project",
              target_id: "p1",
              project_id: "p1",
              project_name: "Kitchen",
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
        "/v1/audit.csv": "time,actor,action\n2026-01-01T00:00:00Z,ops@example.com,project.rename\n",
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await userEvent.click(screen.getByRole("tab", { name: "操作日志" }));
    await userEvent.type(screen.getByLabelText("操作者"), "ops@example.com");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("actor="))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "下载 CSV" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/v1/audit.csv"))).toBe(true));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audit");
  });

  it("toggles the mobile navigation drawer", async () => {
    stubFetch(routeTable());

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());

    expect(document.querySelector("main.shell")?.className).not.toContain("nav-open");
    await userEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(document.querySelector("main.shell")?.className).toContain("nav-open");
  });
});

describe("appearance", () => {
  it("persists an explicit theme without discarding the login form", async () => {
    stubFetch(routeTable());
    renderWorkbench();
    await userEvent.type(screen.getByLabelText("邮箱"), "retained@example.com");
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await userEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect((screen.getByLabelText("邮箱") as HTMLInputElement).value).toBe("retained@example.com");
  });
});

describe("job status reconciliation", () => {
  function jobFixture(status: string, progress: number, updatedAt: string) {
    return {
      id: "j1",
      project_id: "p1",
      profile: "balanced",
      status,
      progress,
      attempt: 1,
      cancel_requested: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: updatedAt,
      reconstruction_id: null,
    };
  }

  async function openQueuedJob() {
    stubFetch(routeTable({ "/v1/projects/p1": { ...projectDetail("owner"), jobs: [jobFixture("QUEUED", 0, "2026-01-01T00:00:00Z")] } }));
    const client = new ResceneClient("https://api.example", "token-1");
    let handler!: (event: JobEvent) => void;
    vi.spyOn(client, "subscribeJob").mockImplementation((_id, onEvent) => { handler = onEvent; return vi.fn(); });
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await waitFor(() => expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("QUEUED"));
    await waitFor(() => expect(handler).toBeDefined());
    return () => handler;
  }

  it("keeps the terminal status when a late workspace snapshot still reports QUEUED", async () => {
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [jobFixture("QUEUED", 0, "2026-01-01T00:00:00Z")] },
      "/v1/reconstructions/r1/manifest": { reconstruction_id: "r1", artifacts: [] },
      "/v1/reconstructions/r1/shares": [],
    }));
    const client = new ResceneClient("https://api.example", "token-1");
    let handler!: (event: JobEvent) => void;
    vi.spyOn(client, "subscribeJob").mockImplementation((_id, onEvent) => { handler = onEvent; return vi.fn(); });
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await waitFor(() => expect(handler).toBeDefined());

    const done = { ...jobFixture("SUCCEEDED", 1, "2026-01-01T00:10:00Z"), reconstruction_id: "r1" };
    act(() => handler(done as JobEvent));
    await waitFor(() => expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("SUCCEEDED"));
    const projectCalls = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/projects/p1") && !String(input).includes("/assets") && !String(input).includes("/jobs")).length;
    await waitFor(() => expect(projectCalls()).toBeGreaterThan(1));
    expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("SUCCEEDED");
  });

  it("advances progress from stage events without letting them rewind a terminal status", async () => {
    const handler = await openQueuedJob();

    act(() => handler()({ stage: "training", status: "running", progress: 0.4, message: null, metrics: {} }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "任务进度" }).getAttribute("aria-valuenow")).toBe("40"));
    expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("QUEUED");

    act(() => handler()({ ...jobFixture("FAILED", 0.6, "2026-01-01T00:10:00Z"), reconstruction_id: null } as JobEvent));
    await waitFor(() => expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("FAILED"));

    act(() => handler()({ stage: "training", status: "running", progress: 0.9, message: null, metrics: {} }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "任务进度" }).getAttribute("aria-valuenow")).toBe("90"));
    expect(document.querySelector(".job-state")?.getAttribute("data-status")).toBe("FAILED");
  });

  it("keeps one subscription and one copy of replayed stage events", async () => {
    const second = { ...asset, id: "a2", filename: "second.jpg" };
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [jobFixture("QUEUED", 0, "2026-01-01T00:00:00Z")] },
      "/v1/projects/p1/assets": (url: URL) => url.searchParams.get("cursor") === "second"
        ? { items: [second], next_cursor: null } : { items: [asset], next_cursor: "second" },
      "/v1/jobs/j1/stages": [{ id: "s1", stage: "training", status: "running", progress: 0.4, message: null, metrics: {}, created_at: "2026-01-01T00:00:00Z" }],
    }));
    const client = new ResceneClient("https://api.example", "token-1");
    let handler!: (event: JobEvent) => void;
    const subscribe = vi.spyOn(client, "subscribeJob").mockImplementation((_id, onEvent) => { handler = onEvent; return vi.fn(); });
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await waitFor(() => expect(handler).toBeDefined());
    await userEvent.click(await screen.findByText("阶段记录"));
    await waitFor(() => expect(document.querySelectorAll(".timeline li")).toHaveLength(1));

    act(() => handler({ stage: "training", status: "running", progress: 0.4, message: null, metrics: {} }));
    expect(document.querySelectorAll(".timeline li")).toHaveLength(1);
    act(() => handler({ stage: "training", status: "running", progress: 0.65, message: null, metrics: {} }));
    expect(document.querySelectorAll(".timeline li")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "← 返回任务" }));
    await userEvent.click(screen.getByRole("button", { name: "素材" }));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /second.jpg/ })).toBeTruthy());
    expect(subscribe).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await userEvent.click(await screen.findByText("阶段记录"));
    expect(document.querySelectorAll(".timeline li")).toHaveLength(2);
  });
});

describe("job log paging", () => {
  const log = (id: number, message: string): JobLog => ({ id, level: "info", message, created_at: "2026-01-01T00:00:00Z" });
  const job = (id: string) => ({
    id, project_id: "p1", profile: "balanced", status: "SUCCEEDED", progress: 1, attempt: 1,
    cancel_requested: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", reconstruction_id: null,
  });

  it("never prepends an earlier page from a job the user already left", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    const earlier = Promise.withResolvers<JobLog[]>();
    const beforeRequests: string[] = [];
    vi.spyOn(client, "listJobLogs").mockImplementation((jobId, params) => {
      if (params?.beforeId !== undefined) {
        beforeRequests.push(jobId);
        return earlier.promise;
      }
      return Promise.resolve(jobId === "j1" ? [log(2, "j1 latest")] : [log(10, "j2 latest")]);
    });
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [job("j1"), job("j2")] },
    }));
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("button", { name: "任务" }));
    await userEvent.click((await screen.findAllByRole("button", { name: /均衡重建/ }))[0]);
    await userEvent.click(await screen.findByRole("button", { name: /查看运行日志/ }));
    await waitFor(() => expect(screen.getByText(/j1 latest/)).toBeTruthy());

    const earlierButton = screen.getByRole("button", { name: "加载更早" });
    fireEvent.click(earlierButton);
    fireEvent.click(earlierButton);
    expect(beforeRequests).toEqual(["j1"]);

    await userEvent.click(screen.getByRole("button", { name: "← 返回任务详情" }));
    await userEvent.click(screen.getByRole("button", { name: "← 返回任务" }));
    await userEvent.click((await screen.findAllByRole("button", { name: /均衡重建/ }))[1]);
    await userEvent.click(await screen.findByRole("button", { name: /查看运行日志/ }));
    await waitFor(() => expect(screen.getByText(/j2 latest/)).toBeTruthy());
    await act(async () => { earlier.resolve([log(1, "j1 old page")]); });

    expect(screen.queryByText(/j1 old page/)).toBeNull();
    expect(screen.getByText(/j2 latest/)).toBeTruthy();
  });
});

describe("project-scoped uploads", () => {
  it("keeps another project's picker enabled while a batch is still running", async () => {
    const studio = { ...project, id: "p2", name: "Studio" };
    const pending = Promise.withResolvers<{ assetId: string }>();
    const adapter = {
      upload: vi.fn((_request: { projectId: string; file: File }, onProgress: (percent: number) => void) => {
        onProgress(25);
        return pending.promise;
      }),
    };
    stubFetch(routeTable({
      "/v1/projects": [project, studio],
      "/v1/projects/p2": { ...projectDetail("owner"), id: "p2", name: "Studio" },
      "/v1/projects/p2/members": [],
      "/v1/projects/p2/invitations": [],
    }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"), memoryStore(), adapter);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await waitFor(() => expect(document.querySelector('input[type="file"]')).toBeTruthy());

    const header = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const file = new File([header], "clip.mp4");
    // jsdom's Blob has no arrayBuffer(); expose just the header the preflight reads.
    Object.defineProperty(file, "slice", { value: () => ({ arrayBuffer: async () => header.buffer }) });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(adapter.upload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true));
    expect(document.querySelector(".upload-panel")?.textContent).toContain("clip.mp4 · 上传中");

    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Studio" }));
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false));
    expect(document.querySelector(".upload-panel")?.textContent).not.toContain("clip.mp4");

    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await waitFor(() => expect(document.querySelector(".upload-panel")?.textContent).toContain("clip.mp4 · 上传中"));

    await act(async () => { pending.resolve({ assetId: "a2" }); });
    await waitFor(() => expect(document.querySelector(".upload-panel")?.textContent).toContain("clip.mp4 · 完成"));
  });
});

describe("notification pagination", () => {
  function notice(id: string, index: number): AppNotification {
    return {
      id,
      kind: "announcement",
      title: `通知 ${index}`,
      body: null,
      project_id: null,
      job_id: null,
      announcement_id: "a1",
      read_at: null,
      created_at: "2026-01-01T00:00:00Z",
    };
  }

  it("keeps expanded notification pages across the timed refresh", async () => {
    vi.useFakeTimers();
    try {
      const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => notice(`n${start + index}`, start + index));
      let pageRequests = 0;
      stubFetch(routeTable({
        "/v1/notifications/count": { unread: 44 },
        "/v1/notifications": (url: URL) => {
          pageRequests += 1;
          const offset = Number(url.searchParams.get("offset") ?? "0");
          if (offset === 20) return page(20, 20);
          if (offset === 40) return page(39, 5);
          return page(0, 20);
        },
      }));
      renderWorkbench(new ResceneClient("https://api.example", "token-1"));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("button", { name: "通知（44）" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "通知（44）" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByRole("listitem")).toHaveLength(20);
      fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByRole("listitem")).toHaveLength(40);
      fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByRole("listitem")).toHaveLength(44);
      expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();

      const loaded = pageRequests;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(pageRequests).toBe(loaded);
      expect(screen.getAllByRole("listitem")).toHaveLength(44);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a stale filter page after the selection changes", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    let resolveUnread: (value: AppNotification[]) => void = () => {};
    vi.spyOn(client, "listNotifications").mockImplementation((unread) => unread
      ? new Promise<AppNotification[]>((resolve) => { resolveUnread = resolve; })
      : Promise.resolve([notice("n1", 1)]));
    stubFetch(routeTable({ "/v1/notifications/count": { unread: 2 } }));
    renderWorkbench(client);

    await waitFor(() => expect(screen.getByRole("button", { name: "通知（2）" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "通知（2）" }));
    await userEvent.click(screen.getByRole("tab", { name: "未读" }));
    await userEvent.click(screen.getByRole("tab", { name: "全部" }));
    await waitFor(() => expect(screen.getByText("通知 1")).toBeTruthy());

    await act(async () => { resolveUnread([notice("stale", 99)]); });
    expect(screen.queryByText("通知 99")).toBeNull();
  });

  it("loads fresh notifications when the panel opens after the badge changes", async () => {
    vi.useFakeTimers();
    try {
      let items = [notice("n1", 1)];
      let unread = 1;
      stubFetch(routeTable({
        "/v1/notifications/count": () => ({ unread }),
        "/v1/notifications": () => items,
      }));
      renderWorkbench(new ResceneClient("https://api.example", "token-1"));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("button", { name: "通知（1）" })).toBeTruthy();
      const initial = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/notifications?")).length;

      items = [notice("n2", 2), notice("n1", 1)];
      unread = 2;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole("button", { name: "通知（2）" })).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/notifications?")).length).toBe(initial);

      fireEvent.click(screen.getByRole("button", { name: "通知（2）" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("通知 2")).toBeTruthy();
      expect(screen.getByText("通知 1")).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/notifications?")).length).toBe(initial + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workspace refresh feedback", () => {
  it("keeps the last snapshot and clears the stale banner after a successful retry", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    const workspace = vi.spyOn(client, "getWorkspace")
      .mockResolvedValueOnce(projectDetail("owner") as never)
      .mockRejectedValue(new Error("服务器暂时不可用"));
    stubFetch(routeTable());
    vi.useFakeTimers();
    try {
      renderWorkbench(client, memoryStore({ "rescene-project": "p1" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("heading", { name: "Kitchen" })).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText(/刷新失败/)).toBeTruthy();
      expect(screen.getByText(/显示的是/)).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Kitchen" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "关闭刷新提示" }));
      expect(screen.queryByText(/刷新失败/)).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText(/刷新失败/)).toBeTruthy();

      vi.useRealTimers();
      workspace.mockResolvedValue(projectDetail("owner") as never);
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(screen.queryByText(/刷新失败/)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("narrow navigation drawer", () => {
  function stubNarrowViewport(narrow: boolean) {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: narrow && query.includes("1024px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  }

  it("keeps the closed drawer out of the focus order", async () => {
    stubNarrowViewport(true);
    stubFetch(routeTable());
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "项目列表" })).toBeTruthy());
    const aside = document.querySelector("aside");
    expect(aside?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("header.mobile-bar")?.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("section.workspace")?.hasAttribute("inert")).toBe(false);
  });

  it("focuses the open drawer, traps Tab and restores the toggle on Escape", async () => {
    stubNarrowViewport(true);
    stubFetch(routeTable());
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "项目列表" })).toBeTruthy());
    const toggle = screen.getByRole("button", { name: "打开导航" });
    toggle.focus();
    await userEvent.click(toggle);

    const aside = document.querySelector("aside")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(aside.contains(document.activeElement)).toBe(true);
    expect(document.querySelector("section.workspace")?.hasAttribute("inert")).toBe(true);

    const focusable = Array.from(aside.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.closest("details:not([open])"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(toggle);
    expect(aside.hasAttribute("inert")).toBe(true);
  });

  it("moves focus to the project list after choosing it in the drawer", async () => {
    stubNarrowViewport(true);
    stubFetch(routeTable());
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(screen.getByRole("button", { name: "打开导航" }));
    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));

    const heading = await screen.findByRole("heading", { name: "项目列表" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
