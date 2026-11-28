import { describe, expect, it } from "vitest";

import {
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AnnouncementSchema,
  AuditPageSchema,
  JobLogPageSchema,
  JobSchema,
  NotificationCountSchema,
  NotificationSchema,
  ProjectDetailSchema,
  canRetryJob,
  projectLibraryPage,
  queuedJobHint,
  reconcileWorkspaceSelection,
  selectWorkspaceAssets,
  UploadGrantSchema,
  UserSchema,
} from "./index";

describe("project library pages", () => {
  const projects = Array.from({ length: 17 }, (_, id) => ({ id, name: `${id % 2 ? "Oak" : "Maple"} ${id}` }));

  it("keeps server order and recovers an out-of-range page after filtering", () => {
    expect(projectLibraryPage(projects, "", 1)).toEqual({ items: projects.slice(8, 16), count: 17, index: 1, pages: 3 });
    expect(projectLibraryPage(projects, " OaK ", 2)).toEqual({
      items: projects.filter(({ id }) => id % 2 === 1), count: 8, index: 0, pages: 1,
    });
    expect(projectLibraryPage(projects, "maple", 99)).toEqual({ items: [projects[16]], count: 9, index: 1, pages: 2 });
  });

  it("returns an empty first page for no results", () => {
    expect(projectLibraryPage(projects, "pine", 2)).toEqual({ items: [], count: 0, index: 0, pages: 0 });
  });
});

const job = {
  id: "job-1",
  project_id: "project-1",
  profile: "balanced",
  status: "RUNNING",
  progress: 0.4,
  current_stage: "training",
  attempt: 1,
  cancel_requested: false,
  error_code: null,
  error_message: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:05:00Z",
  reconstruction_id: null,
};

it("distinguishes queue states and only offers retries for recoverable terminal jobs", () => {
  expect(new Set([queuedJobHint(true), queuedJobHint(false), queuedJobHint(null)]).size).toBe(3);
  expect(queuedJobHint(null)).toContain("暂无法确认");
  expect(canRetryJob({ status: "FAILED", error_code: "INVALID_INPUT" })).toBe(false);
  expect(canRetryJob({ status: "FAILED", error_code: "INFRASTRUCTURE_ERROR" })).toBe(true);
  expect(canRetryJob({ status: "CANCELLED" })).toBe(true);
  expect(canRetryJob({ status: "RUNNING" })).toBe(false);
});

describe("workspace selection", () => {
  const image = { id: "image", filename: "frame.jpg", status: "READY", size: 1024 } as const;
  const video = { ...image, id: "video", filename: "clip.mp4" };
  it("adds ready images across pages and preserves the selection on refresh", () => {
    const second = { ...image, id: "image-two" };
    const selected = selectWorkspaceAssets([image], [second, video, { ...image, id: "pending", status: "UPLOADING" }], true);
    expect(selected.map((item) => item.id)).toEqual(["image", "image-two"]);
    expect(reconcileWorkspaceSelection(selected, [{ ...second, status: "FAILED" }])).toEqual([image]);
  });
  it("rejects mixed media, multiple videos and selections over the upload limits", () => {
    expect(() => selectWorkspaceAssets([image], [video])).toThrow("一组图片或一个视频");
    expect(() => selectWorkspaceAssets([video], [{ ...video, id: "second-video" }])).toThrow();
    expect(() => selectWorkspaceAssets([], [{ ...image, size: 8 * 1024 ** 3 + 1 }])).toThrow("8 GiB");
    expect(() => selectWorkspaceAssets([], Array.from({ length: 501 }, (_, i) => ({ ...image, id: String(i) })), true)).toThrow("500");
  });
});

describe("job contract", () => {
  it("accepts the server payload", () => {
    expect(JobSchema.parse(job).status).toBe("RUNNING");
  });

  it("rejects an unknown status so a schedule change cannot pass silently", () => {
    expect(() => JobSchema.parse({ ...job, status: "PAUSED" })).toThrow();
  });

  it("rejects a detail payload missing jobs", () => {
    expect(() => ProjectDetailSchema.parse({ id: "p", name: "n", assets: [] })).toThrow();
  });
});

