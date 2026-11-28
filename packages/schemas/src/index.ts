/**
 * Zod contracts mirroring the FastAPI responses one field at a time.
 *
 * Every client response is parsed, so a server field rename fails fast in the
 * app that needs it instead of surfacing as `undefined` in the UI.
 */

import { z } from "zod";

export {
  ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, jobErrorHint,
  PROJECT_SECTIONS, canRetryJob, projectLibraryPage, queuedJobHint, reconcileWorkspaceSelection,
  selectWorkspaceAssets, selectionBytes, stageLabel,
} from "./reconstruction-labels";
export type { ProjectSection } from "./reconstruction-labels";
export { legalDocuments, type LegalDocumentId } from "./legal-documents";

export const ProfileSchema = z.enum(["fast", "balanced", "quality"]);
export const JobStatusSchema = z.enum(["QUEUED", "LEASED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export const AssetStatusSchema = z.enum(["UPLOADING", "READY", "FAILED"]);
export const AssetPreviewSchema = z.object({ url: z.string().url(), expires_at: z.string() });

export const AuthTokenSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
});

export const EmailCodePurposeSchema = z.enum(["login", "reset"]);

/** The request-code route answers 202 for every address, registered or not. */
export const EmailCodeAcceptedSchema = z.object({ status: z.literal("accepted") });

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  is_admin: z.boolean(),
  username: z.string().nullable().default(null),
  avatar_revision: z.string().nullable().default(null),
});

export const MAX_AVATAR_BYTES = 1024 * 1024;
export const AvatarSchema = z.object({
  image_base64: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Avatar = z.infer<typeof AvatarSchema>;

export function accountInitial(user: { username: string | null; email: string }): string {
  const first = (user.username ?? user.email).codePointAt(0);
  return first === undefined ? "?" : String.fromCodePoint(first).toUpperCase();
}

export const EffectiveRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export const MemberRoleSchema = z.enum(["member", "viewer"]);
export const ProjectMemberSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  role: z.enum(["owner", "member", "viewer"]),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string(),
  effective_role: EffectiveRoleSchema,
  created_at: z.string().nullish(),
});

export const AssetSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  status: AssetStatusSchema,
});

export const JobSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  profile: ProfileSchema,
  status: JobStatusSchema,
  progress: z.number(),
  current_stage: z.string().nullish(),
  attempt: z.number(),
  cancel_requested: z.boolean(),
  error_code: z.string().nullish(),
  error_message: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  reconstruction_id: z.string().nullish(),
});

export const ProjectDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string(),
  effective_role: EffectiveRoleSchema,
  assets: z.array(AssetSchema),
  jobs: z.array(JobSchema),
});

export const ProjectSummarySchema = ProjectSchema.extend({
  asset_count: z.number().int().nonnegative(),
  job_count: z.number().int().nonnegative(),
  has_active_jobs: z.boolean(),
  cover: AssetSchema.nullable(),
  latest_job: JobSchema.nullable(),
});

export const AssetPageSchema = z.object({ items: z.array(AssetSchema), next_cursor: z.string().nullable() });
export const JobPageSchema = z.object({ items: z.array(JobSchema), next_cursor: z.string().nullable() });

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectWorkspace = ProjectSummary & {
  assets: Asset[];
  jobs: Job[];
  nextAssetCursor: string | null;
  nextJobCursor: string | null;
};

export const StageEventSchema = z.object({
  stage: z.string(),
  status: z.enum(["running", "success", "failed"]),
  progress: z.number(),
  message: z.string().nullish(),
  metrics: z.record(z.string(), z.unknown()).default({}),
});

export const FinalEventSchema = JobSchema;

export const ArtifactSchema = z.object({
  kind: z.string(),
  url: z.string(),
  sha256: z.string().nullish(),
  size: z.number().nullish(),
  content_type: z.string().nullish(),
});

export const ManifestSchema = z.object({
  version: z.number().optional(),
  reconstruction_id: z.string(),
  artifacts: z.array(ArtifactSchema),
});

export const PublicShareSchema = z.object({
  reconstruction_id: z.string(),
  artifacts: z.array(ArtifactSchema),
});

export const WorkerStatusSchema = z.object({
  online: z.boolean(),
  workers: z.array(
    z.object({
      id: z.string(),
      gpu_name: z.string().nullish(),
      online: z.boolean(),
      last_seen_at: z.string().nullish(),
    }),
  ),
});

export const ApiErrorSchema = z.object({
  detail: z.union([z.string(), z.array(z.unknown())]),
});

export const ShareSchema = z.object({
  id: z.string(),
  token: z.string(),
  expires_at: z.string().nullish(),
});

