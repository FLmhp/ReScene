/**
 * Typed ReScene API client shared by Web, Desktop, Mobile, and the Mini Program.
 *
 * Every response is parsed with the Zod contract, so contract drift fails at the
 * call site. Job progress prefers SSE and falls back to 2s polling when a
 * runtime cannot stream.
 */

import {
  AcceptInvitationResultSchema,
  AddMemberResultSchema,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUserSchema,
  AnnouncementSchema,
  ApiErrorSchema,
  ArtifactSchema,
  AssetPageSchema,
  AssetPreviewSchema,
  AuditPageSchema,
  AuthTokenSchema,
  AvatarSchema,
  CompleteAssetSchema,
  EmailCodeAcceptedSchema,
  InvitationSchema,
  JobLogPageSchema,
  JobPageSchema,
  JobSchema,
  JobStageSchema,
  ManifestSchema,
  NotificationCountSchema,
  NotificationPreferencesSchema,
  NotificationSchema,
  ProjectDetailSchema,
  ProjectMemberSchema,
  ProjectSchema,
  ProjectSummarySchema,
  PublicShareSchema,
  ShareSchema,
  ShareSummarySchema,
  StageEventSchema,
  UploadGrantSchema,
  UserSchema,
  WorkerStatusSchema,
  type AcceptInvitationResult,
  type AddMemberResult,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserPage,
  type Announcement,
  type AnnouncementLevel,
  type AppNotification,
  type Artifact,
  type AuditPage,
  type AuthToken,
  type Avatar,
  type EmailCodePurpose,
  type Job,
  type JobLog,
  type JobStage,
  type Manifest,
  type MemberRole,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type Profile,
  type Project,
  type ProjectDetail,
  type ProjectInvitation,
  type ProjectMember,
  type ProjectSummary,
  type ProjectWorkspace,
  type PublicShare,
  type Share,
  type ShareSummary,
  type StageEvent,
  type UploadGrant,
  type User,
  type WorkerStatus,
} from "@rescene/schemas";
import { z, type ZodType } from "zod";

export type UploadInit = {
  filename: string;
  size: number;
  content_type: string;
  sha256: string;
  mode?: "sts" | "post";
};

export type UploadMode = "sts" | "post";

export type JobEvent = StageEvent | Job;
export type JobSubscriptionOptions = { transport?: "sse" | "polling"; pollIntervalMs?: number; idleTimeoutMs?: number };

export class ResceneApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly requestId?: string,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail);
    this.name = "ResceneApiError";
  }
}

const TERMINAL_STATUSES: Record<string, true> = { SUCCEEDED: true, FAILED: true, CANCELLED: true };
const ProjectOverviewSchema = ProjectSummarySchema.or(ProjectDetailSchema);
const MAX_RECONNECTS = 3;
const POLL_INTERVAL_MS = 2000;
// The server writes a heartbeat every 2s; a silent socket is treated as dead.
const IDLE_TIMEOUT_MS = 30_000;
const MAX_POLL_DELAY_MS = 15000;
const MAX_RECONNECT_DELAY_MS = 8000;
const RECONNECT_BASE_MS = 500;

