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
  reconcileWorkspaceSelection,
  selectWorkspaceAssets,
  UploadGrantSchema,
} from "./index";

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

  it("separates the paged directory from the single-account detail", () => {
    expect(AdminUserPageSchema.parse({ total: 1, items: [user] }).total).toBe(1);
    expect(() => AdminUserPageSchema.parse([user])).toThrow();
    const detail = AdminUserDetailSchema.parse({
      ...user,
      memberships: [{ project_id: "p1", name: "厨房", role: "owner" }],
    });
    expect(detail.memberships[0]?.role).toBe("owner");
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
    const { project_name: _dropped, ...withoutProject } = entry;
    expect(() => AuditPageSchema.parse({ total: 1, items: [withoutProject] })).toThrow();
  });

  it("rejects unknown job log levels so the console filter stays trustworthy", () => {
    const log = { id: 1, level: "error", message: "gsplat failed", created_at: "2026-01-01T00:00:00Z" };
    expect(JobLogPageSchema.parse({ items: [log] }).items[0]?.id).toBe(1);
    expect(() => JobLogPageSchema.parse({ items: [{ ...log, level: "fatal" }] })).toThrow();
    expect(() => JobLogPageSchema.parse({ items: [{ ...log, id: "1" }] })).toThrow();
  });
});