export const ShareSummarySchema = z.object({
  id: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export type EffectiveRole = z.infer<typeof EffectiveRoleSchema>;
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export type ShareSummary = z.infer<typeof ShareSummarySchema>;

const OssCredentialsSchema = z.object({
  access_key_id: z.string(),
  access_key_secret: z.string(),
  security_token: z.string(),
  expiration: z.string(),
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  issued_at: z.string(),
});

/**
 * The server returns STS credentials for Web/Desktop and a signed PostObject
 * form for Mobile/Mini Program. Older servers omit `mode`, so it defaults to
 * `sts` and the payload shape is what actually decides.
 */
export const UploadGrantSchema = z
  .object({
    asset_id: z.string(),
    object_key: z.string(),
    mode: z.enum(["sts", "post"]).default("sts"),
    oss: OssCredentialsSchema.optional(),
    url: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
    expires_at: z.string().optional(),
  })
  .refine(
    (value) => (value.mode === "post" ? Boolean(value.url && value.fields) : Boolean(value.oss)),
    { message: "upload grant payload does not match its mode" },
  );

export const CompleteAssetSchema = z.object({
  id: z.string(),
  status: AssetStatusSchema,
});

export const JobStageSchema = z.object({
  id: z.string(),
  stage: z.string(),
  status: z.enum(["running", "success", "failed"]),
  progress: z.number(),
  message: z.string().nullable(),
  metrics: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
});

export const AnnouncementLevelSchema = z.enum(["info", "warning", "critical"]);
export const ANNOUNCEMENT_LEVEL_LABELS: Record<z.infer<typeof AnnouncementLevelSchema>, string> = {
  info: "信息", warning: "警告", critical: "重要",
};
export const NotificationKindSchema = z.enum(["announcement", "job.succeeded", "job.failed"]);
export const NOTIFICATION_KIND_LABELS: Record<z.infer<typeof NotificationKindSchema>, string> = {
  announcement: "公告", "job.succeeded": "任务成功", "job.failed": "任务失败",
};

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  project_id: z.string().nullable(),
  job_id: z.string().nullable(),
  announcement_id: z.string().nullable(),
  announcement_level: AnnouncementLevelSchema.nullable().default(null),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: MemberRoleSchema,
  created_at: z.string(),
});

export const AddMemberResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("member"), user_id: z.string(), role: MemberRoleSchema }),
  z.object({
    status: z.literal("invited"),
    email: z.string(),
    role: MemberRoleSchema,
    claim_code: z.string().min(1).optional(),
    expires_at: z.string().optional(),
  }),
]);

export const AcceptInvitationResultSchema = z.object({ project_id: z.string(), role: MemberRoleSchema });

export const AdminUserSchema = UserSchema.extend({
  active: z.boolean(),
  created_at: z.string(),
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  actor_email: z.string().nullable(),
  actor_username: z.string().nullable().default(null),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const AdminUserPageSchema = z.object({
  total: z.number().int(),
  items: AdminUserSchema.array(),
});

export const UserMembershipSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  role: EffectiveRoleSchema,
});

export const AdminUserDetailSchema = AdminUserSchema.extend({
  memberships: UserMembershipSchema.array(),
});

export const AnnouncementSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  level: AnnouncementLevelSchema,
  created_by: z.string().nullable(),
  created_at: z.string(),
  recipient_count: z.number().int().nonnegative().nullable().default(null),
  read_count: z.number().int().nonnegative().nullable().default(null),
  mail_pending: z.number().int().nonnegative().nullable().default(null),
  mail_accepted: z.number().int().nonnegative().nullable().default(null),
  mail_failed: z.number().int().nonnegative().nullable().default(null),
  mail_unknown: z.number().int().nonnegative().nullable().default(null),
});

export const AuditPageSchema = z.object({
  total: z.number().int(),
  items: AuditEntrySchema.array(),
});

export const JobLogSchema = z.object({
  id: z.number().int(),
  attempt: z.number().int().nonnegative().nullable().default(null),
  level: z.enum(["debug", "info", "warning", "error"]),
  message: z.string(),
  created_at: z.string(),
});

export const JobLogPageSchema = z.object({
  items: JobLogSchema.array(),
});

export const NotificationCountSchema = z.object({
  unread: z.number().int(),
});

export const NotificationPreferencesSchema = z.object({
  email_verified: z.boolean(),
  email_critical_announcements: z.boolean(),
  email_job_results: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationPreferencesPatch = Partial<Omit<NotificationPreferences, "email_verified">>;
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export type Profile = z.infer<typeof ProfileSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type AuthToken = z.infer<typeof AuthTokenSchema>;
export type EmailCodePurpose = z.infer<typeof EmailCodePurposeSchema>;
export type User = z.infer<typeof UserSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Job = z.infer<typeof JobSchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export type StageEvent = z.infer<typeof StageEventSchema>;
export type FinalEvent = z.infer<typeof FinalEventSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type PublicShare = z.infer<typeof PublicShareSchema>;
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export type Share = z.infer<typeof ShareSchema>;
export type UploadGrant = z.infer<typeof UploadGrantSchema>;
export type JobStage = z.infer<typeof JobStageSchema>;
export type AppNotification = z.infer<typeof NotificationSchema>;
export type ProjectInvitation = z.infer<typeof InvitationSchema>;
export type AddMemberResult = z.infer<typeof AddMemberResultSchema>;
export type AcceptInvitationResult = z.infer<typeof AcceptInvitationResultSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AdminUserPage = z.infer<typeof AdminUserPageSchema>;
export type UserMembership = z.infer<typeof UserMembershipSchema>;
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;
export type AnnouncementLevel = z.infer<typeof AnnouncementLevelSchema>;
export type Announcement = z.infer<typeof AnnouncementSchema>;
export type AuditPage = z.infer<typeof AuditPageSchema>;
export type JobLog = z.infer<typeof JobLogSchema>;
export type JobLogPage = z.infer<typeof JobLogPageSchema>;
export type NotificationCount = z.infer<typeof NotificationCountSchema>;