describe("upload grant contract", () => {
  const credentials = {
    access_key_id: "id",
    access_key_secret: "secret",
    security_token: "token",
    expiration: "2026-01-01T01:00:00Z",
    endpoint: "https://oss-cn-beijing.aliyuncs.com",
    region: "oss-cn-beijing",
    bucket: "bucket",
    issued_at: "2026-01-01T00:00:00Z",
  };

  it("defaults legacy STS grants", () => {
    const grant = UploadGrantSchema.parse({ asset_id: "a", object_key: "k", oss: credentials });
    expect(grant.mode).toBe("sts");
  });

  it("requires a signed form for post grants", () => {
    expect(() =>
      UploadGrantSchema.parse({ asset_id: "a", object_key: "k", mode: "post", url: "https://bucket.example" }),
    ).toThrow();
    const grant = UploadGrantSchema.parse({
      asset_id: "a",
      object_key: "k",
      mode: "post",
      url: "https://bucket.example",
      fields: { policy: "p", signature: "s" },
    });
    expect(grant.fields?.policy).toBe("p");
  });

  it("rejects an sts grant without credentials", () => {
    expect(() => UploadGrantSchema.parse({ asset_id: "a", object_key: "k", mode: "sts" })).toThrow();
  });
});

describe("admin console contracts", () => {
  const notification = {
    id: "n1",
    kind: "announcement",
    title: "维护通知",
    body: "今晚 23:00 维护",
    project_id: null,
    job_id: null,
    announcement_id: "a1",
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
  const user = {
    id: "u2",
    email: "ops@example.com",
    is_admin: false,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("keeps announcement payloads and their notifications tied together", () => {
    expect(NotificationSchema.parse(notification).announcement_id).toBe("a1");
    expect(NotificationSchema.parse(notification).announcement_level).toBeNull();
    expect(NotificationSchema.parse({ ...notification, announcement_level: "critical" }).announcement_level).toBe("critical");
    expect(NotificationSchema.parse({ ...notification, announcement_id: null }).announcement_id).toBeNull();
    expect(
      AnnouncementSchema.parse({
        id: "a1",
        title: "维护通知",
        body: "今晚 23:00 维护",
        level: "warning",
        created_by: null,
        created_at: "2026-01-01T00:00:00Z",
      }).level,
    ).toBe("warning");
    expect(() => AnnouncementSchema.parse({ ...notification, level: "loud" })).toThrow();
    expect(NotificationCountSchema.parse({ unread: 3 }).unread).toBe(3);
  });

  it("reads old account responses without inventing a profile", () => {
    expect(UserSchema.parse(user)).toEqual({
      id: user.id, email: user.email, is_admin: false, username: null, avatar_revision: null,
    });
    expect(AdminUserPageSchema.parse({ total: 1, items: [user] }).items[0]).toMatchObject({
      username: null, avatar_revision: null,
    });
  });

  it("separates the paged directory from the single-account detail", () => {
    expect(AdminUserPageSchema.parse({ total: 1, items: [user] }).total).toBe(1);
    expect(() => AdminUserPageSchema.parse([user])).toThrow();
    const detail = AdminUserDetailSchema.parse({
      ...user,
      username: "山景_A",
      avatar_revision: "image-revision",
      memberships: [{ project_id: "p1", name: "厨房", role: "owner" }],
    });
    expect(detail.memberships[0]?.role).toBe("owner");
    expect(detail).toMatchObject({ username: "山景_A", avatar_revision: "image-revision" });
    expect(() => AdminUserDetailSchema.parse(user)).toThrow();
    expect(() =>
      AdminUserDetailSchema.parse({ ...user, memberships: [{ project_id: "p1", name: "厨房", role: "guest" }] }),
    ).toThrow();
  });

  it("requires the global audit page to carry project context", () => {
    const entry = {
      id: "l1",
      actor_email: "ops@example.com",
      action: "project.rename",
      target_type: "project",
      target_id: "p1",
      project_id: "p1",
      project_name: "厨房",
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(AuditPageSchema.parse({ total: 1, items: [entry] }).items[0]?.project_name).toBe("厨房");
    expect(AuditPageSchema.parse({ total: 1, items: [entry] }).items[0]?.actor_username).toBeNull();
    const { project_name: _dropped, ...withoutProject } = entry;
    expect(() => AuditPageSchema.parse({ total: 1, items: [withoutProject] })).toThrow();
  });

  it("rejects unknown job log levels so the console filter stays trustworthy", () => {
    const log = { id: 1, level: "error", message: "gsplat failed", created_at: "2026-01-01T00:00:00Z" };
    expect(JobLogPageSchema.parse({ items: [log] }).items[0]?.attempt).toBeNull();
    expect(JobLogPageSchema.parse({ items: [{ ...log, attempt: 3 }] }).items[0]?.attempt).toBe(3);
    expect(() => JobLogPageSchema.parse({ items: [{ ...log, level: "fatal" }] })).toThrow();
    expect(() => JobLogPageSchema.parse({ items: [{ ...log, id: "1" }] })).toThrow();
  });
});
