import { ResceneClient } from "@rescene/api-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

type RouteValue = unknown | (() => unknown);

function stubFetch(routes: Record<string, RouteValue>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
      if (route === undefined) return new Response("{}", { status: 404 });
      const value = typeof route === "function" ? (route as () => unknown)() : route;
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

function renderWorkbench(client = new ResceneClient("https://api.example"), store = memoryStore()) {
  render(
    <Workbench
      client={client}
      uploader={uploader}
      viewer={viewer}
      tokenStore={store}
      webBaseUrl="https://app.example"
    />,
  );
  return store;
}

beforeEach(() => {
  localStorage.clear();
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
  it("registers a new account and keeps the token", async () => {
    stubFetch(routeTable());

    const store = renderWorkbench();

    await userEvent.click(screen.getByRole("tab", { name: "注册" }));
    await userEvent.type(screen.getByLabelText("团队邮箱"), "new@example.com");
    await userEvent.type(screen.getByLabelText("密码（至少 12 位）"), "correct-horse-1");
    await userEvent.type(screen.getByLabelText("确认密码"), "correct-horse-1");
    await userEvent.click(screen.getByText("创建账号"));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-2"));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
  });

  it("stores the access token and shows the signed-in account", async () => {
    stubFetch(routeTable());

    const store = renderWorkbench();

    expect(screen.getByText("进入工作台")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("团队邮箱"), "ops@example.com");
    await userEvent.type(screen.getByLabelText("密码"), "secret");
    await userEvent.click(screen.getByText("进入工作台"));

    await waitFor(() => expect(store.data.get("rescene-token")).toBe("token-1"));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
    expect(screen.getByText(/ops@example\.com/)).toBeTruthy();
    expect(screen.getByText(/RTX 5090 在线/)).toBeTruthy();
  });
});

describe("project roles", () => {
  it("gives an owner member management and upload controls", async () => {
    stubFetch(routeTable());

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));

    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Kitchen ·/ }));

    await waitFor(() => expect(screen.getByText("项目设置")).toBeTruthy());
    expect(screen.getByText("选择图片或视频")).toBeTruthy();
    const start = screen.getByRole<HTMLButtonElement>("button", { name: "开始三维重建" });
    expect(start.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /frame\.jpg/ }));
    expect(start.disabled).toBe(false);
    const quality = screen.getByRole("button", { name: /精细重建/ });
    await userEvent.click(quality);
    expect(quality.getAttribute("aria-pressed")).toBe("true");
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

    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Kitchen ·/ }));

    await waitFor(() => expect(screen.getByText(/只读访问/)).toBeTruthy());
    expect(screen.queryByText("开始三维重建")).toBeNull();
    expect(screen.queryByText("选择图片或视频")).toBeNull();
    expect(screen.queryByText("项目设置")).toBeNull();
    await waitFor(() => expect(screen.getByText("成员（2）")).toBeTruthy());
    expect(screen.getByText("teammate@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("teammate@example.com 的角色")).toBeNull();
    expect(screen.queryByText("frame.jpg")).toBeTruthy();
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

    await waitFor(() => expect(screen.getByText("通知（1）")).toBeTruthy());
    await userEvent.click(screen.getByText("通知（1）"));
    await userEvent.click(screen.getByText("全部已读"));

    await waitFor(() => expect(screen.getByText("通知")).toBeTruthy());
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/v1/notifications/read"));
    expect(call?.[1]?.method).toBe("POST");
  });

  it("deletes an asset after confirmation", async () => {
    stubFetch(routeTable({ "/v1/assets/a1": { status: 204 } }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Kitchen ·/ }));
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
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());

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

  it("reports an invited address after adding an unknown member", async () => {
    stubFetch(
      routeTable({
        "POST /v1/projects/p1/members": { status: 201, body: { status: "invited", email: "guest@example.com", role: "viewer" } },
      }),
    );

    renderWorkbench(new ResceneClient("https://api.example", "token-1"));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Kitchen ·/ }));
    await userEvent.type(screen.getByLabelText("成员邮箱"), "guest@example.com");
    await userEvent.click(screen.getByText("添加成员"));

    await waitFor(() => expect(screen.getByText(/对方注册后自动加入/)).toBeTruthy());
  });
});

const adminSelf = { id: "u1", email: "ops@example.com", is_admin: true };

function adminUser(id: string, email: string, active: boolean, isAdmin = false) {
  return { id, email, is_admin: isAdmin, active, created_at: "2026-01-01T00:00:00Z" };
}

async function openAdminConsole() {
  await waitFor(() => expect(screen.getByRole("button", { name: "管理控制台" })).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "管理控制台" }));
}

function adminRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return routeTable({
    "/v1/auth/me": adminSelf,
    "/v1/users": { total: 1, items: [adminUser("u1", "ops@example.com", true, true)] },
    ...overrides,
  });
}

describe("management console", () => {
  it("opens the console from the sidebar and lists accounts", async () => {
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
    await waitFor(() => expect(screen.getByRole("navigation", { name: "项目" }).querySelector("button")).toBeTruthy());

    expect(document.querySelector("main.shell")?.className).not.toContain("nav-open");
    await userEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(document.querySelector("main.shell")?.className).toContain("nav-open");
  });
});

describe("appearance", () => {
  it("persists an explicit theme without discarding the login form", async () => {
    stubFetch(routeTable());
    renderWorkbench();
    await userEvent.type(screen.getByLabelText("团队邮箱"), "retained@example.com");
    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("rescene-theme")).toBe("dark");
    expect((screen.getByLabelText("团队邮箱") as HTMLInputElement).value).toBe("retained@example.com");
    await userEvent.selectOptions(screen.getByLabelText("外观主题"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