function legacyWorkspace(project: ProjectDetail): ProjectWorkspace {
  // The deployed API ignores view=summary and returns all assets and jobs.
  const assets = project.assets.slice().reverse();
  return {
    ...project, assets,
    asset_count: assets.length,
    job_count: project.jobs.length,
    has_active_jobs: project.jobs.some((job) => !TERMINAL_STATUSES[job.status]),
    cover: assets.find((asset) => asset.status === "READY" && /\.(jpe?g|png)$/i.test(asset.filename)) ?? null,
    latest_job: project.jobs[0] ?? null,
    nextAssetCursor: null,
    nextJobCursor: null,
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  "auth.invalid_credentials": "邮箱、用户名或密码不正确。",
  "auth.email_taken": "该邮箱已注册，请直接登录。",
  "auth.username_taken": "该用户名已被使用，请换一个。",
  "username.invalid_char": "用户名只能使用汉字、英文字母、数字、下划线和连字符，且至少含一个汉字、字母或数字。",
  "username.invalid_length": "用户名须为 3–32 个字符。",
  "avatar.too_large": "请选择不超过 1 MiB 和 1600 万像素的图片。",
  "avatar.invalid_image": "请选择完好的单帧 JPEG、PNG 或 WebP 图片。",
  "avatar.not_found": "该账号还没有头像。",
  "avatar.forbidden": "没有权限查看该头像。",
  "notifications.email_unverified": "请先验证收件邮箱，再开启邮件订阅。",
  "notifications.smtp_unavailable": "验证邮件暂不可用，请稍后重试。",
  "auth.rate_limited": "尝试过于频繁，请稍后再试。",
  "auth.password_mismatch": "当前密码不正确。",
  "auth.invalid_code": "验证码无效或已过期，请重新获取。",
  "asset.in_use": "该素材已被任务使用，无法删除。",
  "asset.not_found": "素材不存在，可能已被删除。",
  "job.invalid_inputs": "素材不满足重建要求，请检查后重试。",
  "job.invalid_input": "请更换无效素材，再创建新任务。",
  "user.not_found": "账号不存在。",
  "admin.self_locked": "不能停用或降级当前登录的管理员。",
  "admin.forbidden": "当前账户已无总管理员权限。",
  "share.not_found": "分享链接不存在或已撤销。",
  "invitation.unavailable": "邀请不可领取。请确认登录邮箱和领取码，或联系项目管理者重新签发。",
  "announcement.not_found": "公告不存在或已删除。",
  "audit.invalid_time": "请检查起止时间格式，结束时间不能早于开始时间。",
};

export type AuditFilters = {
  actor?: string;
  action?: string;
  projectId?: string;
  since?: string;
  until?: string;
};

type Listener = (event: JobEvent) => void;

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES[status] === true;
}

/** Stable server codes win over the raw HTTP detail, which is not translated. */
export function explainError(error: unknown, fallback: string): string {
  if (!(error instanceof ResceneApiError)) return fallback;
  const mapped = error.code ? ERROR_MESSAGES[error.code] : undefined;
  return mapped ?? error.detail;
}

/** True when no response arrived at all, so a queued retry is worth keeping. */
export function isOfflineError(error: unknown): boolean {
  if (error instanceof ResceneApiError) return error.status === 0;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) return false;
  if (error instanceof TypeError) return true;
  if (error && typeof error === "object" && "errMsg" in error) {
    return /fail|timeout|network|offline/i.test(String((error as { errMsg: unknown }).errMsg));
  }
  return false;
}

/** Poll backoff: double per consecutive failure, capped so recovery stays prompt. */
export function nextPollDelay(baseMs: number, failures: number): number {
  return Math.min(MAX_POLL_DELAY_MS, baseMs * 2 ** Math.max(0, failures));
}

/** Reconnect backoff: double per dropped stream, capped below the poll ceiling. */
export function nextReconnectDelay(failures: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures));
}

/** One error mapper for every request path, so headers and details cannot drift. */
async function throwApiError(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiErrorSchema.safeParse(body);
  const detail = parsed.success
    ? typeof parsed.data.detail === "string"
      ? parsed.data.detail
      : JSON.stringify(parsed.data.detail)
    : `HTTP ${response.status}`;
  throw new ResceneApiError(
    response.status,
    detail,
    response.headers.get("x-request-id") ?? undefined,
    response.headers.get("x-error-code") ?? undefined,
    Number(response.headers.get("retry-after")) || undefined,
  );
}

/** Audit filters are entered in the device's local time and sent as UTC instants. */
export function parseAuditLocalRange(sinceInput: string, untilInput: string): { since?: string; until?: string } {
  const parse = (input: string): Date | undefined => {
    const value = input.trim();
    if (!value) return;
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value);
    if (!match || match[1] === "0000") throw new Error("请输入有效的本地时间，格式为 YYYY-MM-DD HH:mm。");
    const [, year, month, day, hour, minute] = match;
    const date = new Date(value.replace(" ", "T"));
    if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month)
      || date.getDate() !== Number(day) || date.getHours() !== Number(hour) || date.getMinutes() !== Number(minute)) {
      throw new Error("请输入有效的本地时间，格式为 YYYY-MM-DD HH:mm。");
    }
    return date;
  };
  const since = parse(sinceInput);
  const until = parse(untilInput);
  if (since && until && until < since) throw new Error("结束时间不能早于开始时间。");
  return { since: since?.toISOString(), until: until?.toISOString() };
}

