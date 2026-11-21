"use client";

import { ResceneApiError, explainError, type JobEvent, type ResceneClient } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, canRetryJob, jobErrorHint, queuedJobHint, reconcileWorkspaceSelection, selectWorkspaceAssets, selectionBytes, stageLabel } from "@rescene/schemas";
import type {
  AppNotification,
  Artifact,
  Asset,
  AuditEntry,
  Job,
  JobLog,
  JobStage,
  MemberRole,
  Profile,
  ProjectSummary,
  ProjectWorkspace,
  ProjectInvitation,
  ProjectMember,
  ShareSummary,
  User,
  WorkerStatus,
} from "@rescene/schemas";
import { inspectMedia, newIdempotencyKey, SAMPLE_SIDE, summarizeMediaWarnings, type UploadAdapter } from "@rescene/uploader";
import { type ComponentType, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { AdminConsole } from "./AdminConsole";
import { BrandMark } from "./BrandMark";
import { ThemeControl } from "./ThemeControl";
import { AssetPreview } from "./AssetPreview";
import { ProjectCard } from "./ProjectCard";

export type KeyValueStore = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
export type WorkbenchViewerProps = { src: string; artifactKind?: string; reconstructionId?: string; sha256?: string; size?: number; onStatus?: (status: "loading" | "ready" | "error", detail?: string) => void; onRetry?: () => void };
export type WorkbenchProps = { client: ResceneClient; uploader: UploadAdapter; viewer: ComponentType<WorkbenchViewerProps>; tokenStore: KeyValueStore; webBaseUrl: string };

const TOKEN_KEY = "rescene-token";
const PROJECT_KEY = "rescene-project";
const JOB_KEY = "rescene-job";
const ACTIVE: Record<string, boolean> = { QUEUED: true, LEASED: true, RUNNING: true };
const TERMINAL_JOB = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** A newer snapshot wins, but a late queue row may never rewind a terminal outcome. */
function preferredJob(live: Job | undefined, snapshot: Job | undefined): Job | undefined {
  if (!live) return snapshot;
  if (!snapshot || snapshot.id !== live.id) return live;
  const liveTerminal = TERMINAL_JOB.has(live.status);
  const snapshotTerminal = TERMINAL_JOB.has(snapshot.status);
  if (liveTerminal !== snapshotTerminal) return liveTerminal ? live : snapshot;
  return Date.parse(snapshot.updated_at) > Date.parse(live.updated_at) ? snapshot : live;
}
const PROFILES: Profile[] = ["fast", "balanced", "quality"];
const PANES = [{ key: "materials", label: "素材" }, { key: "tasks", label: "任务" }, { key: "results", label: "结果" }] as const;
const NOTIFY_PAGE_SIZE = 20;
type UploadItem = { name: string; progress: number; status: string; file?: File; projectId?: string; retryable?: boolean };
type UploadBatch = { items: UploadItem[]; busy: boolean };
type TimelineRow = { key: string; jobId: string; stage: string; status: string; progress: number; message?: string | null; metrics: Record<string, unknown> };
type RefreshFailure = { message: string; at: number };

/** Dedupe replayed stage events by their full content so same-stage reruns stay visible. */
function stageSignature(row: Pick<TimelineRow, "stage" | "status" | "progress" | "message" | "metrics">): string {
  const metrics = Object.keys(row.metrics).sort().map((key) => [key, row.metrics[key]]);
  return JSON.stringify([row.stage, row.status, row.progress, row.message ?? null, metrics]);
}

function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
type SharePreset = "never" | "1d" | "7d" | "30d";
type NotifyFilter = "unread" | "all";
type LogLevel = "" | "info" | "warning" | "error";
const SHARE_PRESETS: { value: SharePreset; label: string; ms: number | null }[] = [
  { value: "never", label: "永久", ms: null },
  { value: "1d", label: "1 天", ms: 86_400_000 },
  { value: "7d", label: "7 天", ms: 604_800_000 },
  { value: "30d", label: "30 天", ms: 2_592_000_000 },
];

export function Workbench({ client, uploader, viewer: Viewer, tokenStore, webBaseUrl }: WorkbenchProps) {
  const [token, setToken] = useState(client.getToken() ?? "");
  const [sessionReady, setSessionReady] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [detail, setDetail] = useState<ProjectWorkspace | null>(null);
  const [assetPages, setAssetPages] = useState([""]);
  const [jobPages, setJobPages] = useState([""]);
  const [pane, setPane] = useState<(typeof PANES)[number]["key"]>("materials");
  const workspaceRequest = useRef(0);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [sharesState, setSharesState] = useState<{ reconstructionId: string; items: ShareSummary[] }>({ reconstructionId: "", items: [] });
  const shareRequest = useRef(0);
  const [search, setSearch] = useState("");
  const [profile, setProfile] = useState<Profile>("balanced");
  const [selectedAssets, setSelectedAssets] = useState<Asset[]>([]);
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const [uploadBatches, setUploadBatches] = useState<Record<string, UploadBatch>>({});
  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const projectAttempt = useRef<{ name: string; key: string } | null>(null);
  const jobAttempt = useRef<{ signature: string; key: string } | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [scene, setScene] = useState<{ reconstructionId: string; kind: string } | null>(null);
  const sceneDialog = useRef<HTMLDialogElement>(null);
  const [viewerStatus, setViewerStatus] = useState("");
  const [createdShare, setCreatedShare] = useState<{ reconstructionId: string; link: string; token: string } | null>(null);
  const [sharePreset, setSharePreset] = useState<SharePreset>("7d");
  const [message, setMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const liveEventKey = useRef(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [issuedInvitation, setIssuedInvitation] = useState<{ projectId: string; email: string; code: string } | null>(null);
  const [issuingInvitation, setIssuingInvitation] = useState(false);
  const [acceptingInvitation, setAcceptingInvitation] = useState(false);
  const invitationContext = useRef(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const online = workerStatus?.online ?? null;
  const [navigatorOnline, setNavigatorOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [staleRefresh, setStaleRefresh] = useState<RefreshFailure | null>(null);
  const [detailFetchedAt, setDetailFetchedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [materialError, setMaterialError] = useState("");
  const workspaceGridRef = useRef<HTMLDivElement>(null);
  const materialActionsRef = useRef<HTMLElement>(null);
  const projectNameRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"project" | "admin">("project");
  const [navOpen, setNavOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1024px)").matches);
  const asideRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const projectHeadingRef = useRef<HTMLHeadingElement>(null);
  const navReturnFocus = useRef<"toggle" | "content" | null>(null);
  const [notifyFilter, setNotifyFilter] = useState<NotifyFilter>("all");
  const [notifyOffset, setNotifyOffset] = useState(0);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyHasMore, setNotifyHasMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [loadingEarlierJob, setLoadingEarlierJob] = useState("");
  const logsGeneration = useRef(0);
  const earlierJob = useRef("");
  const notifyFilterRef = useRef<NotifyFilter>(notifyFilter);
  notifyFilterRef.current = notifyFilter;
  const notifyRequest = useRef(0);
  const notifyLoaded = useRef(false);
  const notifyOpen = useRef(false);
  const previousUnreadCount = useRef<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  useEffect(() => {
    setIssuedInvitation(null);
    return () => { invitationContext.current += 1; };
  }, [selected, token, view]);
  useEffect(() => {
    if (!issuedInvitation) return;
    const timer = setTimeout(() => setIssuedInvitation(null), 120_000);
    return () => clearTimeout(timer);
  }, [issuedInvitation]);
  useEffect(() => {
    const update = () => setNavigatorOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    const dialog = sceneDialog.current;
    if (!scene || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [scene]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1024px)");
    const sync = () => {
      setNarrow(query.matches);
      if (!query.matches) setNavOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      navReturnFocus.current = "toggle";
      setNavOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);
  useEffect(() => {
    if (!narrow) return;
    if (navOpen) {
      const first = asideRef.current?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), [href]');
      first?.focus();
      return;
    }
    const target = navReturnFocus.current === "content" ? projectHeadingRef.current : navReturnFocus.current === "toggle" ? navToggleRef.current : null;
    if (!target) return;
    navReturnFocus.current = null;
    target.focus();
  }, [detail?.name, narrow, navOpen, view]);

  useEffect(() => {
    const grid = workspaceGridRef.current;
    const actions = materialActionsRef.current;
    if (!grid || !actions || pane !== "materials" || view !== "project") return;
    const query = window.matchMedia("(max-width: 640px)");
    const measure = () => {
      if (query.matches) grid.style.setProperty("--material-actions-height", `${actions.getBoundingClientRect().height}px`);
      else grid.style.removeProperty("--material-actions-height");
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(actions);
    query.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      query.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      grid.style.removeProperty("--material-actions-height");
    };
  }, [pane, view, detail?.id, detail?.effective_role]);

  useEffect(() => {
    const saved = tokenStore.get(TOKEN_KEY);
    if (saved) {
      client.setToken(saved);
      setToken(saved);
    }
    setSelected(tokenStore.get(PROJECT_KEY) ?? "");
    setSelectedJob(tokenStore.get(JOB_KEY) ?? "");
    setSessionReady(true);
  }, [client, tokenStore]);
  const expire = useCallback(() => { client.setToken(null); tokenStore.remove(TOKEN_KEY); setToken(""); setMe(null); setMessage("登录已过期，请重新登录。"); }, [client, tokenStore]);
  const loadNotifications = useCallback(async (filter: NotifyFilter = notifyFilterRef.current, offset = 0, mode: "replace" | "merge" = "replace"): Promise<AppNotification[]> => {
    const request = ++notifyRequest.current;
    setNotifyLoading(true);
    try {
      const list = await client.listNotifications(filter === "unread", NOTIFY_PAGE_SIZE, offset);
      if (request !== notifyRequest.current) return list;
      setNotifications((current) => {
        if (offset === 0) {
          notifyLoaded.current = true;
          const seen = new Set(list.map((item) => item.id));
          if (mode === "replace") return [...new Map(list.map((item) => [item.id, item])).values()];
          return [...list, ...current.filter((item) => !seen.has(item.id))];
        }
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...list.filter((item) => !seen.has(item.id))];
      });
      if (offset === 0 && mode === "merge") {
        // Keep the loaded pages and paging cursor; a refreshed first page must not reset them.
        setNotifyHasMore((current) => current || list.length >= NOTIFY_PAGE_SIZE);
      } else {
        setNotifyOffset(offset);
        setNotifyHasMore(list.length >= NOTIFY_PAGE_SIZE);
      }
      return list;
    } finally {
      if (request === notifyRequest.current) setNotifyLoading(false);
    }
  }, [client]);
  const reloadNotifications = useCallback(() => {
    void loadNotifications(notifyFilterRef.current, 0, "merge").catch((error: unknown) => {
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(explainError(error, "无法加载通知"));
    });
  }, [expire, loadNotifications]);
  const loadUnread = useCallback(async () => {
    try {
      setUnreadCount(await client.notificationCount());
    } catch (error) {
      // The badge falls back to the loaded page when the count endpoint is unavailable.
      if (error instanceof ResceneApiError && error.status === 401) expire();
    }
  }, [client, expire]);
  const refresh = useCallback(async () => {
    if (!token) return;
    const request = ++workspaceRequest.current;
    try {
      const [user, list, worker] = await Promise.all([
        client.getMe(), client.listProjectSummaries(), client.getWorkerStatus().catch((error: unknown) => {
          if (error instanceof ResceneApiError && error.status === 401) throw error;
          return null;
        }),
      ]);
      if (request !== workspaceRequest.current) return;
      setMe(user); setProjects(list); setWorkerStatus(worker); setLoaded(true); setLibraryError("");
      if (!notifyLoaded.current) void loadNotifications().catch((error: unknown) => { if (error instanceof ResceneApiError && error.status === 401) expire(); });
      void loadUnread();
      if (selected && selectedRef.current === selected && request === workspaceRequest.current) {
        if (!detailRef.current) setDetailLoading(true);
        try {
          const project = await client.getWorkspace(selected, assetPages[assetPages.length - 1], jobPages[jobPages.length - 1]);
          if (selectedRef.current === selected && request === workspaceRequest.current) {
            setDetail(project);
            setSelectedAssets((current) => reconcileWorkspaceSelection(current, project.assets));
            setDetailError("");
            setStaleRefresh(null);
            setDetailFetchedAt(Date.now());
          }
        } catch (error) {
          if (error instanceof ResceneApiError && error.status === 401) throw error;
          if (selectedRef.current === selected && request === workspaceRequest.current) {
            const text = error instanceof ResceneApiError && error.status === 403
              ? "当前账号无权访问该项目。"
              : error instanceof Error ? error.message : "无法加载项目。";
            if (error instanceof ResceneApiError && [403, 404].includes(error.status)) {
              setDetail(null);
              setDetailError(text);
              setStaleRefresh(null);
            } else if (detailRef.current) {
              // Keep the last snapshot on screen, but say clearly that it is stale.
              setStaleRefresh({ message: text, at: Date.now() });
            } else {
              setDetailError(text);
            }
          }
        } finally {
          if (request === workspaceRequest.current) setDetailLoading(false);
        }
      }
    } catch (error) {
      if (request !== workspaceRequest.current) return;
      setWorkerStatus(null);
      setLoaded(true);
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else {
        const text = error instanceof Error ? error.message : "请求失败，请重试";
        setLibraryError(text);
        if (detailRef.current) setStaleRefresh({ message: text, at: Date.now() });
      }
    }
  }, [assetPages, client, expire, jobPages, loadNotifications, loadUnread, selected, token]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const previous = previousUnreadCount.current;
    previousUnreadCount.current = unreadCount;
    if (!notifyOpen.current || unreadCount === null || previous === null || unreadCount <= previous) return;
    // The badge found new notifications while the panel was already open.
    reloadNotifications();
  }, [reloadNotifications, unreadCount]);
  useEffect(() => {
    if (token) return;
    notifyRequest.current += 1;
    notifyLoaded.current = false;
    notifyOpen.current = false;
    previousUnreadCount.current = null;
    setNotifications([]); setUnreadCount(null); setNotifyHasMore(false); setNotifyOffset(0); setNotifyLoading(false);
    setUploadBatches({});
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      try {
        const encoded = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(atob(encoded.padEnd(encoded.length + (4 - (encoded.length % 4)) % 4, "="))) as { exp?: number };
        if (payload.exp && payload.exp * 1000 > Date.now() && payload.exp * 1000 - Date.now() < 5 * 60_000) {
          void client.refresh().then((result) => { tokenStore.set(TOKEN_KEY, result.access_token); setToken(result.access_token); }).catch((error: unknown) => { if (error instanceof ResceneApiError && error.status === 401) expire(); });
        }
      } catch { /* Non-JWT tokens cannot be proactively renewed. */ }
    }, 60_000);
    return () => clearInterval(timer);
  }, [client, expire, token, tokenStore]);
  const previousSelection = useRef(selected);
  useEffect(() => {
    if (previousSelection.current === selected) return;
    previousSelection.current = selected;
    setSelectedAssets([]); setDetail(null); setLiveJob(null); setScene(null); setArtifacts([]); setMembers([]); setSharesState({ reconstructionId: "", items: [] }); setCreatedShare(null); setTimeline([]); setInvitations([]); setAudit([]); setStaleRefresh(null); setDetailFetchedAt(null);
  }, [selected]);
  const listedJob = detail?.jobs.find((job) => job.id === selectedJob);
  const currentJob = listedJob ?? (selectedJob ? undefined : detail?.jobs[0]);
  const liveSelected = liveJob && liveJob.id === (selectedJob || currentJob?.id) ? liveJob : undefined;
  const latest = preferredJob(liveSelected, currentJob);
  const latestRef = useRef<Job | null>(null);
  latestRef.current = latest ?? null;
  const loadedProjectId = detail?.id;
  useEffect(() => {
    if (!loadedProjectId || !selectedJob || listedJob) return;
    let active = true;
    void client.getJob(selectedJob).then((job) => {
      if (!active) return;
      if (job.project_id === loadedProjectId) setLiveJob((current) => preferredJob(current ?? undefined, job) ?? job);
      else setSelectedJob("");
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else { setSelectedJob(""); setMessage(explainError(error, "无法加载选中的任务")); }
    });
    return () => { active = false; };
  }, [client, expire, listedJob?.id, loadedProjectId, selectedJob]);
  const reconstructionId = latest?.reconstruction_id ?? "";
  const activeReconstruction = useRef(reconstructionId);
  activeReconstruction.current = reconstructionId;
  useEffect(() => { setScene(null); setArtifacts([]); }, [reconstructionId]);
  const canManage = detail?.effective_role === "owner" || detail?.effective_role === "admin";
  const canWrite = canManage || detail?.effective_role === "member";
  const activeJobId = latest && ACTIVE[latest.status] ? latest.id : undefined;
  useEffect(() => {
    if (!token || !activeJobId) return;
    const id = activeJobId;
    // `refresh` changes identity with pagination and tokens; keeping it in a ref avoids resubscribing (and replaying stages) on every page change.
    return client.subscribeJob(id, (event: JobEvent) => {
      if ("stage" in event) {
        const row: TimelineRow = { key: `live-${++liveEventKey.current}`, jobId: id, stage: event.stage, status: event.status, progress: event.progress, message: event.message, metrics: event.metrics };
        const signature = stageSignature(row);
        setTimeline((rows) => rows.some((existing) => stageSignature(existing) === signature) ? rows : [...rows, row].slice(-100));
        setLiveJob((job) => {
          const base = job && job.id === id ? job : latestRef.current;
          if (!base || base.id !== id || base.project_id !== detailRef.current?.id) return job;
          return { ...base, progress: event.progress, current_stage: event.stage };
        });
      }
      else {
        if (event.id !== id || event.project_id !== detailRef.current?.id) return;
        setLiveJob(event);
        if (!ACTIVE[event.status]) void refreshRef.current();
      }
    }, (error) => {
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(`进度流中断：${error.message}`);
    });
  }, [activeJobId, client, expire, token]);
  useEffect(() => {
    const id = latest?.id;
    if (!id) { setTimeline([]); return; }
    let cancelled = false;
    void client.getJobStages(id).then((rows: JobStage[]) => {
      if (cancelled) return;
      setTimeline((current) => {
        const loaded: TimelineRow[] = rows.map((row) => ({ key: row.id, jobId: id, stage: row.stage, status: row.status, progress: row.progress, message: row.message, metrics: row.metrics }));
        const signatures = new Set(loaded.map(stageSignature));
        // Events that arrived while history was loading are newer than the replay; keep them once.
        const live = current.filter((row) => row.jobId === id && row.key.startsWith("live-") && !signatures.has(stageSignature(row)));
        return [...loaded, ...live].slice(-100);
      });
    }).catch((error: unknown) => { if (!cancelled) setMessage(explainError(error, "无法加载阶段记录")); });
    return () => { cancelled = true; };
  }, [client, latest?.id]);
  useEffect(() => {
    const id = latest?.id;
    const status = latest?.status ?? "";
    const level = logLevel || undefined;
    logsGeneration.current += 1;
    setLogs([]);
    if (!id) return;
    let cancelled = false;
    let lastId = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    setLogsLoading(true);
    void client.listJobLogs(id, { limit: 200, level }).then((rows) => {
      if (cancelled) return;
      setLogs(rows);
      lastId = rows.length > 0 ? rows[rows.length - 1].id : 0;
    }).catch((error: unknown) => { if (!cancelled) setMessage(explainError(error, "无法加载运行日志")); })
      .finally(() => { if (!cancelled) setLogsLoading(false); });
    if (ACTIVE[status]) {
      timer = setInterval(() => {
        void client.listJobLogs(id, { afterId: lastId > 0 ? lastId : undefined, limit: 200, level }).then((rows) => {
          if (cancelled || rows.length === 0) return;
          lastId = rows[rows.length - 1].id;
          setLogs((current) => {
            const seen = new Set(current.map((line) => line.id));
            return [...current, ...rows.filter((line) => !seen.has(line.id))].slice(-500);
          });
        }).catch(() => { /* Runtime logs are best-effort; task progress stays authoritative. */ });
      }, 3000);
    }
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, latest?.id, latest?.status, logLevel]);
  useEffect(() => {
    if (!selected || !detail) return;
    let cancelled = false;
    const fail = (error: unknown, fallback: string) => { if (!cancelled) setMessage(explainError(error, fallback)); };
    void client.listMembers(selected).then((list) => { if (!cancelled) setMembers(list); }).catch((error: unknown) => fail(error, "无法加载成员"));
    if (detail.effective_role === "owner" || detail.effective_role === "admin") {
      void client.listInvitations(selected).then((list) => { if (!cancelled) setInvitations(list); }).catch((error: unknown) => fail(error, "无法加载邀请"));
    } else {
      setInvitations([]);
    }
    return () => { cancelled = true; };
  }, [client, detail?.effective_role, selected]);
  const loadShares = useCallback(async (id: string) => {
    const request = ++shareRequest.current;
    const list = await client.listShares(id);
    if (request !== shareRequest.current || activeReconstruction.current !== id) return;
    setSharesState({ reconstructionId: id, items: list });
  }, [client]);
  useEffect(() => {
    setSharesState({ reconstructionId: "", items: [] }); setCreatedShare(null);
    if (!reconstructionId) return;
    const id = reconstructionId;
    let cancelled = false;
    const fail = (error: unknown, fallback: string) => {
      if (cancelled || activeReconstruction.current !== id) return;
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(error instanceof Error ? error.message : fallback);
    };
    void client.getManifest(id).then((manifest) => { if (!cancelled && activeReconstruction.current === id) setArtifacts(manifest.artifacts); }).catch((error: unknown) => fail(error, "无法加载产物"));
    if (canWrite) void loadShares(id).catch((error: unknown) => fail(error, "无法加载分享"));
    return () => { cancelled = true; };
  }, [canWrite, client, expire, loadShares, reconstructionId]);
  function runAction(action: () => Promise<void>) { void action().catch((error: unknown) => { if (error instanceof ResceneApiError && error.status === 401) expire(); else setMessage(explainError(error, "操作失败")); }); }
  const shares = sharesState.reconstructionId === reconstructionId ? sharesState.items : [];
  const activeCreatedShare = createdShare?.reconstructionId === reconstructionId ? createdShare : null;
  function runShareAction(id: string, action: () => Promise<void>) {
    void action().catch((error: unknown) => {
      if (error instanceof ResceneApiError && error.status === 401) { expire(); return; }
      if (activeReconstruction.current !== id) return;
      setMessage(explainError(error, "操作失败"));
    });
  }
  async function issueInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (issuingInvitation) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const context = invitationContext.current;
    setIssuedInvitation(null);
    setIssuingInvitation(true);
    setMessage("");
    try {
      const result = await client.addMember(selected, String(data.get("email")), data.get("role") as MemberRole);
      if (context !== invitationContext.current) return;
      form.reset();
      if (result.status === "invited") {
        if (result.claim_code) setIssuedInvitation({ projectId: selected, email: result.email, code: result.claim_code });
        else setMessage("当前服务端版本无法提供领取码。请在升级后重新签发邀请。");
        const pending = await client.listInvitations(selected);
        if (context === invitationContext.current) setInvitations(pending);
      } else {
        setMessage("该账号已是项目成员，可在成员列表调整角色。");
      }
    } catch (error) {
      if (context === invitationContext.current) {
        if (error instanceof ResceneApiError && error.status === 401) expire();
        else setMessage(explainError(error, "签发邀请失败"));
      }
    } finally {
      setIssuingInvitation(false);
    }
  }
  async function acceptInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code || acceptingInvitation) return;
    const context = invitationContext.current;
    setAcceptingInvitation(true);
    setMessage("");
    try {
      const result = await client.acceptInvitation(code);
      form.reset();
      if (context !== invitationContext.current) return;
      setSearch("");
      selectProject(result.project_id);
      setMessage("已领取邀请。");
      if (result.project_id === selected) await refresh();
    } catch (error) {
      if (context === invitationContext.current) {
        if (error instanceof ResceneApiError && error.status === 401) expire();
        else setMessage(explainError(error, "领取邀请失败"));
      }
    } finally {
      setAcceptingInvitation(false);
    }
  }
  function selectProject(id: string) {
    setView("project");
    if (narrow && navOpen) navReturnFocus.current = id ? "content" : "toggle";
    setNavOpen(false);
    setSelected(id);
    setSelectedJob("");
    setAssetPages([""]);
    setJobPages([""]);
    setPane("materials");
    setMaterialError("");
    setDetail(null);
    setDetailError("");
    setStaleRefresh(null);
    setDetailFetchedAt(null);
    tokenStore.remove(JOB_KEY);
    if (id) tokenStore.set(PROJECT_KEY, id);
    else tokenStore.remove(PROJECT_KEY);
  }
  function selectJob(id: string) { setSelectedJob(id); tokenStore.set(JOB_KEY, id); setLiveJob(null); setScene(null); setArtifacts([]); setTimeline([]); }
  function changePage(which: "assets" | "jobs", cursor?: string) {
    if (detailLoading) return;
    setDetailLoading(true);
    const setPages = which === "assets" ? setAssetPages : setJobPages;
    setPages((current) => cursor ? [...current, cursor] : current.slice(0, -1));
    if (which === "jobs") { selectJob(""); tokenStore.remove(JOB_KEY); }
  }
  function chooseAssets(assets: Asset[], imagesOnly = false) {
    try { setSelectedAssets(selectWorkspaceAssets(selectedAssets, assets, imagesOnly)); setMaterialError(""); }
    catch (error) { setMaterialError(explainError(error, "无法选择素材")); }
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPending) return;
    const form = new FormData(event.currentTarget);
    setAuthPending(true);
    try {
      const result = await client.login(String(form.get("email") ?? "").trim(), String(form.get("password") ?? ""));
      tokenStore.set(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setMessage("");
    } catch (error) {
      if (error instanceof ResceneApiError && (error.status === 401 || error.status === 403)) setMessage("邮箱或密码不正确。");
      else setMessage(error instanceof Error ? error.message : "登录失败");
    } finally { setAuthPending(false); }
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPending) return;
    const form = new FormData(event.currentTarget);
    setAuthPending(true);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    try {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("请输入有效的邮箱地址。");
      if (password.length < 12) throw new Error("密码至少 12 位。");
      if (password !== confirm) throw new Error("两次输入的密码不一致。");
      const result = await client.register(email, password);
      tokenStore.set(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setMessage("");
      setAuthMode("login");
    } catch (error) {
      if (error instanceof ResceneApiError && error.status === 409) setMessage("该邮箱已注册，请直接登录。");
      else setMessage(error instanceof Error ? error.message : "注册失败");
    } finally { setAuthPending(false); }
  }
  async function signOut() { let failed = false; try { await client.logout(); } catch { failed = true; } finally { client.setToken(null); tokenStore.remove(TOKEN_KEY); tokenStore.remove(PROJECT_KEY); tokenStore.remove(JOB_KEY); setToken(""); setMe(null); setSelected(""); setMessage(failed ? "已在本设备退出，但无法确认其他设备的会话已撤销；请重新登录后重试。" : ""); } }
  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get("new") ?? "");
    if (next !== String(data.get("confirm") ?? "")) { setMessage("两次输入的新密码不一致。"); return; }
    runAction(async () => {
      const result = await client.changePassword(String(data.get("current") ?? ""), next);
      tokenStore.set(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      form.reset();
      setMessage("密码已更新，其他设备已退出登录。");
    });
  }
  async function createProject(form: HTMLFormElement) {
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) throw new Error("请输入项目名称");
    const attempt = projectAttempt.current?.name === name ? projectAttempt.current : { name, key: newIdempotencyKey() };
    projectAttempt.current = attempt;
    const project = await client.createProject(name, attempt.key);
    projectAttempt.current = null;
    form.reset();
    selectProject(project.id);
    await refresh();
  }
  function patchUpload(projectId: string, index: number, patch: Partial<UploadItem>) {
    setUploadBatches((batches) => {
      const batch = batches[projectId];
      if (!batch?.items[index]) return batches;
      return { ...batches, [projectId]: { ...batch, items: batch.items.map((item, n) => n === index ? { ...item, ...patch } : item) } };
    });
  }
  async function transfer(file: File, projectId: string, index: number) {
    patchUpload(projectId, index, { status: "上传中", retryable: false });
    try {
      await uploader.upload({ projectId, file }, (progress) => patchUpload(projectId, index, { progress, status: "上传中" }));
      patchUpload(projectId, index, { progress: 100, status: "完成" });
    } catch (error) {
      patchUpload(projectId, index, { status: `失败：${error instanceof Error ? error.message : "上传失败"}`, retryable: true });
    }
  }
  async function upload(files: FileList | null) {
    const projectId = selected;
    if (!files?.length || !projectId || uploadBatches[projectId]?.busy || !canWrite) return;
    const list = Array.from(files);
    setUploadBatches((batches) => ({ ...batches, [projectId]: { busy: true, items: [] } }));
    setMaterialError("");
    try {
      setMessage("正在检查素材…");
      const warnings = await inspectMedia(list, async (file) => new Uint8Array(await file.slice(0, 16).arrayBuffer()), async (file) => {
        const bitmap = await createImageBitmap(file, { resizeWidth: SAMPLE_SIDE, resizeHeight: SAMPLE_SIDE })
          .catch(() => { throw new Error("无法解码图片"); });
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = SAMPLE_SIDE;
          const context = canvas.getContext("2d");
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
          return context.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data;
        } finally { bitmap.close(); }
      });
      setMessage("");
      if (warnings.length && !window.confirm(`素材检查提示\n${summarizeMediaWarnings(warnings)}\n仍然上传？`)) return;
      setUploadBatches((batches) => ({ ...batches, [projectId]: { busy: true, items: list.map((file) => ({ name: file.name, progress: 0, status: "等待上传", file, projectId })) } }));
      for (let index = 0; index < list.length; index++) await transfer(list[index], projectId, index);
      if (selectedRef.current === projectId) await refresh();
    } catch (error) {
      if (selectedRef.current === projectId) { setMessage(""); setMaterialError(error instanceof Error ? error.message : "素材检查失败"); }
    } finally {
      setUploadBatches((batches) => batches[projectId] ? { ...batches, [projectId]: { ...batches[projectId], busy: false } } : batches);
    }
  }
  async function retryUpload(index: number) {
    const projectId = selected;
    const batch = uploadBatches[projectId];
    const item = batch?.items[index];
    if (!item?.file || !item.projectId || batch?.busy) return;
    setUploadBatches((batches) => batches[projectId] ? { ...batches, [projectId]: { ...batches[projectId], busy: true } } : batches);
    try {
      await transfer(item.file, item.projectId, index);
      if (selectedRef.current === projectId) await refresh();
    } finally {
      setUploadBatches((batches) => batches[projectId] ? { ...batches, [projectId]: { ...batches[projectId], busy: false } } : batches);
    }
  }
  async function createJob() {
    if (createLock.current || !selected || !canWrite) return;
    if (!selectedAssets.length) throw new Error("请先选择至少一个素材");
    const ids = selectedAssets.map((asset) => asset.id);
    const signature = JSON.stringify([selected, profile, [...ids].sort()]);
    const attempt = jobAttempt.current?.signature === signature ? jobAttempt.current : { signature, key: newIdempotencyKey() };
    jobAttempt.current = attempt;
    createLock.current = true; setCreating(true);
    try {
      const job = await client.createJob(selected, profile, ids, attempt.key);
      jobAttempt.current = null;
      selectJob(job.id); setLiveJob(job); setPane("tasks"); setMessage("任务已进入队列"); await refresh();
    } finally { createLock.current = false; setCreating(false); }
  }
  async function openScene(id: string, kind?: string) { const manifest = await client.getManifest(id); if (activeReconstruction.current !== id) return; const artifactRow = kind ? manifest.artifacts.find((item) => item.kind === kind) : manifest.artifacts.find((item) => item.kind === "spz") ?? manifest.artifacts.find((item) => item.kind === "ply"); if (!artifactRow) throw new Error(kind ? `该重建没有 ${kind.toUpperCase()} 产物` : "该重建没有可查看的 SPZ 或 PLY 产物"); setArtifacts(manifest.artifacts); setViewerStatus(""); setScene({ reconstructionId: id, kind: artifactRow.kind }); }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); } catch { const area = document.createElement("textarea"); area.value = text; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); } setMessage("链接已复制"); }
  async function shareLink(text: string) {
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: "ReScene 场景", text: "查看 ReScene 三维场景", url: text }); return; }
      catch (error) { if (error instanceof DOMException && error.name === "AbortError") return; }
    }
    await copy(text);
  }
  async function refreshArtifacts(id: string) { const manifest = await client.getManifest(id); if (activeReconstruction.current === id) setArtifacts(manifest.artifacts); }
  async function loadEarlierLogs() {
    const jobId = latest?.id;
    const first = logs[0];
    if (!jobId || !first || earlierJob.current === jobId) return;
    const generation = logsGeneration.current;
    earlierJob.current = jobId;
    setLoadingEarlierJob(jobId);
    try {
      const older = await client.listJobLogs(jobId, { beforeId: first.id, limit: 200, level: logLevel || undefined });
      // A page for a job the user already left (or a reset log list) must never leak into the new task.
      if (jobId !== latestRef.current?.id || generation !== logsGeneration.current) return;
      if (older.length === 0) { setMessage("没有更早的日志"); return; }
      setLogs((current) => {
        const seen = new Set(current.map((line) => line.id));
        return [...older.filter((line) => !seen.has(line.id)), ...current];
      });
    } finally {
      if (earlierJob.current === jobId) earlierJob.current = "";
      setLoadingEarlierJob((current) => current === jobId ? "" : current);
    }
  }
  function trapDrawerFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!narrow || event.key !== "Tab") return;
    const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.closest("details:not([open])"));
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const artifact = scene && artifacts.find((item) => item.kind === scene.kind);
  const uploadBatch = uploadBatches[selected];
  const uploads = uploadBatch?.items ?? [];
  const uploading = uploadBatch?.busy ?? false;
  const derivedUnread = notifications.filter((item) => item.read_at === null).length;
  const unread = unreadCount ?? derivedUnread;
  const workerName = workerStatus?.workers.find((item) => item.online)?.gpu_name ?? "GPU Worker";

  if (!sessionReady) return <main className="login-shell solo"><section className="login-card"><div className="mark"><BrandMark size={30} /></div><p className="eyebrow">RESCENE</p><h1>正在恢复会话…</h1></section></main>;

  if (!token) return (
    <main className="login-shell">
      <div className="login-appearance"><ThemeControl /></div>
      <section className="login-hero">
        <div className="mark"><BrandMark size={30} /></div>
        <p className="eyebrow">RESCENE / SPATIAL RECONSTRUCTION</p>
        <h1>把影像，重建成可漫游的空间。</h1>
        <p>上传照片或视频，服务端调度 GPU 完成几何与 Gaussian 优化，结果在浏览器里直接浏览。</p>
      </section>
      <section className="login-card">
        <p className="eyebrow">RESCENE WORKBENCH</p>
        <div className="auth-tabs" role="tablist" aria-label="登录或注册">
          <button type="button" role="tab" disabled={authPending} aria-selected={authMode === "login"} className={authMode === "login" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("login"); setMessage(""); }}>登录</button>
          <button type="button" role="tab" disabled={authPending} aria-selected={authMode === "register"} className={authMode === "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("register"); setMessage(""); }}>注册</button>
        </div>
        {authMode === "login" ? (
          <form onSubmit={login}>
            <label>团队邮箱<input name="email" type="email" required autoComplete="email" /></label>
            <label>密码<input name="password" type={showPassword ? "text" : "password"} required autoComplete="current-password" /></label>
            <label className="password-toggle"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />显示密码</label>
            <button type="submit" disabled={authPending}>{authPending ? "正在登录…" : "进入工作台"}</button>
          </form>
        ) : (
          <form onSubmit={register}>
            <label>团队邮箱<input name="email" type="email" required autoComplete="email" /></label>
            <label>密码（至少 12 位）<input name="password" type={showPassword ? "text" : "password"} required minLength={12} autoComplete="new-password" /></label>
            <label>确认密码<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
            <button type="submit" disabled={authPending}>{authPending ? "正在注册…" : "创建账号"}</button>
          </form>
        )}
        {message && <p className="error" role="alert">{message}</p>}
        <p className="muted">{authMode === "login" ? "还没有账号？切换到注册即可创建。" : "注册后即可创建项目；密码至少 12 位。"}</p>
      </section>
    </main>
  );

  return (
    <main className={`shell${navOpen ? " nav-open" : ""}`}>
      <header className="mobile-bar" inert={narrow && navOpen}>
        <button ref={navToggleRef} className="nav-toggle" type="button" aria-label="打开导航" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>☰</button>
        <span className="mark"><BrandMark size={18} /></span>
        <strong>ReScene</strong>
        {unread > 0 && <span className="badge">{unread}</span>}
      </header>
      <button className="nav-backdrop" type="button" tabIndex={-1} aria-label="关闭导航" onClick={() => { navReturnFocus.current = "toggle"; setNavOpen(false); }} />
      <aside ref={asideRef} tabIndex={-1} inert={narrow && !navOpen} onKeyDown={trapDrawerFocus}>
        <div className="brand">
          <span className="mark"><BrandMark size={22} /></span>
          <strong>ReScene</strong>
        </div>
        <ThemeControl />
        <div className={`worker ${online ? "online" : ""}`}><i />{workerName} {online === true ? "在线" : online === false ? "离线" : "状态未知"}</div>
        <details
          className="notify"
          onToggle={(event) => {
            notifyOpen.current = event.currentTarget.open;
            // The badge poll only refreshes the count; pull the list when the user asks to see it.
            if (event.currentTarget.open) reloadNotifications();
          }}
        >
          <summary>通知{unread > 0 ? `（${unread}）` : ""}</summary>
          <div className="notify-tools">
            <button type="button" onClick={() => runAction(async () => { await client.markNotificationsRead(); await loadNotifications(); await loadUnread(); })}>全部已读</button>
            <div className="notify-filter" role="tablist" aria-label="通知筛选">
              <button type="button" role="tab" aria-selected={notifyFilter === "unread"} className={notifyFilter === "unread" ? "active" : ""} onClick={() => { setNotifyFilter("unread"); setNotifyOffset(0); void loadNotifications("unread", 0).catch((error: unknown) => setMessage(explainError(error, "无法加载通知"))); }}>未读</button>
              <button type="button" role="tab" aria-selected={notifyFilter === "all"} className={notifyFilter === "all" ? "active" : ""} onClick={() => { setNotifyFilter("all"); setNotifyOffset(0); void loadNotifications("all", 0).catch((error: unknown) => setMessage(explainError(error, "无法加载通知"))); }}>全部</button>
            </div>
          </div>
          {notifications.length === 0 ? <p className="muted">暂无通知</p> : (
            <ul>
              {notifications.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => runAction(async () => {
                    await client.markNotificationsRead([item.id]);
                    if (item.project_id) selectProject(item.project_id);
                    if (item.job_id) { selectJob(item.job_id); setPane("tasks"); }
                    setView("project");
                    setNavOpen(false);
                    await loadNotifications();
                    await loadUnread();
                  })}>
                    {item.kind === "announcement" && <small className="notify-kind">公告</small>}
                    <strong>{item.title}</strong>
                    <small>{new Date(item.created_at).toLocaleString()}</small>
                    {item.body && <small className="notify-body">{item.body}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notifyHasMore && (
            <button type="button" className="notify-more" disabled={notifyLoading} onClick={() => runAction(async () => { await loadNotifications(notifyFilter, notifyOffset + NOTIFY_PAGE_SIZE); })}>加载更多</button>
          )}
        </details>
        <form className="new-project" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; runAction(() => createProject(form)); }}>
          <input ref={projectNameRef} name="name" placeholder="新项目名称" aria-label="新项目名称" required />
          <button aria-label="创建项目" type="submit">＋</button>
        </form>
        <details>
          <summary>领取项目邀请</summary>
          <form onSubmit={(event) => void acceptInvitation(event)}>
            <label>领取码<input name="code" autoComplete="off" maxLength={128} required /></label>
            <button type="submit" disabled={acceptingInvitation}>{acceptingInvitation ? "正在领取…" : "领取邀请"}</button>
          </form>
        </details>
        <label>搜索项目<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <nav className="project-nav" aria-label="项目">
          {projects.filter((project) => project.name.toLowerCase().includes(search.toLowerCase())).map((project) => (
            <button className={selected === project.id ? "active" : ""} aria-current={selected === project.id ? "page" : undefined} key={project.id} onClick={() => selectProject(project.id)}>{project.name} · {project.effective_role}</button>
          ))}
        </nav>
        {me?.is_admin && (
          <button className="admin-entry" type="button" onClick={() => { setView("admin"); setNavOpen(false); }}>管理控制台</button>
        )}
        {me?.is_admin && (
          <details>
            <summary>创建账号</summary>
            <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); runAction(async () => { await client.createUser(String(data.get("email")), String(data.get("password")), data.get("admin") === "on"); form.reset(); setMessage("账号已创建"); }); }}>
              <label>邮箱<input name="email" type="email" required /></label>
              <label>初始密码（至少 12 位）<input name="password" type={showPassword ? "text" : "password"} minLength={12} required /></label>
              <label><input name="admin" type="checkbox" />管理员</label>
              <button>创建账号</button>
            </form>
          </details>
        )}
        <details className="account">
          <summary>账户</summary>
          <p>{me?.email}{me?.is_admin ? " · 管理员" : ""}</p>
          <form onSubmit={changePassword}>
            <label>当前密码<input name="current" type="password" required autoComplete="current-password" /></label>
            <label>新密码（至少 12 位）<input name="new" type="password" required minLength={12} autoComplete="new-password" /></label>
            <label>确认新密码<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
            <button type="submit">更新密码</button>
          </form>
        </details>
        <button className="signout" onClick={() => runAction(signOut)}>退出登录</button>
      </aside>
      <section className="workspace" inert={narrow && navOpen}>
        {view === "admin" ? (
          <AdminConsole client={client} onMessage={setMessage} />
        ) : (
          <>
            {!navigatorOnline && <p className="offline-banner" role="alert">网络已断开：恢复连接后可继续上传、查询任务和查看结果。</p>}
            {!detail ? (
              detailLoading ? (
                <div className="empty"><span>…</span><h2>正在加载项目…</h2></div>
              ) : detailError ? (
                <div className="empty" role="alert"><h2>无法打开项目</h2><p>{detailError}</p><button onClick={() => void refresh()}>重试加载</button><button onClick={() => selectProject("")}>返回项目列表</button></div>
              ) : !loaded ? (
                <div className="empty" role="status"><h2>正在加载项目…</h2></div>
              ) : libraryError ? (
                <div className="empty" role="alert"><h2>无法加载项目</h2><p>{libraryError}</p><button type="button" onClick={() => void refresh()}>重试</button></div>
              ) : (
                <section className="project-library">
                  <header><div><p className="eyebrow">工作空间</p><h1>我的项目</h1></div><span className="muted">{projects.length} 个项目</span></header>
                  <p className="muted">把拍摄素材整理成项目，重建并分享你的三维场景。</p>
                  {projects.length === 0 ? <div className="empty"><p>还没有项目。创建第一个项目开始上传素材。</p><button type="button" onClick={() => { if (narrow) setNavOpen(true); requestAnimationFrame(() => projectNameRef.current?.focus()); }}>创建项目</button></div> : null}
                  <div className="project-gallery">
                    {projects.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())).map((project) => <ProjectCard key={project.id} client={client} project={project} summary={project} onOpen={() => selectProject(project.id)} />)}
                  </div>
                </section>
              )
            ) : (
              <>
                <header className="project-header">
                  <div>
                    <button className="back-link" type="button" onClick={() => selectProject("")}>← 所有项目</button>
                    <h1 ref={projectHeadingRef} tabIndex={-1}>{detail.name}</h1>
                    <p className="project-summary">{detail.effective_role} · {detail.asset_count} 个素材 · {detail.job_count} 个任务</p>
                  </div>
                  <button type="button" onClick={() => void refresh()} disabled={detailLoading}>刷新</button>
                {canManage && (
                  <details>
                    <summary>项目设置</summary>
                    <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); runAction(async () => { const name = String(data.get("name")).trim(); if (!name) throw new Error("请输入项目名称"); await client.updateProject(selected, name); await refresh(); }); }}>
                      <label>项目名称<input name="name" defaultValue={detail.name} key={detail.id + detail.name} required /></label>
                      <button>重命名</button>
                    </form>
                    <button
                      disabled={detail.has_active_jobs}
                      title={detail.has_active_jobs ? "存在进行中的任务，需先取消" : undefined}
                      onClick={() => {
                        if (!window.confirm(`确定删除项目“${detail.name}”？此操作不可撤销。`)) return;
                        runAction(async () => { await client.deleteProject(selected); selectProject(""); setDetail(null); setProjects(await client.listProjectSummaries()); setMessage("项目已删除"); });
                      }}
                    >删除项目</button>
                    <details onToggle={(event) => { if (event.currentTarget.open) runAction(async () => { setAudit((await client.listProjectAudit(selected)).items); }); }}>
                      <summary>审计记录</summary>
                      <ol className="audit">
                        {audit.map((entry) => (
                          <li key={entry.id}>{new Date(entry.created_at).toLocaleString()} · {entry.actor_email ?? "系统"} · {entry.action}{entry.project_name ? ` · ${entry.project_name}` : ""}</li>
                        ))}
                      </ol>
                    </details>
                  </details>
                )}
                <details>
                  <summary>成员（{members.length}）</summary>
                  {members.map((member) => (
                    <div className="member-row" key={member.user_id}>
                      <span>{member.email}</span>
                      {member.role === "owner" ? <span>owner</span> : canManage ? (
                        <>
                          <select aria-label={`${member.email} 的角色`} value={member.role} onChange={(event) => { const role = event.target.value as MemberRole; runAction(async () => { await client.updateMemberRole(selected, member.user_id, role); setMembers(await client.listMembers(selected)); }); }}>
                            <option value="member">member</option>
                            <option value="viewer">viewer</option>
                          </select>
                          <button onClick={() => { if (window.confirm(`移除 ${member.email}？`)) runAction(async () => { await client.removeMember(selected, member.user_id); setMembers(await client.listMembers(selected)); }); }}>移除</button>
                        </>
                      ) : <span>{member.role}</span>}
                    </div>
                  ))}
                  {invitations.length > 0 && <p className="muted">待接受邀请（{invitations.length}）</p>}
                  {invitations.map((invite) => (
                    <div className="member-row" key={invite.id}>
                      <span>{invite.email}</span>
                      <span>{invite.role}</span>
                      <button type="button" onClick={() => runAction(async () => {
                        await client.revokeInvitation(selected, invite.id);
                        setIssuedInvitation((current) => current?.projectId === selected && current.email === invite.email ? null : current);
                        setInvitations(await client.listInvitations(selected));
                      })}>撤销</button>
                    </div>
                  ))}
                  {canManage && (
                    <form onSubmit={(event) => void issueInvitation(event)}>
                      <label>成员邮箱<input name="email" type="email" required /></label>
                      <label>角色<select name="role"><option value="member">member</option><option value="viewer">viewer</option></select></label>
                      <button type="submit" disabled={issuingInvitation}>{issuingInvitation ? "正在签发…" : "签发邀请"}</button>
                    </form>
                  )}
                  {canManage && issuedInvitation?.projectId === selected && (
                    <div role="status">
                      <p>请将领取码交给 {issuedInvitation.email}。领取码 7 天内有效，仅可使用一次。</p>
                      <label>新邀请领取码<input value={issuedInvitation.code} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
                    </div>
                  )}
                </details>
                </header>
                {staleRefresh && (
                  <div className="offline-banner" role="alert">
                    <strong>刷新失败：显示的是 {formatClock(detailFetchedAt ?? staleRefresh.at)} 的数据。</strong>{" "}
                    <span>{staleRefresh.message}</span>{" "}
                    <button type="button" onClick={() => void refresh()}>重试</button>
                    <button type="button" aria-label="关闭刷新提示" onClick={() => setStaleRefresh(null)}>×</button>
                  </div>
                )}
                {!canWrite && <p>只读访问：您可以查看素材、任务和结果。</p>}
                <nav className="workspace-panes" aria-label="项目工作区">
                  {PANES.map((item) => <button type="button" key={item.key} aria-pressed={pane === item.key} onClick={() => setPane(item.key)}>{item.label}</button>)}
                </nav>
                <div ref={workspaceGridRef} className={`grid workspace-grid pane-${pane}`} aria-busy={detailLoading}>
                  {pane === "materials" && <>
                  <section className="panel upload-panel">
                    <div className="panel-title"><h2>素材</h2>{canWrite && <small>已选 {selectedAssets.length} 个</small>}</div>
                    {canWrite && detail.assets.length > 0 ? <div className="selection-tools">
                      <button type="button" onClick={() => chooseAssets(detail.assets, true)}>全选本页图片</button>
                      <button type="button" disabled={!selectedAssets.length} onClick={() => setSelectedAssets([])}>清空选择</button>
                      <span aria-live="polite">{(selectionBytes(selectedAssets) / 1024 ** 2).toFixed(1)} MiB</span>
                    </div> : null}
                    {canWrite && (
                      <label className="dropzone">
                        <input type="file" multiple accept=".jpg,.jpeg,.png,.mp4,.mov,.mkv,.avi,.webm,.m4v" disabled={uploading} onChange={(event) => { void upload(event.target.files); event.currentTarget.value = ""; }} />
                        <strong>{uploading ? "上传中" : "选择图片或视频"}</strong>
                        <small>一组 JPG / PNG 图片或一个视频</small>
                        <small>单文件 ≤ 5 GiB，单任务 ≤ 8 GiB</small>
                      </label>
                    )}
                    {uploads.map((item, index) => (
                      <p key={`${index}-${item.name}`}>
                        {item.name} · {item.status} · {Math.round(item.progress)}%
                        {item.retryable ? <button disabled={uploading} onClick={() => runAction(() => retryUpload(index))}>重试上传</button> : null}
                      </p>
                    ))}
                    {detail.assets.length === 0 ? <p className="muted">暂无素材</p> : null}
                    <div className="assets">
                      {detail.assets.map((assetRow) => (
                        <div className="asset-row" key={assetRow.id}>
                          <AssetPreview client={client} id={assetRow.id} filename={assetRow.filename} ready={assetRow.status === "READY"} />
                          <label>
                            <input type="checkbox" disabled={!canWrite || assetRow.status !== "READY"} checked={selectedAssets.some((item) => item.id === assetRow.id)} onChange={() => chooseAssets([assetRow])} />
                            <span title={assetRow.filename}>{assetRow.filename}</span>
                            <small>{(assetRow.size / 1024 / 1024).toFixed(1)} MiB · {ASSET_STATUS_LABELS[assetRow.status]}</small>
                          </label>
                          {canWrite && <button type="button" aria-label={`删除 ${assetRow.filename}`} disabled={uploading} onClick={() => { if (!window.confirm(`删除素材「${assetRow.filename}」？`)) return; runAction(async () => { await client.deleteAsset(assetRow.id); setSelectedAssets((items) => items.filter((item) => item.id !== assetRow.id)); await refresh(); setMessage("素材已删除"); }); }}>删除</button>}
                        </div>
                      ))}
                    </div>
                    <PageControls label="素材" page={assetPages.length} next={detail.nextAssetCursor} busy={detailLoading} onChange={(cursor) => changePage("assets", cursor)} />
                  </section>
                  {canWrite && <section ref={materialActionsRef} className="panel material-actions route-panel">
                    <div className="panel-title"><h2>重建路线</h2><span>已选 {selectedAssets.length} 个 · {(selectionBytes(selectedAssets) / 1024 ** 2).toFixed(1)} MiB</span></div>
                    <div className="profiles" role="group" aria-label="重建路线">
                      {PROFILES.map((value) => {
                        const option = RECONSTRUCTION_PROFILES[value];
                        return (
                          <button type="button" disabled={!canWrite} aria-pressed={profile === value} className={profile === value ? "active" : ""} key={value} onClick={() => setProfile(value)}>
                            <strong>{option.title}</strong><span>{value.toUpperCase()} · ≤ {option.frames} 帧</span>
                            <small>{option.description}</small>
                          </button>
                        );
                      })}
                    </div>
                    <button className="primary" disabled={creating || uploading || !selectedAssets.length} onClick={() => { setMaterialError(""); void createJob().catch((error: unknown) => { if (error instanceof ResceneApiError && error.status === 401) expire(); else setMaterialError(explainError(error, "操作失败")); }); }}>{creating ? "正在创建…" : "开始三维重建"}</button>
                    <p className="muted route-note">{selectedAssets.length ? `已选 ${selectedAssets.length} 个素材` : "在素材列表中勾选要重建的文件"}{workerStatus && !online ? " · 计算节点离线，提交后排队" : ""}</p>
                    {materialError && <p className="error" role="alert">{materialError}</p>}
                  </section>}
                  </>}
                  {pane !== "materials" && <section className="panel status-panel">
                    <div className="panel-title"><h2>{pane === "results" ? "重建结果" : "重建任务"}</h2></div>
                    {detail.jobs.length > 0 && (
                      <label>任务记录<select value={latest?.id ?? ""} onChange={(event) => selectJob(event.target.value)}>{(latest && !detail.jobs.some((job) => job.id === latest.id) ? [latest, ...detail.jobs] : detail.jobs).map((job) => <option key={job.id} value={job.id}>{RECONSTRUCTION_PROFILES[job.profile].title} · {JOB_STATUS_LABELS[job.status]} · {job.id.slice(0, 8)}</option>)}</select></label>
                    )}
                    <PageControls label="任务" page={jobPages.length} next={detail.nextJobCursor} busy={detailLoading} onChange={(cursor) => changePage("jobs", cursor)} />
                    {latest ? (
                      <>
                        {pane === "tasks" && <div className="task-detail">
                        <div className="job-head"><strong className="job-state" data-status={latest.status}>{JOB_STATUS_LABELS[latest.status]}{latest.cancel_requested ? " · 已请求取消" : ""}</strong><small>{stageLabel(latest.current_stage)}</small></div>
                        <div className="bar" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(latest.progress * 100)}><i style={{ width: `${Math.round(latest.progress * 100)}%` }} /></div>
                        <p>{Math.round(latest.progress * 100)}% · {RECONSTRUCTION_PROFILES[latest.profile].title}{latest.attempt > 0 ? ` · 第 ${latest.attempt} 次尝试` : ""}</p>
                        {latest.status === "QUEUED" ? <p className="muted">{queuedJobHint(online)}</p> : null}
                        {(latest.error_code || latest.error_message) && <p className="error" role="status">{jobErrorHint(latest.error_code) || latest.error_message || latest.error_code}</p>}
                        {timeline.length > 0 && (
                          <details>
                            <summary>阶段记录</summary>
                            <ol className="timeline">
                              {timeline.map((row) => (
                                <li key={row.key}><strong>{stageLabel(row.stage)}</strong><small>{row.status} · {Math.round(row.progress * 100)}%{row.message ? ` · ${row.message}` : ""}</small>{Object.keys(row.metrics).length > 0 && <code>{JSON.stringify(row.metrics)}</code>}</li>
                              ))}
                            </ol>
                          </details>
                        )}
                        <details>
                          <summary>运行日志（{logs.length}）</summary>
                          <label>级别<select value={logLevel} onChange={(event) => setLogLevel(event.target.value as LogLevel)}><option value="">全部</option><option value="info">信息</option><option value="warning">警告</option><option value="error">错误</option></select></label>
                          {logs.length === 0 ? <p className="muted">{logsLoading ? "正在加载运行日志…" : "暂无运行日志"}</p> : (
                            <ol className="log-list">
                              {logs.map((line) => (
                                <li key={line.id} data-level={line.level.toLowerCase()}><code className="log-line">{new Date(line.created_at).toLocaleTimeString()} · {line.level.toUpperCase()} · {line.message}</code></li>
                              ))}
                            </ol>
                          )}
                          {logs.length > 0 && <button disabled={loadingEarlierJob === latest.id} onClick={() => runAction(loadEarlierLogs)}>{loadingEarlierJob === latest.id ? "正在加载…" : "加载更早"}</button>}
                        </details>
                        {canWrite && ACTIVE[latest.status] && <button className="task-action" disabled={latest.cancel_requested} onClick={() => runAction(async () => { setLiveJob(await client.cancelJob(latest.id)); await refresh(); })}>取消任务</button>}
                        {canWrite && latest.error_code === "INVALID_INPUT" && <button className="task-action" onClick={() => setPane("materials")}>更换素材</button>}
                        {canWrite && canRetryJob(latest) && <button className="task-action" onClick={() => runAction(async () => { setLiveJob(await client.retryJob(latest.id)); await refresh(); })}>重试任务</button>}
                        {reconstructionId && <button className="task-action" onClick={() => setPane("results")}>查看结果</button>}
                        </div>}
                        {pane === "results" && (reconstructionId ? (
                          <div className="result-actions result-panel">
                            <div className="scene-tools" role="group" aria-label="场景操作">
                              <button className="primary" onClick={() => runAction(() => openScene(reconstructionId))}>打开 Viewer</button>
                              {artifacts.some((item) => item.kind === "ply") ? <button onClick={() => runAction(() => openScene(reconstructionId, "ply"))}>打开 PLY 场景</button> : null}
                              <button onClick={() => runAction(() => copy(`${webBaseUrl.replace(/\/$/, "")}/viewer?reconstruction=${encodeURIComponent(reconstructionId)}`))}>复制 Viewer 链接</button>
                            </div>
                            <section className="result-downloads" aria-label="产物下载">
                              <div className="download-heading">
                                <h3>产物下载</h3>
                                <button onClick={() => runAction(() => refreshArtifacts(reconstructionId))}>刷新产物链接</button>
                              </div>
                              <ul className="artifact-list">
                                {artifacts.map((item) => (
                                  <li key={item.kind}>
                                    <div className="artifact-meta">
                                      <strong>{item.kind.toUpperCase()}</strong>
                                      {item.size != null && <small>{formatArtifactSize(item.size)}</small>}
                                    </div>
                                    <a href={item.url} aria-label={`${item.kind.toUpperCase()} 下载`} target="_blank" rel="noreferrer" download>下载</a>
                                  </li>
                                ))}
                              </ul>
                              {artifacts.some((item) => item.sha256) && <details>
                                <summary>校验值（SHA-256）</summary>
                                <dl className="artifact-digests">
                                  {artifacts.filter((item) => item.sha256).map((item) => (
                                    <div key={item.kind}><dt>{item.kind.toUpperCase()}</dt><dd><code>{item.sha256}</code></dd></div>
                                  ))}
                                </dl>
                              </details>}
                            </section>
                            {canWrite && (
                              <details className="result-sharing">
                                <summary>管理分享</summary>
                                <div className="share-tools">
                                <label>到期<select value={sharePreset} onChange={(event) => setSharePreset(event.target.value as SharePreset)}>{SHARE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></label>
                                <button onClick={() => runShareAction(reconstructionId, async () => {
                                  const id = reconstructionId;
                                  const preset = SHARE_PRESETS.find((item) => item.value === sharePreset);
                                  const expiresAt = preset?.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
                                  const share = await client.createShare(id, expiresAt);
                                  if (activeReconstruction.current !== id) return;
                                  setCreatedShare({ reconstructionId: id, link: `${webBaseUrl.replace(/\/$/, "")}/share/${encodeURIComponent(share.token)}`, token: share.token });
                                  await loadShares(id);
                                })}>创建分享</button>
                                </div>
                                {activeCreatedShare && (
                                  <div className="created-share">
                                    <label>新分享链接<input readOnly value={activeCreatedShare.link} /></label>
                                    <div className="share-tools">
                                      <button onClick={() => runAction(() => copy(activeCreatedShare.link))}>复制分享链接</button>
                                      {typeof navigator !== "undefined" && typeof navigator.share === "function" ? <button onClick={() => runAction(() => shareLink(activeCreatedShare.link))}>系统分享</button> : null}
                                    </div>
                                  </div>
                                )}
                                {activeCreatedShare && <img className="qr" alt="分享二维码" width={160} height={160} src={client.shareQrUrl(activeCreatedShare.token)} />}
                                <ul className="artifact-list">
                                  {shares.filter((share) => !share.revoked_at).map((share) => (
                                  <li key={share.id}>
                                    <div className="artifact-meta"><strong>{share.id.slice(0, 8)}</strong><small>{share.expires_at ? `到期 ${new Date(share.expires_at).toLocaleString()}` : "永不过期"}</small></div>
                                      <button onClick={() => { if (!window.confirm("撤销该分享链接？")) return; runShareAction(reconstructionId, async () => { const id = reconstructionId; await client.revokeShare(share.id); if (activeReconstruction.current !== id) return; setCreatedShare(null); await loadShares(id); }); }}>撤销</button>
                                  </li>
                                  ))}
                                </ul>
                                {shares.some((share) => share.revoked_at) && <details className="revoked-shares">
                                  <summary>已撤销的链接</summary>
                                  <ul>{shares.map((share) => share.revoked_at ? (
                                    <li key={share.id}>{share.id.slice(0, 8)} · {new Date(share.revoked_at).toLocaleString()}</li>
                                  ) : null)}</ul>
                                </details>}
                              </details>
                            )}
                          </div>
                        ) : <p className="result-panel muted">任务完成后可在这里查看和下载结果</p>)}
                      </>
                    ) : pane === "tasks" ? <p className="muted">还没有任务。选择素材和路线后开始重建。</p> : <p className="result-panel muted">任务完成后可在这里查看和下载结果</p>}
                  </section>}
                </div>
                {scene && artifact && (
                  <dialog ref={sceneDialog} className="scene" aria-label="场景查看器" onCancel={(event) => { event.preventDefault(); setScene(null); }}>
                    <Viewer
                      src={artifact.url}
                      artifactKind={artifact.kind}
                      reconstructionId={scene.reconstructionId}
                      sha256={artifact.sha256 ?? undefined}
                      size={artifact.size ?? undefined}
                      onStatus={(status, statusDetail) => setViewerStatus(statusDetail ?? (status === "ready" ? "" : status === "loading" ? "正在加载场景" : "场景加载失败"))}
                      onRetry={() => runAction(() => openScene(scene.reconstructionId, scene.kind))}
                    />
                    <div className="scene-actions">
                      <a href={artifact.url} download target="_blank" rel="noreferrer">下载 {artifact.kind.toUpperCase()}</a>
                      <button autoFocus onClick={() => setScene(null)}>关闭查看器</button>
                    </div>
                    {viewerStatus ? <span className="viewer-status" role="status">{viewerStatus}</span> : null}
                  </dialog>
                )}
              </>
            )}
          </>
        )}
        {message && <div className="toast" role="status">{message} <button aria-label="关闭通知" onClick={() => setMessage("")}>×</button></div>}
      </section>
    </main>
  );
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function PageControls({ label, page, next, busy, onChange }: {
  label: string; page: number; next: string | null; busy: boolean; onChange: (cursor?: string) => void;
}) {
  if (page === 1 && !next) return null;
  return <nav className="page-controls" aria-label={`${label}分页`}>
    <button type="button" disabled={busy || page === 1} onClick={() => onChange()}>上一页</button>
    <span aria-live="polite">第 {page} 页</span>
    <button type="button" disabled={busy || !next} onClick={() => { if (next) onChange(next); }}>下一页</button>
  </nav>;
}
