"use client";

import { ResceneApiError, explainError, type JobEvent, type ResceneClient } from "@rescene/api-client";
import type {
  AppNotification,
  Artifact,
  AuditEntry,
  Job,
  JobLog,
  JobStage,
  MemberRole,
  Profile,
  Project,
  ProjectDetail,
  ProjectInvitation,
  ProjectMember,
  ShareSummary,
  User,
  WorkerStatus,
} from "@rescene/schemas";
import type { UploadAdapter } from "@rescene/uploader";
import { type ComponentType, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminConsole } from "./AdminConsole";
import { BrandMark } from "./BrandMark";

export type KeyValueStore = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
export type WorkbenchViewerProps = { src: string; artifactKind?: string; reconstructionId?: string; sha256?: string; size?: number; onStatus?: (status: "loading" | "ready" | "error", detail?: string) => void; onRetry?: () => void };
export type WorkbenchProps = { client: ResceneClient; uploader: UploadAdapter; viewer: ComponentType<WorkbenchViewerProps>; tokenStore: KeyValueStore; webBaseUrl: string };

const TOKEN_KEY = "rescene-token";
const PROJECT_KEY = "rescene-project";
const JOB_KEY = "rescene-job";
const ACTIVE: Record<string, boolean> = { QUEUED: true, LEASED: true, RUNNING: true };
const VIDEO_FILE = /\.(mp4|mov|mkv|avi|webm|m4v)$/i;
const PROFILES: [Profile, string, string][] = [["fast", "FAST", "快速预览 · 7k"], ["balanced", "BALANCED", "推荐 · BA + 20k"], ["quality", "QUALITY", "COLMAP · 精细重建"]];
const NOTIFY_PAGE_SIZE = 20;
type UploadItem = { name: string; progress: number; status: string; file?: File; projectId?: string; retryable?: boolean };
type TimelineRow = { key: string; stage: string; status: string; progress: number; message?: string | null; metrics: Record<string, unknown> };
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [online, setOnline] = useState(false);
  const [search, setSearch] = useState("");
  const [profile, setProfile] = useState<Profile>("balanced");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [scene, setScene] = useState<{ reconstructionId: string; kind: string } | null>(null);
  const [viewerStatus, setViewerStatus] = useState("");
  const [createdLink, setCreatedLink] = useState("");
  const [createdShareToken, setCreatedShareToken] = useState("");
  const [sharePreset, setSharePreset] = useState<SharePreset>("7d");
  const [message, setMessage] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [navigatorOnline, setNavigatorOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"project" | "admin">("project");
  const [navOpen, setNavOpen] = useState(false);
  const [notifyFilter, setNotifyFilter] = useState<NotifyFilter>("all");
  const [notifyOffset, setNotifyOffset] = useState(0);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyHasMore, setNotifyHasMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const notifyFilterRef = useRef<NotifyFilter>(notifyFilter);
  notifyFilterRef.current = notifyFilter;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const detailRef = useRef(detail);
  detailRef.current = detail;
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
    if (!scene) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setScene(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [scene]);
  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);

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
  const loadNotifications = useCallback(async (filter: NotifyFilter = notifyFilterRef.current, offset = 0): Promise<AppNotification[]> => {
    setNotifyLoading(true);
    try {
      const list = await client.listNotifications(filter === "unread", NOTIFY_PAGE_SIZE, offset);
      setNotifications((current) => (offset > 0 ? [...current, ...list] : list));
      setNotifyOffset(offset);
      setNotifyHasMore(list.length >= NOTIFY_PAGE_SIZE);
      return list;
    } finally {
      setNotifyLoading(false);
    }
  }, [client]);
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
    try {
      const [user, list, worker] = await Promise.all([client.getMe(), client.listProjects(), client.getWorkerStatus()]);
      setMe(user); setProjects(list); setOnline(worker.online); setWorkerStatus(worker); setLoaded(true);
      await loadNotifications();
      void loadUnread();
      if (selected) {
        if (!detailRef.current) setDetailLoading(true);
        try {
          const project = await client.getProject(selected);
          if (selectedRef.current === selected) {
            setDetail(project);
            setDetailError("");
          }
        } catch (error) {
          if (error instanceof ResceneApiError && error.status === 401) throw error;
          if (selectedRef.current === selected) {
            setDetailError(error instanceof ResceneApiError && error.status === 403
              ? "当前账号无权访问该项目。"
              : error instanceof Error ? error.message : "无法加载项目。");
          }
        } finally {
          setDetailLoading(false);
        }
      }
    } catch (error) {
      setLoaded(true);
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(error instanceof Error ? error.message : "请求失败，请重试");
    }
  }, [client, expire, loadNotifications, loadUnread, selected, token]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
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
    setSelectedAssets([]); setSelectedJob(""); setDetail(null); setLiveJob(null); setScene(null); setArtifacts([]); setMembers([]); setShares([]); setCreatedLink(""); setCreatedShareToken(""); setTimeline([]); setUploads([]); setInvitations([]); setAudit([]);
  }, [selected]);
  const latest = useMemo(() => liveJob?.id === selectedJob ? liveJob : detail?.jobs.find((job) => job.id === selectedJob) ?? detail?.jobs[0], [detail, liveJob, selectedJob]);
  const reconstructionId = latest?.reconstruction_id ?? "";
  const activeReconstruction = useRef(reconstructionId);
  activeReconstruction.current = reconstructionId;
  useEffect(() => { setScene(null); setArtifacts([]); }, [reconstructionId]);
  const canManage = detail?.effective_role === "owner" || detail?.effective_role === "admin";
  const canWrite = canManage || detail?.effective_role === "member";
  useEffect(() => {
    if (!token || !latest?.id) return;
    const id = latest.id;
    return client.subscribeJob(id, (event: JobEvent) => {
      if ("stage" in event) {
        const row: TimelineRow = { key: `live-${Date.now()}-${event.stage}`, stage: event.stage, status: event.status, progress: event.progress, message: event.message, metrics: event.metrics };
        setTimeline((rows) => [...rows, row].slice(-100));
        setLiveJob((job) => job?.id === id ? { ...job, progress: event.progress, current_stage: event.stage } : job);
      }
      else { setLiveJob(event); if (!ACTIVE[event.status]) void refresh(); }
    }, (error) => {
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(`进度流中断：${error.message}`);
    });
  }, [client, expire, latest?.id, refresh, token]);
  useEffect(() => {
    const id = latest?.id;
    if (!id) { setTimeline([]); return; }
    let cancelled = false;
    void client.getJobStages(id).then((rows: JobStage[]) => {
      if (cancelled) return;
      setTimeline(rows.map((row) => ({ key: row.id, stage: row.stage, status: row.status, progress: row.progress, message: row.message, metrics: row.metrics })));
    }).catch((error: unknown) => { if (!cancelled) setMessage(explainError(error, "无法加载阶段记录")); });
    return () => { cancelled = true; };
  }, [client, latest?.id]);
  useEffect(() => {
    const id = latest?.id;
    const status = latest?.status ?? "";
    const level = logLevel || undefined;
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
  const loadShares = useCallback(async (id: string) => { setShares(await client.listShares(id)); }, [client]);
  useEffect(() => {
    setShares([]); setCreatedLink("");
    if (!reconstructionId) return;
    let cancelled = false;
    const fail = (error: unknown, fallback: string) => {
      if (cancelled) return;
      if (error instanceof ResceneApiError && error.status === 401) expire();
      else setMessage(error instanceof Error ? error.message : fallback);
    };
    void client.getManifest(reconstructionId).then((manifest) => { if (!cancelled) setArtifacts(manifest.artifacts); }).catch((error: unknown) => fail(error, "无法加载产物"));
    if (canWrite) void loadShares(reconstructionId).catch((error: unknown) => fail(error, "无法加载分享"));
    return () => { cancelled = true; };
  }, [canWrite, client, expire, loadShares, reconstructionId]);
  function runAction(action: () => Promise<void>) { void action().catch((error: unknown) => { if (error instanceof ResceneApiError && error.status === 401) expire(); else setMessage(explainError(error, "操作失败")); }); }
  function selectProject(id: string) {
    setView("project");
    setNavOpen(false);
    setSelected(id);
    setSelectedJob("");
    setDetail(null);
    setDetailError("");
    tokenStore.remove(JOB_KEY);
    if (id) tokenStore.set(PROJECT_KEY, id);
    else tokenStore.remove(PROJECT_KEY);
  }
  function selectJob(id: string) { setSelectedJob(id); tokenStore.set(JOB_KEY, id); setLiveJob(null); setScene(null); setArtifacts([]); setTimeline([]); }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await client.login(String(form.get("email") ?? "").trim(), String(form.get("password") ?? ""));
      tokenStore.set(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setMessage("");
    } catch (error) {
      if (error instanceof ResceneApiError && (error.status === 401 || error.status === 403)) setMessage("邮箱或密码不正确。");
      else setMessage(error instanceof Error ? error.message : "登录失败");
    }
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
    }
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
  async function createProject(form: HTMLFormElement) { const name = String(new FormData(form).get("name") ?? "").trim(); if (!name) throw new Error("请输入项目名称"); const project = await client.createProject(name); form.reset(); selectProject(project.id); await refresh(); }
  async function transfer(file: File, index: number, projectId: string) {
    setUploads((items) => items.map((item, n) => n === index ? { ...item, status: "上传中", retryable: false } : item));
    try {
      await uploader.upload({ projectId, file }, (progress) => setUploads((items) => items.map((item, n) => n === index ? { ...item, progress, status: "上传中" } : item)));
      setUploads((items) => items.map((item, n) => n === index ? { ...item, progress: 100, status: "完成" } : item));
    } catch (error) {
      setUploads((items) => items.map((item, n) => n === index ? { ...item, status: `失败：${error instanceof Error ? error.message : "上传失败"}`, retryable: true } : item));
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !selected || uploading || !canWrite) return;
    const list = Array.from(files);
    setUploading(true);
    setUploads(list.map((file) => ({ name: file.name, progress: 0, status: "等待上传", file, projectId: selected })));
    try {
      for (let index = 0; index < list.length; index++) await transfer(list[index], index, selected);
      await refresh();
    } finally {
      setUploading(false);
    }
  }
  async function retryUpload(index: number) {
    const item = uploads[index];
    if (!item?.file || !item.projectId || uploading) return;
    setUploading(true);
    try {
      await transfer(item.file, index, item.projectId);
      await refresh();
    } finally {
      setUploading(false);
    }
  }
  async function createJob() {
    if (createLock.current || !selected || !canWrite) return;
    if (!selectedAssets.length) throw new Error("请先选择至少一个素材");
    const chosen = detail?.assets.filter((asset) => selectedAssets.includes(asset.id)) ?? [];
    if (chosen.length !== selectedAssets.length || chosen.some((asset) => asset.status !== "READY")) throw new Error("只能选择 READY 状态的素材");
    if (chosen.some((asset) => VIDEO_FILE.test(asset.filename)) && chosen.some((asset) => !VIDEO_FILE.test(asset.filename))) throw new Error("图片和视频不能混合重建");
    createLock.current = true; setCreating(true);
    try { const job = await client.createJob(selected, profile, selectedAssets); selectJob(job.id); setLiveJob(job); setMessage("任务已进入队列"); await refresh(); } finally { createLock.current = false; setCreating(false); }
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
    const id = latest?.id;
    const first = logs[0];
    if (!id || !first) return;
    const older = await client.listJobLogs(id, { beforeId: first.id, limit: 200, level: logLevel || undefined });
    if (older.length === 0) { setMessage("没有更早的日志"); return; }
    setLogs((current) => {
      const seen = new Set(current.map((line) => line.id));
      return [...older.filter((line) => !seen.has(line.id)), ...current];
    });
  }
  const artifact = scene && artifacts.find((item) => item.kind === scene.kind);
  const derivedUnread = notifications.filter((item) => item.read_at === null).length;
  const unread = unreadCount ?? derivedUnread;
  const workerName = workerStatus?.workers.find((item) => item.online)?.gpu_name ?? "GPU Worker";

  if (!sessionReady) return <main className="login-shell solo"><section className="login-card"><div className="mark"><BrandMark size={30} /></div><p className="eyebrow">RESCENE</p><h1>正在恢复会话…</h1></section></main>;

  if (!token) return (
    <main className="login-shell">
      <section className="login-hero">
        <div className="mark"><BrandMark size={30} /></div>
        <p className="eyebrow">RESCENE / SPATIAL RECONSTRUCTION</p>
        <h1>把影像，重建成可漫游的空间。</h1>
        <p>上传照片或视频，服务端调度 GPU 完成几何与 Gaussian 优化，结果在浏览器里直接浏览。</p>
      </section>
      <section className="login-card">
        <p className="eyebrow">RESCENE WORKBENCH</p>
        <div className="auth-tabs" role="tablist" aria-label="登录或注册">
          <button type="button" role="tab" aria-selected={authMode === "login"} className={authMode === "login" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("login"); setMessage(""); }}>登录</button>
          <button type="button" role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("register"); setMessage(""); }}>注册</button>
        </div>
        {authMode === "login" ? (
          <form onSubmit={login}>
            <label>团队邮箱<input name="email" type="email" required autoComplete="email" /></label>
            <label>密码<input name="password" type="password" required autoComplete="current-password" /></label>
            <button type="submit">进入工作台</button>
          </form>
        ) : (
          <form onSubmit={register}>
            <label>团队邮箱<input name="email" type="email" required autoComplete="email" /></label>
            <label>密码（至少 12 位）<input name="password" type="password" required minLength={12} autoComplete="new-password" /></label>
            <label>确认密码<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
            <button type="submit">创建账号</button>
          </form>
        )}
        {message && <p className="error" role="alert">{message}</p>}
        <p className="muted">{authMode === "login" ? "还没有账号？切换到注册即可创建。" : "注册后即可创建项目；密码至少 12 位。"}</p>
      </section>
    </main>
  );

  return (
    <main className={`shell${navOpen ? " nav-open" : ""}`}>
      <header className="mobile-bar">
        <button className="nav-toggle" type="button" aria-label="打开导航" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>☰</button>
        <span className="mark"><BrandMark size={18} /></span>
        <strong>ReScene</strong>
        {unread > 0 && <span className="badge">{unread}</span>}
      </header>
      <button className="nav-backdrop" type="button" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
      <aside>
        <div className="brand">
          <span className="mark"><BrandMark size={22} /></span>
          <strong>ReScene</strong>
        </div>
        <div className={`worker ${online ? "online" : ""}`}><i />{workerName} {online ? "在线" : "离线 / 任务将在 Worker 上线后执行"}</div>
        <details className="notify">
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
                    if (item.job_id) selectJob(item.job_id);
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
        <p>{me?.email}{me?.is_admin ? " · 管理员" : ""}</p>
        <form className="new-project" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; runAction(() => createProject(form)); }}>
          <input name="name" placeholder="新项目名称" aria-label="新项目名称" required />
          <button aria-label="创建项目" type="submit">＋</button>
        </form>
        <label>搜索项目<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <nav aria-label="项目">
          {projects.filter((project) => project.name.toLowerCase().includes(search.toLowerCase())).map((project) => (
            <button className={selected === project.id ? "active" : ""} key={project.id} onClick={() => selectProject(project.id)}>{project.name} · {project.effective_role}</button>
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
              <label>初始密码（至少 12 位）<input name="password" type="password" minLength={12} required /></label>
              <label><input name="admin" type="checkbox" />管理员</label>
              <button>创建账号</button>
            </form>
          </details>
        )}
        <details className="account">
          <summary>账户</summary>
          <form onSubmit={changePassword}>
            <label>当前密码<input name="current" type="password" required autoComplete="current-password" /></label>
            <label>新密码（至少 12 位）<input name="new" type="password" required minLength={12} autoComplete="new-password" /></label>
            <label>确认新密码<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
            <button type="submit">更新密码</button>
          </form>
        </details>
        <button className="signout" onClick={() => runAction(signOut)}>退出登录</button>
      </aside>
      <section className="workspace">
        {view === "admin" ? (
          <AdminConsole client={client} onMessage={setMessage} />
        ) : (
          <>
            {!navigatorOnline && <p className="offline-banner" role="alert">网络已断开：恢复连接后可继续上传、查询任务和查看结果。</p>}
            {!detail ? (
              detailLoading ? (
                <div className="empty"><span>…</span><h2>正在加载项目…</h2></div>
              ) : detailError ? (
                <div className="empty" role="alert"><span>!</span><h2>无法打开项目</h2><p>{detailError}</p><button onClick={() => selectProject("")}>返回项目列表</button></div>
              ) : !loaded ? (
                <div className="empty"><span>…</span><h2>正在加载工作台…</h2></div>
              ) : (
                <div className="empty"><span>01</span><h2>选择或创建一个项目</h2><p>上传环绕目标拍摄的图片或视频，选择算法路线后开始重建。</p></div>
              )
            ) : (
              <>
                <header>
                  <div>
                    <p className="eyebrow">PROJECT / {detail.id.slice(0, 8)} · {detail.effective_role}</p>
                    <h1>{detail.name}</h1>
                  </div>
                  <div className="count">{detail.assets.length}<small>个素材</small></div>
                </header>
                {!canWrite && <p>只读访问：您可以查看素材、任务和结果。</p>}
                {canManage && (
                  <details>
                    <summary>项目设置</summary>
                    <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); runAction(async () => { const name = String(data.get("name")).trim(); if (!name) throw new Error("请输入项目名称"); await client.updateProject(selected, name); await refresh(); }); }}>
                      <label>项目名称<input name="name" defaultValue={detail.name} key={detail.id + detail.name} required /></label>
                      <button>重命名</button>
                    </form>
                    <button
                      disabled={detail.jobs.some((job) => ACTIVE[job.status])}
                      title={detail.jobs.some((job) => ACTIVE[job.status]) ? "存在进行中的任务，需先取消" : undefined}
                      onClick={() => {
                        if (!window.confirm(`确定删除项目“${detail.name}”？此操作不可撤销。`)) return;
                        runAction(async () => { await client.deleteProject(selected); selectProject(""); setDetail(null); setProjects(await client.listProjects()); setMessage("项目已删除"); });
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
                      <button type="button" onClick={() => runAction(async () => { await client.revokeInvitation(selected, invite.id); setInvitations(await client.listInvitations(selected)); })}>撤销</button>
                    </div>
                  ))}
                  {canManage && (
                    <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); runAction(async () => { const result = await client.addMember(selected, String(data.get("email")), data.get("role") as MemberRole); form.reset(); if (result.status === "invited") { setMessage(`已邀请 ${result.email}，对方注册后自动加入。`); setInvitations(await client.listInvitations(selected)); } else setMembers(await client.listMembers(selected)); }); }}>
                      <label>成员邮箱<input name="email" type="email" required /></label>
                      <label>角色<select name="role"><option value="member">member</option><option value="viewer">viewer</option></select></label>
                      <button>添加成员</button>
                    </form>
                  )}
                </details>
                <div className="grid">
                  <section className="panel upload-panel">
                    <div className="panel-title"><span>01</span><h2>素材</h2></div>
                    {canWrite && (
                      <label className="dropzone">
                        <input type="file" multiple accept=".jpg,.jpeg,.png,.mp4,.mov,.mkv,.avi,.webm,.m4v" disabled={uploading} onChange={(event) => { void upload(event.target.files); event.currentTarget.value = ""; }} />
                        <strong>{uploading ? "上传中" : "选择图片或视频"}</strong>
                        <small>JPG · PNG · MP4 · MOV · MKV · AVI · WEBM · M4V / 单文件 ≤5 GiB，任务合计 ≤8 GiB / 浏览器直传 OSS</small>
                      </label>
                    )}
                    {uploads.map((item, index) => (
                      <p key={`${index}-${item.name}`}>
                        {item.name} · {item.status} · {Math.round(item.progress)}%
                        {item.retryable ? <button disabled={uploading} onClick={() => runAction(() => retryUpload(index))}>重试上传</button> : null}
                      </p>
                    ))}
                    <div className="assets">
                      {detail.assets.map((assetRow) => (
                        <label key={assetRow.id}>
                          <input type="checkbox" disabled={!canWrite || assetRow.status !== "READY"} checked={selectedAssets.includes(assetRow.id)} onChange={() => setSelectedAssets((items) => items.includes(assetRow.id) ? items.filter((id) => id !== assetRow.id) : [...items, assetRow.id])} />
                          <span>{assetRow.filename}</span>
                          <small>{(assetRow.size / 1024 / 1024).toFixed(1)} MB · {assetRow.status}</small>
                          <button type="button" aria-label={`删除 ${assetRow.filename}`} disabled={!canWrite || uploading} onClick={() => { if (!window.confirm(`删除素材「${assetRow.filename}」？`)) return; runAction(async () => { await client.deleteAsset(assetRow.id); setSelectedAssets((ids) => ids.filter((id) => id !== assetRow.id)); await refresh(); setMessage("素材已删除"); }); }}>删除</button>
                        </label>
                      ))}
                    </div>
                  </section>
                  <section className="panel route-panel">
                    <div className="panel-title"><span>02</span><h2>路线</h2></div>
                    <div className="profiles">
                      {PROFILES.map(([value, title, note]) => (
                        <button disabled={!canWrite} className={profile === value ? "active" : ""} key={value} onClick={() => setProfile(value)}><strong>{title}</strong><small>{note}</small></button>
                      ))}
                    </div>
                    {canWrite && <button className="primary" disabled={creating || uploading} onClick={() => runAction(createJob)}>{creating ? "正在创建…" : "开始三维重建"}</button>}
                  </section>
                  <section className="panel status-panel">
                    <div className="panel-title"><span>03</span><h2>任务</h2></div>
                    {detail.jobs.length > 0 && (
                      <label>任务记录<select value={latest?.id ?? ""} onChange={(event) => selectJob(event.target.value)}>{detail.jobs.map((job) => <option key={job.id} value={job.id}>{job.profile.toUpperCase()} · {job.status} · {job.id.slice(0, 8)}</option>)}</select></label>
                    )}
                    {latest ? (
                      <>
                        <div className="job-head"><strong>{latest.status}{latest.cancel_requested ? " · 已请求取消" : ""}</strong><small>{latest.current_stage ?? "等待 Worker"}</small></div>
                        <div className="bar" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(latest.progress * 100)}><i style={{ width: `${Math.round(latest.progress * 100)}%` }} /></div>
                        <p>{Math.round(latest.progress * 100)}% · {latest.profile.toUpperCase()} · 第 {latest.attempt} 次尝试</p>
                        {latest.status === "QUEUED" ? <p className="muted">{online ? "已排队，等待 Worker 领取任务。" : "已排队：Worker 当前离线，任务会保留到 Worker 上线。"}</p> : null}
                        {latest.error_message && <p className="error">{latest.error_code} {latest.error_message}</p>}
                        {timeline.length > 0 && (
                          <details>
                            <summary>阶段记录</summary>
                            <ol className="timeline">
                              {timeline.map((row) => (
                                <li key={row.key}><strong>{row.stage}</strong><small>{row.status} · {Math.round(row.progress * 100)}%{row.message ? ` · ${row.message}` : ""}</small>{Object.keys(row.metrics).length > 0 && <code>{JSON.stringify(row.metrics)}</code>}</li>
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
                                <li key={line.id}><code className="log-line">{new Date(line.created_at).toLocaleTimeString()} · {line.level.toUpperCase()} · {line.message}</code></li>
                              ))}
                            </ol>
                          )}
                          {logs.length > 0 && <button onClick={() => runAction(loadEarlierLogs)}>加载更早</button>}
                        </details>
                        {canWrite && ACTIVE[latest.status] && <button disabled={latest.cancel_requested} onClick={() => runAction(async () => { setLiveJob(await client.cancelJob(latest.id)); await refresh(); })}>取消任务</button>}
                        {canWrite && (latest.status === "FAILED" || latest.status === "CANCELLED") && <button onClick={() => runAction(async () => { setLiveJob(await client.retryJob(latest.id)); await refresh(); })}>重试任务</button>}
                        {reconstructionId && (
                          <div className="result-actions">
                            <button className="primary" onClick={() => runAction(() => openScene(reconstructionId))}>打开场景</button>
                            {artifacts.some((item) => item.kind === "ply") ? <button onClick={() => runAction(() => openScene(reconstructionId, "ply"))}>打开 PLY 场景</button> : null}
                            <button onClick={() => runAction(() => refreshArtifacts(reconstructionId))}>刷新产物链接</button>
                            <button onClick={() => runAction(() => copy(`${webBaseUrl.replace(/\/$/, "")}/viewer?reconstruction=${encodeURIComponent(reconstructionId)}`))}>复制 Viewer 链接</button>
                            {artifacts.map((item) => (
                              <div key={item.kind}>
                                <a href={item.url} target="_blank" rel="noreferrer" download>{item.kind.toUpperCase()} 下载</a>
                                {item.size != null && <small> · {(item.size / 1024 / 1024).toFixed(1)} MB</small>}
                                {item.sha256 && <small> · SHA256 {item.sha256}</small>}
                                {item.kind === "ply" && <button onClick={() => runAction(() => openScene(reconstructionId, "ply"))}>查看 PLY</button>}
                              </div>
                            ))}
                            {canWrite && (
                              <details>
                                <summary>管理分享</summary>
                                <label>到期<select value={sharePreset} onChange={(event) => setSharePreset(event.target.value as SharePreset)}>{SHARE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></label>
                                <button onClick={() => runAction(async () => {
                                  const preset = SHARE_PRESETS.find((item) => item.value === sharePreset);
                                  const expiresAt = preset?.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
                                  const share = await client.createShare(reconstructionId, expiresAt);
                                  const link = `${webBaseUrl.replace(/\/$/, "")}/share/${encodeURIComponent(share.token)}`;
                                  setCreatedLink(link);
                                  setCreatedShareToken(share.token);
                                  await loadShares(reconstructionId);
                                })}>创建分享</button>
                                {createdLink && (
                                  <p>
                                    链接仅在创建时显示：<input aria-label="新分享链接" readOnly value={createdLink} />
                                    <button onClick={() => runAction(() => copy(createdLink))}>复制分享链接</button>
                                    {typeof navigator !== "undefined" && typeof navigator.share === "function" ? <button onClick={() => runAction(() => shareLink(createdLink))}>系统分享</button> : null}
                                  </p>
                                )}
                                {createdShareToken && <img className="qr" alt="分享二维码" width={160} height={160} src={client.shareQrUrl(createdShareToken)} />}
                                {shares.map((share) => (
                                  <div key={share.id}>
                                    {share.id.slice(0, 8)} · {share.revoked_at ? "已撤销" : share.expires_at ? `到期 ${new Date(share.expires_at).toLocaleString()}` : "永不过期"}
                                    {!share.revoked_at && (
                                      <button onClick={() => { if (!window.confirm("撤销该分享链接？")) return; runAction(async () => { await client.revokeShare(share.id); setCreatedLink(""); setCreatedShareToken(""); await loadShares(reconstructionId); }); }}>撤销</button>
                                    )}
                                  </div>
                                ))}
                              </details>
                            )}
                          </div>
                        )}
                      </>
                    ) : <p className="muted">尚未创建任务。</p>}
                  </section>
                </div>
                {scene && artifact && (
                  <section className="scene" role="dialog" aria-modal="true" aria-label="场景查看器">
                    <Viewer
                      src={artifact.url}
                      artifactKind={artifact.kind}
                      reconstructionId={scene.reconstructionId}
                      sha256={artifact.sha256 ?? undefined}
                      size={artifact.size ?? undefined}
                      onStatus={(status, statusDetail) => setViewerStatus(statusDetail ?? (status === "ready" ? "" : status === "loading" ? "正在加载场景" : "场景加载失败"))}
                      onRetry={() => runAction(() => openScene(scene.reconstructionId, scene.kind))}
                    />
                    <button autoFocus onClick={() => setScene(null)}>关闭查看器</button>
                    {viewerStatus ? <span className="viewer-status" role="status">{viewerStatus}</span> : null}
                  </section>
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
