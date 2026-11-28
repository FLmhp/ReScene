import { ResceneClient, type JobEvent } from "@rescene/api-client";
import type { AdminUserPage, AppNotification, JobLog, User } from "@rescene/schemas";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UploadAdapter } from "@rescene/uploader";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
      platform="web"
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

    await userEvent.click(screen.getByRole("button", { name: "注册账号" }));
    await userEvent.type(screen.getByLabelText("邮箱"), "new@example.com");
    await userEvent.type(screen.getByLabelText("密码"), "correct-horse-1");
    await userEvent.type(screen.getByLabelText("确认密码"), "correct-horse-1");
    await userEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-2"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
  });

  it("signs in with a mailed code and starts the resend cooldown", async () => {
    stubFetch(
      routeTable({
        "POST /v1/auth/email-code": { status: "accepted" },
        "POST /v1/auth/email-code/login": { access_token: "token-code", token_type: "bearer" },
      }),
    );
    const store = renderWorkbench();

    await userEvent.click(screen.getByRole("button", { name: "使用邮箱验证码登录" }));
    expect(screen.getByRole("heading", { name: "验证码登录" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("邮箱"), "ops@example.com");
    await userEvent.click(screen.getByRole("button", { name: "发送验证码" }));

    expect(await screen.findByText("验证码已发送，请检查邮箱")).toBeTruthy();
    const resend = screen.getByRole("button", { name: /秒后重发$/ }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("验证码"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-code"));
  });

  it("reports an expired code without leaving the code form", async () => {
    stubFetch(
      routeTable({
        "POST /v1/auth/email-code": { status: "accepted" },
        "POST /v1/auth/email-code/login": { status: 401, body: { detail: "Verification code is invalid or expired" } },
      }),
    );
    const store = renderWorkbench();

    await userEvent.click(screen.getByRole("button", { name: "使用邮箱验证码登录" }));
    await userEvent.type(screen.getByLabelText("邮箱"), "ops@example.com");
    await userEvent.type(screen.getByLabelText("验证码"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("验证码无效或已过期，请重新获取。")).toBeTruthy();
    expect(store.data.get("rescene-token")).toBeUndefined();
    expect(screen.getByRole("heading", { name: "验证码登录" })).toBeTruthy();
  });

  it("resets the password with a code and adopts the new token", async () => {
    stubFetch(
      routeTable({
        "POST /v1/auth/email-code": { status: "accepted" },
        "POST /v1/auth/password-reset": { access_token: "token-reset", token_type: "bearer" },
      }),
    );
    const store = renderWorkbench();

    await userEvent.click(screen.getByRole("button", { name: "忘记密码" }));
    expect(screen.getByRole("heading", { name: "重置密码" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("邮箱"), "ops@example.com");
    await userEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await userEvent.type(screen.getByLabelText("验证码"), "654321");
    await userEvent.type(screen.getByLabelText("新密码"), "correct-horse-2");
    await userEvent.type(screen.getByLabelText("确认新密码"), "correct-horse-2");
    await userEvent.click(screen.getByRole("button", { name: "重置并登录" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-reset"));
  });

  it("stores the access token and shows the signed-in account", async () => {
    stubFetch(routeTable());

    const store = renderWorkbench();

    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("邮箱或用户名"), "ops@example.com");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(await screen.findByRole("button", { name: "账户与安全" }));
    expect(await screen.findByText(/ops@example\.com/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /frame.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "配置重建" }));
    expect(await screen.findByText(/计算节点在线/)).toBeTruthy();
  });

  it("navigates shared settings categories and returns to the last category", async () => {
    stubFetch(routeTable({
      "/v1/auth/me/notification-preferences": {
        email_verified: false,
        email_critical_announcements: false,
        email_job_results: false,
      },
    }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("button", { name: "项目列表" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { name: "账户与安全" })).toBeTruthy();
    expect(screen.getByText("所有设备")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "通知偏好" }));
    expect(await screen.findByRole("heading", { name: "通知偏好" })).toBeTruthy();
    expect(await screen.findByText("ops@example.com")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "验证收件邮箱" })).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: /重要公告/ }));
    expect(screen.getByText("请先验证收件邮箱，再开启邮件订阅。")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("heading", { name: "外观" })).toBeTruthy();
    expect(screen.getByText("仅此设备")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "协议与许可" }));
    expect(screen.getByRole("heading", { name: "协议与许可" })).toBeTruthy();
    expect(screen.getByText("审核稿 · 尚未生效")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "隐私说明" }));
    expect(screen.getByText(/设备偏好。主题、配色、字体和面板效果保存在当前设备/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "账户与安全" }));
    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(screen.getByRole("heading", { name: "修改密码" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /返回账户/ }));
    expect(screen.getByRole("heading", { name: "账户与安全" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "通知偏好" }));
    expect(await screen.findByRole("heading", { name: "通知偏好" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { name: "通知偏好" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "返回项目" }));
    expect(await screen.findByRole("heading", { name: "Kitchen" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { name: "通知偏好" })).toBeTruthy();
  });

  it("signs in with a username identifier using the new payload", async () => {
    stubFetch(routeTable());
    const store = renderWorkbench();

    await userEvent.type(screen.getByLabelText("邮箱或用户名"), "ops_user");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-1"));
    const fetchMock = fetch as unknown as Mock;
    const calls = fetchMock.mock.calls as [RequestInfo | URL, RequestInit | undefined][];
    const loginCall = calls.find(([input, init]) => init?.method === "POST" && String(input).includes("/v1/auth/login"));
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String(loginCall?.[1]?.body ?? "{}"))).toEqual({ identifier: "ops_user", password: "secret" });
  });

  it("does not carry a login identifier into email-only forms", async () => {
    stubFetch(routeTable());
    renderWorkbench();

    await userEvent.type(screen.getByLabelText("邮箱或用户名"), "ops_user");
    await userEvent.click(screen.getByRole("button", { name: "使用邮箱验证码登录" }));
    expect((screen.getByLabelText("邮箱") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("邮箱"), "ops@example.com");
    await userEvent.click(screen.getByRole("button", { name: "使用密码登录" }));
    expect((screen.getByLabelText("邮箱或用户名") as HTMLInputElement).value).toBe("ops_user");
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
    announcement_level: null,
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
    await userEvent.click(await screen.findByText("标记所有可见未读"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "通知" })).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/v1/notifications/read"));
    expect(call?.[1]?.method).toBe("POST");
  });

  it("opens a job notification for the already selected project", async () => {
    const job = {
      id: "j1", project_id: "p1", profile: "balanced", status: "SUCCEEDED", progress: 1, attempt: 1,
      cancel_requested: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", reconstruction_id: null,
    };
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [job] },
      "/v1/notifications": [{ ...notification(false), job_id: "j1" }],
      "POST /v1/notifications/read": { updated: 1 },
    }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await screen.findByRole("heading", { name: "Kitchen" });
    await userEvent.click(await screen.findByRole("button", { name: "通知（1）" }));
    await userEvent.click(await screen.findByRole("button", { name: /重建已完成/ }));
    expect(await screen.findByRole("heading", { name: "重建已完成" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "查看任务" }));
    expect(await screen.findByRole("heading", { name: "任务详情" })).toBeTruthy();
  });

  it("keeps targetless announcements on the notification page", async () => {
    stubFetch(routeTable({
      "/v1/notifications": [{ ...notification(false), kind: "announcement", title: "系统公告", project_id: null, announcement_level: "critical", body: "请在维护窗口结束后再重试上传。" }],
      "POST /v1/notifications/read": { updated: 1 },
    }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await userEvent.click(await screen.findByRole("button", { name: "通知（1）" }));
    await userEvent.click(await screen.findByRole("button", { name: /系统公告/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/v1/notifications/read") && init?.method === "POST")).toBe(true));
    expect(screen.getByRole("heading", { name: "系统公告" })).toBeTruthy();
    expect(screen.getByText("请在维护窗口结束后再重试上传。")).toBeTruthy();
    expect(screen.getByText(/重要公告/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看任务" })).toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: "账户与安全" }));
    await userEvent.click(await screen.findByRole("button", { name: "修改密码" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "修改密码" })));
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
  return {
    id, email, is_admin: isAdmin, active, created_at: "2026-01-01T00:00:00Z",
    username: null, avatar_revision: null,
  };
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

  it("filters accounts by username or email, status and role", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    const pending: { query: string; isAdmin?: boolean; resolve: (page: AdminUserPage) => void }[] = [];
    vi.spyOn(client, "listUsers").mockImplementation((params) => {
      const deferred = Promise.withResolvers<AdminUserPage>();
      pending.push({ query: params?.query ?? "", isAdmin: params?.isAdmin, resolve: deferred.resolve });
      return deferred.promise;
    });
    stubFetch(adminRoutes());
    renderWorkbench(client);
    await openAdminConsole();
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("搜索用户名或邮箱"), { target: { value: "alice" } });
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(pending[1]?.query).toBe("alice");

    await userEvent.selectOptions(screen.getByLabelText("角色"), "管理员");
    await waitFor(() => expect(pending.some((p) => p.isAdmin === true)).toBe(true));
  });

  it("deactivates an account after confirming the target and effect", async () => {
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

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("teammate@example.com");
    await userEvent.click(screen.getByRole("button", { name: "确认停用" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/users/u2") && init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ active: false });
    });
  });

  it("blocks dangerous actions against the signed-in admin account", async () => {
    stubFetch(adminRoutes({ "/v1/users/u1": { ...adminUser("u1", "ops@example.com", true, true), memberships: [] } }));
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await waitFor(() => expect(screen.getByRole("button", { name: "停用" })).toBeTruthy());
    const deactivate = screen.getByRole("button", { name: "停用" });
    expect(deactivate.hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "详情" }));
    await waitFor(() => expect(document.querySelector(".user-detail-card")).toBeTruthy());
    const detailActions = screen.getAllByRole("button", { name: "停用" });
    expect(detailActions[detailActions.length - 1]?.hasAttribute("disabled")).toBe(true);
  });

  it("resets an account password after confirming target and entering a new password", async () => {
    stubFetch(
      adminRoutes({
        "/v1/users": {
          total: 2,
          items: [adminUser("u1", "ops@example.com", true, true), adminUser("u2", "teammate@example.com", true)],
        },
        "POST /v1/users/u2/password": { status: 204 },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await waitFor(() => expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "重置密码" })[1]?.disabled).toBe(false));
    await userEvent.click(screen.getAllByRole("button", { name: "重置密码" })[1]);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("新密码（至少 12 位）"), "  fresh-password-12 ");
    await userEvent.click(screen.getByRole("button", { name: "确认重置" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/users/u2/password") && init?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password: "  fresh-password-12 " });
    });
  });

  it("publishes an announcement from a separate form with a stable retry key", async () => {
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
    await userEvent.click(screen.getByRole("tab", { name: "公告管理" }));
    await userEvent.click(screen.getByRole("button", { name: "发布公告" }));
    await userEvent.type(screen.getByLabelText("标题"), "维护公告");
    await userEvent.type(screen.getByLabelText("正文"), "今晚 23:00 起维护一小时。");
    await userEvent.selectOptions(screen.getByLabelText("级别"), "warning");
    await userEvent.click(screen.getByRole("button", { name: "预览并发布" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认发布" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() => expect(screen.getByText("维护公告")).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/announcements") && init?.method === "POST");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ title: "维护公告", body: "今晚 23:00 起维护一小时。", level: "warning" });
    expect((call?.[1]?.headers as Record<string, string> | undefined)?.["Idempotency-Key"]).toBeTruthy();
  });

  it("retracts an announcement after warning that mail cannot be recalled", async () => {
    stubFetch(
      adminRoutes({
        "/v1/announcements": [
          {
            id: "an1",
            title: "维护公告",
            body: "今晚停机维护。",
            level: "warning",
            created_by: "u1",
            created_at: "2026-01-01T00:00:00Z",
            recipient_count: 3,
            read_count: 1,
            mail_pending: 0,
            mail_accepted: 2,
            mail_failed: 0,
            mail_unknown: 0,
          },
        ],
        "DELETE /v1/announcements/an1": { status: 204 },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await userEvent.click(screen.getByRole("tab", { name: "公告管理" }));
    await waitFor(() => expect(screen.getByText("维护公告")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "撤回公告" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("已发出的邮件不可追回");
    await userEvent.click(screen.getByRole("button", { name: "确认撤回" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/v1/announcements/an1") && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
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
              actor_username: null,
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
    await userEvent.click(screen.getByRole("tab", { name: "审计日志" }));
    await userEvent.type(screen.getByLabelText("操作者"), "ops@example.com");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("actor="))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "下载 CSV" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/v1/audit.csv"))).toBe(true));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audit");
  });

  it("warns about reversed local audit time range before querying", async () => {
    stubFetch(adminRoutes());
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await openAdminConsole();
    await userEvent.click(screen.getByRole("tab", { name: "审计日志" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/v1/audit?"))).toBe(true));
    const calls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/audit?"));
    expect(calls.length).toBe(1);

    fireEvent.change(screen.getByLabelText("起始时间"), { target: { value: "2026-01-02T00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-01-01T00:00" } });
    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    const newCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/v1/audit?"));
    expect(newCalls.length).toBe(1);
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
  const savedDisplay = JSON.stringify({ colorway: "ink", primary: "#28536B", fontSize: "large", surface: "solid" });

  function storeSavedAppearance() {
    localStorage.setItem("rescene-theme", "dark");
    localStorage.setItem("rescene-display", savedDisplay);
  }

  it("keeps every anonymous auth screen on the system default without touch on saved preferences", async () => {
    stubFetch(routeTable());
    let systemListener: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
        if (query.includes("prefers-color-scheme")) systemListener = listener;
      },
      removeEventListener: vi.fn(),
    })));
    storeSavedAppearance();
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.colorway = "ink";

    renderWorkbench();
    expect(await screen.findByRole("heading", { name: "登录" })).toBeTruthy();
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.colorway).toBe("ultramarine");
    expect(document.documentElement.dataset.fontSize).toBe("standard");
    expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
    expect(localStorage.getItem("rescene-display")).toBe(savedDisplay);

    act(() => systemListener?.({ matches: true }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.colorway).toBe("ultramarine");

    await userEvent.click(screen.getByRole("button", { name: "使用邮箱验证码登录" }));
    expect(screen.getByRole("heading", { name: "验证码登录" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "使用密码登录" }));
    await userEvent.click(screen.getByRole("button", { name: "忘记密码" }));
    expect(screen.getByRole("heading", { name: "重置密码" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "返回登录" }));
    await userEvent.click(screen.getByRole("button", { name: "注册账号" }));
    expect(screen.getByRole("heading", { name: "注册" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
  });

  it("restores saved appearance only after /auth/me verifies, even when projects fail", async () => {
    stubFetch(routeTable({ "/v1/projects": { status: 500, body: { detail: "offline" } } }));
    storeSavedAppearance();
    const client = new ResceneClient("https://api.example", "token-1");
    const pendingMe = Promise.withResolvers<User>();
    const getMe = vi.spyOn(client, "getMe").mockReturnValue(pendingMe.promise);

    renderWorkbench(client);
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.colorway).toBe("ultramarine");
    expect(localStorage.getItem("rescene-theme")).toBe("dark");

    await act(async () => {
      pendingMe.resolve({ id: "u1", email: "ops@example.com", is_admin: false } as User);
      await pendingMe.promise;
    });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(document.documentElement.dataset.colorway).toBe("ink");
    expect(document.documentElement.dataset.fontSize).toBe("large");
    expect(document.documentElement.dataset.surface).toBe("solid");
    expect(await screen.findByRole("heading", { name: "无法加载项目" })).toBeTruthy();
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
  });

  it("clears the effective palette on sign-out without erasing saved preferences and ignores late /auth/me", async () => {
    stubFetch(routeTable({ "POST /v1/auth/logout": { status: 204 } }));
    storeSavedAppearance();
    const client = new ResceneClient("https://api.example", "token-1");
    const lateMe = Promise.withResolvers<User>();
    const getMe = vi.spyOn(client, "getMe")
      .mockResolvedValueOnce({ id: "u1", email: "ops@example.com", is_admin: false } as User)
      .mockReturnValueOnce(lateMe.promise);
    renderWorkbench(client);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy());
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.colorway).toBe("ultramarine");
    expect(document.documentElement.dataset.fontSize).toBe("standard");
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
    expect(localStorage.getItem("rescene-display")).toBe(savedDisplay);

    await act(async () => {
      lateMe.resolve({ id: "u1", email: "ops@example.com", is_admin: false } as User);
      await lateMe.promise;
    });
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.colorway).toBe("ultramarine");
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
  });

  it("persists an explicit appearance from settings and updates the effective palette", async () => {
    stubFetch(routeTable());
    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "设置" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("heading", { name: "外观" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
    await userEvent.selectOptions(screen.getByLabelText("字体大小"), "large");
    await waitFor(() => expect(document.documentElement.dataset.fontSize).toBe("large"));
    const stored = JSON.parse(localStorage.getItem("rescene-display") ?? "{}") as { fontSize?: string };
    expect(stored.fontSize).toBe("large");
    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
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
  const log = (id: number, message: string, overrides: Partial<JobLog> = {}): JobLog => ({ id, level: "info", message, attempt: null, created_at: "2026-01-01T00:00:00Z", ...overrides });
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

  it("shows the attempt round for each log line", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    vi.spyOn(client, "listJobLogs").mockResolvedValue([
      log(1, "first", { attempt: 1 }),
      log(2, "second", { attempt: null }),
    ]);
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [job("j1")] },
    }));
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await userEvent.click(await screen.findByRole("button", { name: /查看运行日志/ }));
    await waitFor(() => expect(screen.getByText(/第 1 轮/)).toBeTruthy());
    expect(screen.getByText(/轮次未知/)).toBeTruthy();
  });

  it("switches the level filter and resets the list", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    const calls: { jobId: string; level?: string }[] = [];
    vi.spyOn(client, "listJobLogs").mockImplementation((jobId, params) => {
      calls.push({ jobId, level: params?.level });
      return Promise.resolve([
        log(1, params?.level ?? "all", { level: (params?.level as JobLog["level"]) ?? "info" }),
      ]);
    });
    stubFetch(routeTable({
      "/v1/projects/p1": { ...projectDetail("owner"), jobs: [job("j1")] },
    }));
    renderWorkbench(client);
    await userEvent.click(await screen.findByRole("button", { name: "Kitchen" }));
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    await userEvent.click(await screen.findByRole("button", { name: /均衡重建/ }));
    await userEvent.click(await screen.findByRole("button", { name: /查看运行日志/ }));
    await waitFor(() => expect(screen.getByText(/all/)).toBeTruthy());

    await userEvent.selectOptions(screen.getByLabelText("级别"), "debug");
    await waitFor(() => expect(screen.getByText(/debug/)).toBeTruthy());
    expect(calls.some((call) => call.level === "debug")).toBe(true);
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
  function notice(id: string, index: number, kind: AppNotification["kind"] = "announcement"): AppNotification {
    return {
      id,
      kind,
      title: `通知 ${index}`,
      body: null,
      project_id: null,
      job_id: null,
      announcement_id: kind === "announcement" ? "a1" : null,
      announcement_level: kind === "announcement" ? "info" : null,
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

  it("drops a stale kind page after switching back", async () => {
    const client = new ResceneClient("https://api.example", "token-1");
    let resolveKind: (value: AppNotification[]) => void = () => {};
    vi.spyOn(client, "listNotifications").mockImplementation((_unread, _limit, _offset, kind) => {
      if (kind === "job.succeeded") {
        const { promise, resolve } = Promise.withResolvers<AppNotification[]>();
        resolveKind = resolve;
        return promise;
      }
      return Promise.resolve([notice("n1", 1, (kind as AppNotification["kind"] | undefined) ?? "announcement")]);
    });
    stubFetch(routeTable({ "/v1/notifications/count": { unread: 2 } }));
    renderWorkbench(client);

    await waitFor(() => expect(screen.getByRole("button", { name: "通知（2）" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "通知（2）" }));
    await waitFor(() => expect(screen.getByText("通知 1")).toBeTruthy());

    await userEvent.click(screen.getByRole("tab", { name: "任务成功" }));
    await userEvent.click(screen.getByRole("tab", { name: "所有类型" }));
    await waitFor(() => expect(screen.getByText("通知 1")).toBeTruthy());

    await act(async () => { resolveKind([notice("stale", 99, "job.succeeded")]); });
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