function auditQuery(params: AuditFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (params.actor) search.set("actor", params.actor);
  if (params.action) search.set("action", params.action);
  if (params.projectId) search.set("project_id", params.projectId);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);
  return search;
}

/** Sends the retry key only when the caller holds one; requests without it keep the old contract. */
function idempotencyHeader(key?: string): { headers?: Record<string, string> } {
  return key ? { headers: { "Idempotency-Key": key } } : {};
}

export class ResceneClient {
  private token: string | null;

  constructor(
    private readonly baseUrl: string,
    token?: string | null,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    this.token = token ?? null;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) await throwApiError(response);
    return response;
  }

  private async send<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);
    if (response.status === 204) return schema.parse(undefined);
    return schema.parse(await response.json());
  }

  async login(identifier: string, password: string): Promise<AuthToken> {
    const address = identifier.trim();
    // Keep email sign-in compatible with servers that only know the original payload.
    const result = await this.send("/v1/auth/login", AuthTokenSchema, {
      method: "POST",
      body: JSON.stringify(address.includes("@") ? { email: address, password } : { identifier: address, password }),
    });
    this.token = result.access_token;
    return result;
  }

  async register(email: string, password: string): Promise<AuthToken> {
    const result = await this.send("/v1/auth/register", AuthTokenSchema, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    this.token = result.access_token;
    return result;
  }

  /** Mail a 6-digit code; the server answers the same whether or not the address is registered. */
  async requestEmailCode(email: string, purpose: EmailCodePurpose): Promise<void> {
    await this.send("/v1/auth/email-code", EmailCodeAcceptedSchema, {
      method: "POST",
      body: JSON.stringify({ email, purpose }),
    });
  }

  async loginWithEmailCode(email: string, code: string): Promise<AuthToken> {
    const result = await this.send("/v1/auth/email-code/login", AuthTokenSchema, {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    this.token = result.access_token;
    return result;
  }

  /** Set a new password with a mailed code; the returned token replaces every old session. */
  async resetPasswordWithEmailCode(email: string, code: string, newPassword: string): Promise<AuthToken> {
    const result = await this.send("/v1/auth/password-reset", AuthTokenSchema, {
      method: "POST",
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });
    this.token = result.access_token;
    return result;
  }

  async refresh(): Promise<AuthToken> {
    const result = await this.send("/v1/auth/refresh", AuthTokenSchema, { method: "POST" });
    this.token = result.access_token;
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.send("/v1/auth/logout", z.void(), { method: "POST" });
    } finally {
      this.token = null;
    }
  }

  async getMe(): Promise<User> {
    return this.send("/v1/auth/me", UserSchema);
  }

  async updateProfile(patch: { username: string }): Promise<User> {
    return this.send("/v1/auth/me", UserSchema, { method: "PATCH", body: JSON.stringify(patch) });
  }

  async setAvatar(imageBase64: string): Promise<User> {
    return this.send("/v1/auth/me/avatar", UserSchema, {
      method: "POST", body: JSON.stringify({ image_base64: imageBase64 }),
    });
  }

  async removeAvatar(): Promise<User> {
    return this.send("/v1/auth/me/avatar", UserSchema, { method: "DELETE" });
  }

  async getAvatar(userId: string): Promise<Avatar> {
    return this.send(`/v1/users/${encodeURIComponent(userId)}/avatar`, AvatarSchema);
  }

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.send("/v1/auth/me/notification-preferences", NotificationPreferencesSchema);
  }

  async updateNotificationPreferences(patch: NotificationPreferencesPatch): Promise<NotificationPreferences> {
    return this.send("/v1/auth/me/notification-preferences", NotificationPreferencesSchema, {
      method: "PATCH", body: JSON.stringify(patch),
    });
  }

  async requestNotificationEmailVerification(): Promise<void> {
    await this.send("/v1/auth/me/email-verification", EmailCodeAcceptedSchema, { method: "POST" });
  }

  async confirmNotificationEmailVerification(code: string): Promise<NotificationPreferences> {
    return this.send("/v1/auth/me/email-verification/confirm", NotificationPreferencesSchema, {
      method: "POST", body: JSON.stringify({ code }),
    });
  }

  /** Rotate the signed-in password; the returned token replaces every other session. */
  async changePassword(currentPassword: string, newPassword: string): Promise<AuthToken> {
    const result = await this.send("/v1/auth/password", AuthTokenSchema, {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    this.token = result.access_token;
    return result;
  }

  async createUser(email: string, password: string, isAdmin = false): Promise<User> {
    return this.send("/v1/users", UserSchema, {
      method: "POST",
      body: JSON.stringify({ email, password, is_admin: isAdmin }),
    });
  }

  async listUsers(
    params: { query?: string; active?: boolean; isAdmin?: boolean; offset?: number; limit?: number } = {},
  ): Promise<AdminUserPage> {
    const search = new URLSearchParams();
    if (params.query) search.set("query", params.query);
    if (params.active !== undefined) search.set("active", String(params.active));
    if (params.isAdmin !== undefined) search.set("is_admin", String(params.isAdmin));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const query = search.toString();
    return this.send(`/v1/users${query ? `?${query}` : ""}`, AdminUserPageSchema);
  }

  async getUser(userId: string): Promise<AdminUserDetail> {
    return this.send(`/v1/users/${encodeURIComponent(userId)}`, AdminUserDetailSchema);
  }

  async updateUser(userId: string, patch: { active?: boolean; is_admin?: boolean }): Promise<AdminUser> {
    return this.send(`/v1/users/${encodeURIComponent(userId)}`, AdminUserSchema, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async resetUserPassword(userId: string, password: string): Promise<void> {
    await this.send(`/v1/users/${encodeURIComponent(userId)}/password`, z.void(), {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async listProjects(): Promise<Project[]> {
    return this.send("/v1/projects", ProjectSchema.array());
  }

  /** Batched card data: one request and one aggregate pass for the whole library. */
  async listProjectSummaries(): Promise<ProjectSummary[]> {
    return this.send("/v1/projects?view=summary", ProjectSummarySchema.array());
  }

  async createProject(name: string, idempotencyKey?: string): Promise<Project> {
    return this.send("/v1/projects", ProjectSchema, {
      method: "POST",
      body: JSON.stringify({ name }),
      ...idempotencyHeader(idempotencyKey),
    });
  }

  async getProject(id: string): Promise<ProjectDetail> {
    return this.send(`/v1/projects/${encodeURIComponent(id)}`, ProjectDetailSchema);
  }

  private getProjectOverview(id: string): Promise<ProjectSummary | ProjectDetail> {
    return this.send(`/v1/projects/${encodeURIComponent(id)}?view=summary`, ProjectOverviewSchema);
  }

  async getProjectSummary(id: string): Promise<ProjectSummary> {
    const project = await this.getProjectOverview(id);
    return "assets" in project ? legacyWorkspace(project) : project;
  }

  async getWorkspace(id: string, assetCursor = "", jobCursor = ""): Promise<ProjectWorkspace> {
    const project = await this.getProjectOverview(id);
    if ("assets" in project) return legacyWorkspace(project);
    const path = `/v1/projects/${encodeURIComponent(id)}`;
    const [assets, jobs] = await Promise.all([
      this.send(`${path}/assets?cursor=${encodeURIComponent(assetCursor)}`, AssetPageSchema),
      this.send(`${path}/jobs?cursor=${encodeURIComponent(jobCursor)}`, JobPageSchema),
    ]);
    return {
      ...project, assets: assets.items, jobs: jobs.items,
      nextAssetCursor: assets.next_cursor, nextJobCursor: jobs.next_cursor,
    };
  }

  async updateProject(id: string, name: string): Promise<Project> {
    return this.send(`/v1/projects/${encodeURIComponent(id)}`, ProjectSchema, {
      method: "PATCH", body: JSON.stringify({ name }),
    });
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/members`, ProjectMemberSchema.array());
  }

  async getAssetPreview(assetId: string): Promise<{ url: string; expires_at: string }> {
    return this.send(`/v1/assets/${encodeURIComponent(assetId)}/preview`, AssetPreviewSchema);
  }

  async addMember(projectId: string, email: string, role: MemberRole): Promise<AddMemberResult> {
    return this.send(
      `/v1/projects/${encodeURIComponent(projectId)}/members`,
      AddMemberResultSchema,
      { method: "POST", body: JSON.stringify({ email, role }) },
    );
  }

  async acceptInvitation(code: string): Promise<AcceptInvitationResult> {
    return this.send("/v1/project-invitations/accept", AcceptInvitationResultSchema, {
      method: "POST",
      body: JSON.stringify({ code: code.trim() }),
    });
  }

  async listInvitations(projectId: string): Promise<ProjectInvitation[]> {
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/invitations`, InvitationSchema.array());
  }

  async revokeInvitation(projectId: string, invitationId: string): Promise<void> {
    await this.send(
      `/v1/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
      z.void(),
      { method: "DELETE" },
    );
  }

  async listProjectAudit(
    projectId: string,
    params: { action?: string; offset?: number; limit?: number } = {},
  ): Promise<AuditPage> {
    const search = new URLSearchParams();
    if (params.action) search.set("action", params.action);
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    search.set("limit", String(params.limit ?? 50));
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/audit?${search.toString()}`, AuditPageSchema);
  }

  /** Platform-wide trail; administrators only. */
  async listAudit(params: AuditFilters & { offset?: number; limit?: number } = {}): Promise<AuditPage> {
    const search = auditQuery(params);
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    search.set("limit", String(params.limit ?? 50));
    return this.send(`/v1/audit?${search.toString()}`, AuditPageSchema);
  }

  async auditActionList(): Promise<string[]> {
    return this.send("/v1/audit/actions", z.string().array());
  }

  /** CSV is not JSON, so it bypasses Zod parsing but keeps the same auth and error mapping. */
  async auditCsv(params: AuditFilters = {}): Promise<Blob> {
    return (await this.auditCsvResponse(params)).blob();
  }

  async auditCsvText(params: AuditFilters = {}): Promise<string> {
    const text = await (await this.auditCsvResponse(params)).text();
    return text.startsWith("\uFEFF") ? text : `\uFEFF${text}`;
  }

  private auditCsvResponse(params: AuditFilters): Promise<Response> {
    const query = auditQuery(params).toString();
    return this.raw(`/v1/audit.csv${query ? `?${query}` : ""}`);
  }

  async createAnnouncement(input: { title: string; body: string; level: AnnouncementLevel }, key?: string): Promise<Announcement> {
    return this.send("/v1/announcements", AnnouncementSchema, {
      method: "POST",
      body: JSON.stringify(input),
      ...idempotencyHeader(key),
    });
  }

  async listAnnouncements(limit = 50, offset = 0): Promise<Announcement[]> {
    return this.send(`/v1/announcements?limit=${limit}${offset > 0 ? `&offset=${offset}` : ""}`, AnnouncementSchema.array());
  }

  async deleteAnnouncement(announcementId: string): Promise<void> {
    await this.send(`/v1/announcements/${encodeURIComponent(announcementId)}`, z.void(), { method: "DELETE" });
  }

  async updateMemberRole(projectId: string, userId: string, role: MemberRole): Promise<ProjectMember> {
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, ProjectMemberSchema, {
      method: "PATCH", body: JSON.stringify({ role }),
    });
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.send(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, z.void(), { method: "DELETE" });
  }

  async deleteProject(id: string): Promise<void> {
    await this.send(`/v1/projects/${encodeURIComponent(id)}`, z.void(), { method: "DELETE" });
  }

  async createUploadSession(projectId: string, init: UploadInit): Promise<UploadGrant> {
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/assets/upload-session`, UploadGrantSchema, {
      method: "POST",
      body: JSON.stringify({ mode: "sts", ...init }),
    });
  }

  async refreshUploadSession(assetId: string, mode: UploadMode = "sts"): Promise<UploadGrant> {
    return this.send(
      `/v1/assets/${encodeURIComponent(assetId)}/upload-session?mode=${mode}`,
      UploadGrantSchema,
      { method: "POST" },
    );
  }

  async completeAsset(assetId: string, size: number, sha256: string) {
    return this.send(`/v1/assets/${encodeURIComponent(assetId)}/complete`, CompleteAssetSchema, {
      method: "POST",
      body: JSON.stringify({ size, sha256 }),
    });
  }

  /** Delete one asset that no job references; the object is removed with the row. */
  async deleteAsset(assetId: string): Promise<void> {
    await this.send(`/v1/assets/${encodeURIComponent(assetId)}`, z.void(), { method: "DELETE" });
  }

  async createJob(projectId: string, profile: Profile, assetIds: string[], idempotencyKey?: string): Promise<Job> {
    return this.send(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, JobSchema, {
      method: "POST",
      body: JSON.stringify({ profile, asset_ids: assetIds }),
      ...idempotencyHeader(idempotencyKey),
    });
  }

  async getJob(id: string): Promise<Job> {
    return this.send(`/v1/jobs/${encodeURIComponent(id)}`, JobSchema);
  }

  async getJobStages(id: string): Promise<JobStage[]> {
    return this.send(`/v1/jobs/${encodeURIComponent(id)}/stages`, JobStageSchema.array());
  }

  async cancelJob(id: string): Promise<Job> {
    return this.send(`/v1/jobs/${encodeURIComponent(id)}/cancel`, JobSchema, { method: "POST" });
  }

  async retryJob(id: string): Promise<Job> {
    return this.send(`/v1/jobs/${encodeURIComponent(id)}/retry`, JobSchema, { method: "POST" });
  }

  async getManifest(reconstructionId: string): Promise<Manifest> {
    return this.send(`/v1/reconstructions/${encodeURIComponent(reconstructionId)}/manifest`, ManifestSchema);
  }

  async listShares(reconstructionId: string): Promise<ShareSummary[]> {
    return this.send(`/v1/reconstructions/${encodeURIComponent(reconstructionId)}/shares`, ShareSummarySchema.array());
  }

  async createShare(reconstructionId: string, expiresAt?: string | null): Promise<Share> {
    return this.send(`/v1/reconstructions/${encodeURIComponent(reconstructionId)}/shares`, ShareSchema, {
      method: "POST",
      body: JSON.stringify(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    });
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.send(`/v1/shares/${encodeURIComponent(shareId)}`, z.void(), { method: "DELETE" });
  }

  async getPublicShare(token: string): Promise<PublicShare> {
    return this.send(`/v1/public/shares/${encodeURIComponent(token)}`, PublicShareSchema);
  }

  /** Server-rendered PNG: neither React Native nor Mini Program renders SVG images. */
  shareQrUrl(token: string): string {
    return `${this.baseUrl}/v1/public/shares/${encodeURIComponent(token)}/qr.png`;
  }

  async getWorkerStatus(): Promise<WorkerStatus> {
    return this.send("/v1/workers/status", WorkerStatusSchema);
  }

  async listNotifications(unreadOnly = false, limit = 50, offset = 0, kind?: NotificationKind): Promise<AppNotification[]> {
    const query = `?unread=${unreadOnly ? 1 : 0}&limit=${limit}&offset=${offset}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`;
    return this.send(`/v1/notifications${query}`, NotificationSchema.array());
  }

  async notificationCount(): Promise<number> {
    const result = await this.send("/v1/notifications/count", NotificationCountSchema);
    return result.unread;
  }

  /** Worker output: `afterId` tails forward, `beforeId` pages backwards. */
  async listJobLogs(
    jobId: string,
    params: { afterId?: number; beforeId?: number; level?: string; limit?: number } = {},
  ): Promise<JobLog[]> {
    const search = new URLSearchParams();
    if (params.afterId !== undefined) search.set("after_id", String(params.afterId));
    if (params.beforeId !== undefined) search.set("before_id", String(params.beforeId));
    if (params.level) search.set("level", params.level);
    search.set("limit", String(params.limit ?? 200));
    const page = await this.send(
      `/v1/jobs/${encodeURIComponent(jobId)}/logs?${search.toString()}`,
      JobLogPageSchema,
    );
    return page.items;
  }

  async markNotificationsRead(ids?: string[]): Promise<{ updated: number }> {
    return this.send("/v1/notifications/read", z.object({ updated: z.number() }), {
      method: "POST",
      body: JSON.stringify({ ids: ids ?? [] }),
    });
  }

  /**
   * Stream job progress. Returns an unsubscribe function.
   *
   * SSE is retried three times; afterwards the stream degrades to polling so a
   * proxy that buffers event-streams cannot freeze the UI.
   */
  subscribeJob(id: string, onEvent: Listener, onError?: (error: Error) => void, options?: JobSubscriptionOptions): () => void {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let lastEventId: string | undefined;
    let reconnects = 0;
    let pollFailures = 0;

    const stop = () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      controller?.abort();
    };
    const report = (error: unknown) => {
      if (closed) return;
      if (error instanceof ResceneApiError && error.status === 401) {
        onError?.(new ResceneApiError(401, "Session expired. Please sign in again.", error.requestId));
      } else {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const emit = (event: JobEvent) => {
      if (closed) return;
      onEvent(event);
      if ("id" in event && isTerminal(event.status)) stop();
    };
    const poll = async () => {
      if (closed) return;
      try {
        const job = await this.getJob(id);
        pollFailures = 0;
        emit(job);
      } catch (error) {
        pollFailures += 1;
        report(error);
        if (error instanceof ResceneApiError && error.status === 401) stop();
      }
      if (!closed) {
        timer = setTimeout(
          () => void poll(),
          nextPollDelay(options?.pollIntervalMs ?? POLL_INTERVAL_MS, pollFailures),
        );
      }
    };
    const connect = async () => {
      if (closed) return;
      try {
        controller = new AbortController();
        const active = controller;
        const armIdle = () => {
          clearTimeout(idleTimer);
          if (closed) return;
          idleTimer = setTimeout(() => {
            if (!closed) active.abort();
          }, options?.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
        };
        armIdle();
        const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
        const response = await this.fetcher(`${this.baseUrl}/v1/jobs/${encodeURIComponent(id)}/events${query}`, {
          headers: {
            Accept: "text/event-stream",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          signal: controller.signal,
        });
        if (lastEventId && response.status === 422) {
          // Fetch a fresh snapshot without replaying already displayed stages.
          void poll();
          return;
        }
        if (!response.ok || !response.body || typeof response.body.getReader !== "function") {
          throw new ResceneApiError(response.status, "Event stream unavailable");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (closed) return;
            if (done) break;
            armIdle();
            buffer += decoder.decode(value, { stream: true });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
              const chunk = buffer.slice(0, match.index);
              buffer = buffer.slice(match.index + match[0].length);
              const event = parseChunk(chunk);
              if (!event) continue;
              if (event.id !== undefined) {
                if (event.id === lastEventId) continue;
                lastEventId = event.id;
              }
              emit(event.payload);
              if (closed) return;
            }
          }
        } finally {
          clearTimeout(idleTimer);
          reader.releaseLock();
        }
        throw new Error("Event stream ended before the job completed");
      } catch (error) {
        if (closed) return;
        if (error instanceof ResceneApiError && error.status === 401) {
          report(error);
          stop();
          return;
        }
        reconnects += 1;
        if (reconnects > MAX_RECONNECTS) {
          report(error);
          void poll();
        } else {
          timer = setTimeout(() => void connect(), nextReconnectDelay(reconnects - 1));
        }
      }
    };

    if (options?.transport === "polling") void poll();
    else void connect();
    return stop;
  }
}

type ParsedChunk = { id?: string; payload: JobEvent };

function parseChunk(chunk: string): ParsedChunk | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const raw of chunk.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) {
      const parsed = line.slice(3).trim();
      if (parsed && !parsed.includes("\0")) id = parsed;
    } else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (event === "final") {
    const job = JobSchema.safeParse(payload);
    return job.success ? { id, payload: job.data } : null;
  }
  if (event === "stage") {
    const stage = StageEventSchema.safeParse(payload);
    return stage.success ? { id, payload: stage.data } : null;
  }
  return null;
}

export function artifactUrl(artifacts: Artifact[], kind: string): string | undefined {
  return artifacts.find((item) => item.kind === kind)?.url;
}

export function parseArtifacts(value: unknown): Artifact[] {
  return ArtifactSchema.array().parse(value);
}
