import { Screen, WorkspaceEntry } from "../../screen";
import { AssetThumbnail } from "../../asset-thumbnail";
import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, canRetryJob, jobErrorHint, queuedJobHint, reconcileWorkspaceSelection, selectWorkspaceAssets, selectionBytes, stageLabel } from "@rescene/schemas";
import type { Asset, Job, JobLog, MemberRole, Profile, ProjectWorkspace, ProjectMember, ShareSummary, WorkerStatus } from "@rescene/schemas";
import { isQueuedMediaMissing, MediaPreflightError, newIdempotencyKey, QUEUE_PAUSED, summarizeMediaWarnings, type QueueOwner } from "@rescene/uploader";
import { Button, Image, Input, Progress, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, assertQueueOwner, client, currentQueueOwner, isQueueOwnerCurrent, onSessionExpired, webBaseUrl } from "../../api";
import { discardQueued, enqueue, replayQueued, uploadQueued } from "../../queue";
import { createJobLogReader, type JobLogReader } from "./job-logs";
import {
  chooseMedia,
  inspectChosenFiles,
  persistChosenFile,
  removeManagedMedia,
  UploadError,
  UploadSelectionError,
  MINIAPP_FILE_COUNT,
  MINIAPP_FILE_LIMIT,
  type ChosenFile,
} from "../../upload";

const PROFILES: Profile[] = ["fast", "balanced", "quality"];
const PROJECT_SECTIONS = [["materials", "素材"], ["build", "重建路线"], ["tasks", "任务与结果"]] as const;
type ProjectSection = (typeof PROJECT_SECTIONS)[number][0];
const MEMBER_ROLE_LABEL = { owner: "所有者", member: "成员（可写）", viewer: "查看者（只读）" } as const;
const EFFECTIVE_ROLE_LABEL = { owner: "所有者", admin: "管理员", member: "成员（可写）", viewer: "查看者（只读）" } as const;
const ACTIVE: Record<string, true> = { QUEUED: true, LEASED: true, RUNNING: true };
const POLL_MS = 3000;
const LOG_LEVELS: ["" | "info" | "warning" | "error", string][] = [
  ["", "全部"],
  ["info", "信息"],
  ["warning", "警告"],
  ["error", "错误"],
];
const SHARE_PRESETS = [
  { value: "never", label: "永久", ms: null },
  { value: "1d", label: "1 天", ms: 86_400_000 },
  { value: "7d", label: "7 天", ms: 604_800_000 },
  { value: "30d", label: "30 天", ms: 2_592_000_000 },
] as const;

type SharePreset = (typeof SHARE_PRESETS)[number]["value"];
type TimelineRow = {
  key: string;
  stage: string;
  status: string;
  progress: number;
  message?: string | null;
};
type UploadItem = { owner: QueueOwner; id: string; file: ChosenFile; progress: number; status: "waiting" | "uploading" | "failed" | "done"; error?: string };
const message = (reason: unknown, fallback: string) => {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 403) return "没有权限执行此操作，或你不是该项目成员。";
    if (reason.status === 404) return "项目或资源不存在，可能已被删除。";
    if (reason.status === 409) return reason.detail || "当前状态不允许此操作；请检查是否有进行中的任务。";
    return explainError(reason, reason.detail || fallback);
  }
  return reason instanceof Error ? reason.message : fallback;
};

export default function ProjectPage() {
  const params = useRouter()?.params ?? {};
  return <WorkspaceEntry hasTarget={Boolean(params.id)}><ProjectWorkspace params={params} /></WorkspaceEntry>;
}

function ProjectWorkspace({ params }: { params: Record<string, string | undefined> }) {
  const [section, setSection] = useState<ProjectSection>(params.view === "tasks" ? "tasks" : "materials");
  const requestedJob = useRef(params.job);
  const [showManagement, setShowManagement] = useState(false);
  const [assetPages, setAssetPages] = useState([""]);
  const [jobPages, setJobPages] = useState([""]);
  const [pageLoading, setPageLoading] = useState(false);
  const requestId = useRef(0);
  const [showLogs, setShowLogs] = useState(false);
  const projectId = params.id ?? "";
  const [detail, setDetail] = useState<ProjectWorkspace | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [selected, setSelected] = useState<Asset[]>([]);
  const [profile, setProfile] = useState<Profile>("balanced");
  const [job, setJob] = useState<Job | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<MemberRole>("member");
  const [issuedInvitation, setIssuedInvitation] = useState<{ email: string; code: string } | null>(null);
  const [issuingInvitation, setIssuingInvitation] = useState(false);
  const invitationContext = useRef(0);
  const [sharesState, setSharesState] = useState<{ reconstructionId: string; items: ShareSummary[] }>({ reconstructionId: "", items: [] });
  const [createdShare, setCreatedShare] = useState<{ reconstructionId: string; url: string; token: string } | null>(null);
  const shareRequest = useRef(0);
  const [sharePreset, setSharePreset] = useState<SharePreset>("7d");
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [logLevel, setLogLevel] = useState<"" | "info" | "warning" | "error">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [visible, setVisible] = useState(true);
  const createLock = useRef(false);
  const jobAttempt = useRef<{ signature: string; key: string } | null>(null);
  const jobLock = useRef(false);
  const shareLock = useRef(false);
  const renameLock = useRef(false);
  const selectLock = useRef(false);
  const uploadLock = useRef(false);
  const logReader = useRef<JobLogReader | null>(null);
  if (!logReader.current) {
    logReader.current = createJobLogReader(
      (id, options) => client.listJobLogs(id, options),
      setLogs,
      (reason) => setError(message(reason, "加载运行日志失败")),
    );
  }
  const role = detail?.effective_role;
  const canManage = role === "owner" || role === "admin";
  const canWrite = canManage || role === "member";
  const jobs = detail?.jobs ?? [];

  useEffect(() => {
    setIssuedInvitation(null);
    return () => { invitationContext.current += 1; };
  }, [projectId, showManagement, visible]);
  useEffect(() => {
    if (!issuedInvitation) return;
    const timer = setTimeout(() => setIssuedInvitation(null), 120_000);
    return () => clearTimeout(timer);
  }, [issuedInvitation]);

  function showSection(next: ProjectSection) {
    setShowManagement(false);
    setSection(next);
    void Taro.pageScrollTo({ scrollTop: 0, duration: 160 }).catch(() => undefined);
  }

  const load = useCallback(async () => {
    if (!projectId) return;
    const request = ++requestId.current;
    setPageLoading(true);
    try {
      const value = await client.getWorkspace(projectId, assetPages[assetPages.length - 1], jobPages[jobPages.length - 1]);
      if (request !== requestId.current) return;
      const target = requestedJob.current;
      const initialJob = target ? value.jobs.find((item) => item.id === target) ?? await client.getJob(target).catch(() => null) : null;
      if (request !== requestId.current) return;
      requestedJob.current = undefined;
      setDetail(value);
      void Taro.setNavigationBarTitle({ title: value.name }).catch(() => undefined);
      setName((current) => current || value.name);
      setSelected((current) => reconcileWorkspaceSelection(current, value.assets));
      setJob((current) => current
        ? value.jobs.find((item) => item.id === current.id) ?? current
        : initialJob?.project_id === projectId ? initialJob : value.jobs[0] ?? null);
      setError("");
    } catch (reason) {
      if (request === requestId.current) setError(message(reason, "加载项目失败"));
    } finally {
      if (request === requestId.current) setPageLoading(false);
    }
  }, [assetPages, jobPages, projectId]);
  useEffect(() => { if (visible) void load(); }, [load, visible]);

  const loadMembers = useCallback(async () => {
    if (!projectId) return;
    try { setMembers(await client.listMembers(projectId)); }
    catch (reason) { setError(message(reason, "加载成员失败")); }
  }, [projectId]);

  const loadWorker = useCallback(async () => {
    try { setWorker(await client.getWorkerStatus()); }
    catch { setWorker(null); }
  }, []);

  const reload = useCallback(() => {
    setError("");
    setNotice("");
    void load();
    void loadMembers();
    void loadWorker();
  }, [load, loadMembers, loadWorker]);

  useDidShow(() => {
    setVisible(true);
    const owner = currentQueueOwner();
    if (owner) void replayQueued(owner, () => undefined)
      .then(({ uploaded }) => { if (uploaded && isQueueOwnerCurrent(owner)) void load(); })
      .catch((reason) => { if (isQueueOwnerCurrent(owner)) setError(message(reason, "同步离线上传失败")); });
    reload();
  });

  useDidHide(() => {
    logReader.current?.context(job?.id ?? "", logLevel, false);
    setVisible(false);
  });
  useEffect(() => onSessionExpired(() => { setUploads([]); setNotice(""); }), []);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => void loadWorker(), 15000);
    return () => clearInterval(timer);
  }, [loadWorker, visible]);

  const jobId = job?.id;
  const jobActive = visible && Boolean(job && ACTIVE[job.status]);
  useEffect(() => {
    setTimeline([]);
    if (!jobId) return;
    let cancelled = false;
    void client.getJobStages(jobId)
      .then((rows) => {
        if (cancelled) return;
        setTimeline(rows.map((row) => ({
          key: row.id,
          stage: row.stage,
          status: row.status,
          progress: row.progress,
          message: row.message,
        })));
      })
      .catch((reason) => { if (!cancelled) setError(message(reason, "加载任务阶段失败")); });
    return () => { cancelled = true; };
  }, [jobId]);
  useEffect(() => {
    if (!jobId || !jobActive) return;
    return client.subscribeJob(jobId, (event) => {
      if (!("id" in event)) {
        setTimeline((current) => [...current, {
          key: `live-${Date.now()}-${event.stage}`,
          stage: event.stage,
          status: event.status,
          progress: event.progress,
          message: event.message ?? null,
        }].slice(-100));
        return;
      }
      setJob(event);
      setDetail((current) => current ? { ...current, jobs: current.jobs.map((item) => item.id === event.id ? event : item) } : current);
      if (!ACTIVE[event.status]) void load();
    }, (reason) => setError(message(reason, "任务更新失败")), { transport: "polling", pollIntervalMs: POLL_MS });
  }, [jobId, jobActive, load]);
  useEffect(() => {
    const reader = logReader.current!;
    reader.context(jobId ?? "", logLevel, visible);
    if (visible && jobId) void reader.poll();
    const timer = jobActive ? setInterval(() => void reader.poll(), POLL_MS) : undefined;
    return () => {
      clearInterval(timer);
      reader.context(jobId ?? "", logLevel, false);
    };
  }, [jobId, jobActive, logLevel, visible]);

  const reconstructionId = job?.reconstruction_id ?? "";
  const activeReconstruction = useRef(reconstructionId);
  activeReconstruction.current = reconstructionId;
  const shares = sharesState.reconstructionId === reconstructionId ? sharesState.items : [];
  const activeCreatedShare = createdShare?.reconstructionId === reconstructionId ? createdShare : null;
  const shareUrl = activeCreatedShare?.url ?? "";
  const shareToken = activeCreatedShare?.token ?? "";
  const loadShares = useCallback(async () => {
    if (!reconstructionId || !canWrite) return;
    const request = ++shareRequest.current;
    try {
      const list = await client.listShares(reconstructionId);
      if (request !== shareRequest.current || activeReconstruction.current !== reconstructionId) return;
      setSharesState({ reconstructionId, items: list });
    } catch (reason) {
      if (request === shareRequest.current && activeReconstruction.current === reconstructionId) {
        setError(message(reason, "加载分享失败"));
      }
    }
  }, [reconstructionId, canWrite]);
  useEffect(() => {
    setSharesState({ reconstructionId: "", items: [] });
    setCreatedShare(null);
    if (reconstructionId && canWrite) void loadShares();
  }, [reconstructionId, canWrite, loadShares]);

  async function runUploads(owner: QueueOwner, items: UploadItem[], indexes: number[]) {
    if (uploadLock.current || !isQueueOwnerCurrent(owner)) return;
    uploadLock.current = true;
    setUploading(true);
    try {
      for (const index of indexes) {
        const item = items[index];
        if (!isQueueOwnerCurrent(owner)) return;
        if (item.owner.id !== owner.id || item.owner.generation !== owner.generation) continue;
        setUploads((current) => current.map((row, i) => i === index ? { ...row, status: "uploading", progress: 0, error: undefined } : row));
        try {
          await uploadQueued(owner, item.id, (progress) => setUploads((current) => current.map((row, i) => i === index ? { ...row, progress } : row)));
          if (!isQueueOwnerCurrent(owner)) return;
          setUploads((current) => current.map((row, i) => i === index ? { ...row, status: "done", progress: 100 } : row));
        } catch (reason) {
          if (!isQueueOwnerCurrent(owner)) return;
          const offline = isOfflineError(reason) || (reason instanceof UploadError && reason.offline);
          const missing = isQueuedMediaMissing(reason);
          setUploads((current) => current.map((row, i) => i === index ? {
            ...row,
            status: "failed",
            error: missing ? "本地素材副本已丢失，请移除后重新选择。" : offline ? "已保存，联网后自动重试。" : message(reason, "上传失败"),
          } : row));
        }
      }
      await load();
      if (isQueueOwnerCurrent(owner)) setUploads((current) => current.filter((item) => item.status !== "done"));
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  }

  async function abandonUpload(item: UploadItem) {
    try {
      await discardQueued(item.owner, item.id);
      setUploads((current) => current.filter((row) => row.id !== item.id));
    } catch (reason) { setError(message(reason, "移除失败")); }
  }

  async function upload() {
    if (selectLock.current || uploadLock.current) return;
    const owner = currentQueueOwner();
    if (!owner) { setError(QUEUE_PAUSED); return; }
    selectLock.current = true;
    setUploading(true);
    try {
      setError("");
      const files = await chooseMedia();
      const warnings = await inspectChosenFiles(files);
      assertQueueOwner(owner);
      if (warnings.length) {
        const result = await Taro.showModal({ title: "素材检查提示", content: summarizeMediaWarnings(warnings), confirmText: "仍然上传", cancelText: "重新选择" });
        if (!result.confirm) return;
      }
      const failed = uploads.filter((item) => item.status === "failed");
      const pending: UploadItem[] = [];
      for (const file of files) {
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let stored: { path: string; size: number };
        try {
          stored = persistChosenFile(owner, id, file);
        } catch (reason) {
          if (isQueueOwnerCurrent(owner)) setError(message(reason, `无法保存 ${file.name}，请检查设备存储后重新选择。`));
          continue;
        }
        try {
          await enqueue(owner, {
            kind: "upload",
            id,
            projectId,
            uri: stored.path,
            name: file.name,
            mimeType: file.contentType,
            size: stored.size,
            managed: true,
            createdAt: Date.now(),
          });
        } catch (reason) {
          removeManagedMedia(stored.path);
          throw reason;
        }
        pending.push({ owner, id, file: { ...file, path: stored.path, size: stored.size }, progress: 0, status: "waiting" });
      }
      const items = [...failed, ...pending];
      if (!isQueueOwnerCurrent(owner)) return;
      setUploads(items);
      await runUploads(owner, items, pending.map((_, index) => failed.length + index));
    } catch (reason) {
      if (!isQueueOwnerCurrent(owner) || (reason instanceof UploadSelectionError && reason.cancelled)) return;
      setError(reason instanceof MediaPreflightError ? reason.message : message(reason, "选择文件失败"));
    } finally {
      selectLock.current = false;
      setUploading(false);
    }
  }

  async function createJob() {
    if (createLock.current || !canWrite || !selected.length) return;
    createLock.current = true;
    setCreating(true);
    const ids = selected.map((asset) => asset.id);
    const signature = JSON.stringify([profile, [...ids].sort()]);
    const attempt = jobAttempt.current?.signature === signature ? jobAttempt.current : { signature, key: newIdempotencyKey() };
    jobAttempt.current = attempt;
    try {
      const created = await client.createJob(projectId, profile, ids, attempt.key);
      jobAttempt.current = null;
      setJob(created);
      setShowLogs(false);
      showSection("tasks");
      await load();
    } catch (reason) { setError(message(reason, "创建任务失败")); }
    finally { createLock.current = false; setCreating(false); }
  }

  async function changeJob(action: "cancel" | "retry") {
    if (!job || jobLock.current) return;
    jobLock.current = true;
    try {
      const result = await Taro.showModal({
        title: action === "cancel" ? "取消任务" : "重试任务",
        content: action === "cancel" ? "确定取消当前重建任务？" : "确定使用原素材重新排队？",
      });
      if (!result.confirm) return;
      setJobBusy(true);
      const updated = action === "cancel" ? await client.cancelJob(job.id) : await client.retryJob(job.id);
      setJob(updated);
      await load();
    } catch (reason) { setError(message(reason, "任务操作失败")); }
    finally { jobLock.current = false; setJobBusy(false); }
  }

  async function rename() {
    const trimmed = name.trim();
    if (renameLock.current) return;
    if (!trimmed) { setError("项目名称不能为空"); return; }
    renameLock.current = true;
    try { await client.updateProject(projectId, trimmed); setName(trimmed); await load(); }
    catch (reason) { setError(message(reason, "重命名失败")); }
    finally { renameLock.current = false; }
  }

  async function removeProject() {
    const result = await Taro.showModal({ title: "删除项目", content: "确定删除此项目？此操作不可撤销。" });
    if (!result.confirm) return;
    try { await client.deleteProject(projectId); await Taro.navigateBack(); }
    catch (reason) { setError(message(reason, "删除项目失败")); }
  }

  async function addMember() {
    const address = email.trim();
    if (!address || issuingInvitation) return;
    const context = invitationContext.current;
    setIssuedInvitation(null);
    setIssuingInvitation(true);
    setError("");
    setNotice("");
    try {
      const result = await client.addMember(projectId, address, memberRole);
      if (context !== invitationContext.current) return;
      setEmail("");
      if (result.status === "member") setNotice("该账号已是项目成员，可在成员列表调整角色。");
      else if (result.claim_code) setIssuedInvitation({ email: result.email, code: result.claim_code });
      else setNotice("当前服务端版本无法提供领取码。请在升级后重新签发邀请。");
    } catch (reason) {
      if (context === invitationContext.current) setError(message(reason, "签发邀请失败"));
    } finally {
      setIssuingInvitation(false);
    }
  }

  async function changeMember(member: ProjectMember, action: "role" | "remove") {
    if (member.role === "owner") return;
    try {
      if (action === "role") await client.updateMemberRole(projectId, member.user_id, member.role === "member" ? "viewer" : "member");
      else {
        const result = await Taro.showModal({ title: "移除成员", content: `确定移除 ${member.email}？` });
        if (!result.confirm) return;
        await client.removeMember(projectId, member.user_id);
      }
      await loadMembers();
    } catch (reason) { setError(message(reason, "成员操作失败")); }
  }

  async function createShare() {
    if (!reconstructionId || shareLock.current) return;
    if (!webBaseUrl || !/^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(webBaseUrl)) {
      setError("请配置有效的 HTTPS 小程序网页地址后创建分享");
      return;
    }
    const preset = SHARE_PRESETS.find((item) => item.value === sharePreset);
    const expires = preset?.ms ? new Date(Date.now() + preset.ms).toISOString() : undefined;
    const target = reconstructionId;
    shareLock.current = true;
    setSharing(true);
    try {
      const share = await client.createShare(target, expires);
      if (activeReconstruction.current !== target) return;
      setCreatedShare({ reconstructionId: target, url: `${webBaseUrl.replace(/\/+$/, "")}/share/${encodeURIComponent(share.token)}`, token: share.token });
      await loadShares();
    } catch (reason) {
      if (activeReconstruction.current === target) setError(message(reason, "创建分享失败"));
    } finally { shareLock.current = false; setSharing(false); }
  }

  async function revokeShare(id: string) {
    const result = await Taro.showModal({ title: "撤销分享", content: "撤销后该链接将无法访问。" });
    if (!result.confirm) return;
    const target = activeReconstruction.current;
    try {
      await client.revokeShare(id);
      if (activeReconstruction.current !== target) return;
      setCreatedShare(null);
      await loadShares();
    } catch (reason) {
      if (activeReconstruction.current === target) setError(message(reason, "撤销分享失败"));
    }
  }

  async function copyShare() {
    if (!shareUrl) return;
    try {
      await Taro.setClipboardData({ data: shareUrl });
      await Taro.showToast({ title: "链接已复制，可粘贴到微信发送", icon: "none", duration: 2500 });
    } catch (reason) { setError(message(reason, "复制失败")); }
  }

  async function loadEarlierLogs() {
    const first = logs[0];
    if (!jobId || !first) return;
    try {
      const rows = await client.listJobLogs(jobId, { beforeId: first.id, limit: 200, ...(logLevel ? { level: logLevel } : {}) });
      setLogs((previous) => {
        const known = new Set(previous.map((row) => row.id));
        return [...rows.filter((row) => !known.has(row.id)), ...previous];
      });
    } catch (reason) { setError(message(reason, "加载更早日志失败")); }
  }

  function choose(assets: Asset[], imagesOnly = false) {
    try { setSelected(selectWorkspaceAssets(selected, assets, imagesOnly)); setError(""); }
    catch (reason) { void Taro.showModal({ title: "无法选择素材", content: message(reason, "请检查已选素材"), showCancel: false }); }
  }

  function pageControls(label: string, pages: string[], next: string | null, setPages: (pages: string[]) => void) {
    if (pages.length === 1 && !next) return null;
    const move = (cursor?: string) => {
      setPageLoading(true);
      setPages(cursor ? [...pages, cursor] : pages.slice(0, -1));
      void Taro.pageScrollTo({ scrollTop: 0, duration: 160 }).catch(() => undefined);
    };
    return <View className="page-controls">
      <Button className="button ghost compact" disabled={pageLoading || pages.length === 1} onClick={() => move()}>{label}上一页</Button>
      <Text className="muted">第 {pages.length} 页</Text>
      <Button className="button ghost compact" disabled={pageLoading || !next} onClick={() => { if (next) move(next); }}>{label}下一页</Button>
    </View>;
  }

  async function copyViewer(id: string) {
    if (!webBaseUrl) { setError("查看器地址未配置"); return; }
    try { await Taro.setClipboardData({ data: `${webBaseUrl.replace(/\/$/, "")}/viewer?reconstruction=${encodeURIComponent(id)}` }); }
    catch (reason) { setError(message(reason, "复制查看链接失败")); }
  }

  async function removeAsset(asset: Asset) {
    const result = await Taro.showModal({ title: "删除素材", content: `确定删除「${asset.filename}」？` });
    if (!result.confirm) return;
    try {
      await client.deleteAsset(asset.id);
      setSelected((current) => current.filter((item) => item.id !== asset.id));
      await load();
    } catch (reason) { setError(message(reason, "删除失败，请稍后重试。")); }
  }

  return (
    <Screen>
      <Text className="title">{detail?.name ?? "项目"}</Text>
      {detail && role ? <View className="project-heading">
        <Text className="muted">{EFFECTIVE_ROLE_LABEL[role]} · {detail.asset_count} 个素材 · {detail.job_count} 个任务</Text>
        <Button className="button ghost compact" aria-expanded={showManagement} onClick={() => setShowManagement((value) => !value)}>
          {showManagement ? "收起管理" : canManage ? "项目管理" : "查看成员"}
        </Button>
      </View> : null}
      {detail ? <View className="segmented project-sections">
        {PROJECT_SECTIONS.filter(([value]) => value !== "build" || canWrite).map(([value, label]) => (
          <Button key={value} className={`button tab${section === value && !showManagement ? " active" : ""}`} aria-pressed={section === value && !showManagement} onClick={() => showSection(value)}>{label}</Button>
        ))}
      </View> : null}
      {!projectId ? <Text className="error">缺少项目参数，请返回项目列表重新打开。</Text> : null}
      {projectId && !detail && !error ? <Text className="muted">加载中…</Text> : null}
      {error ? <View className="card">
        <Text className="error">{error}</Text>
        <Button className="button ghost" onClick={reload}>重试加载</Button>
      </View> : null}
      {notice ? <Text>{notice}</Text> : null}
      {showManagement && canManage ? <View className="card">
        <Text className="label">项目名称</Text>
        <Input className="input" value={name} onInput={(event) => setName(event.detail.value)} />
        <Button className="button ghost" onClick={rename}>保存名称</Button>
        <Button className="button ghost" onClick={removeProject}>删除项目</Button>
      </View> : null}
      {showManagement && detail ? <View className="card">
        <Text className="label">项目成员</Text>
        {members.map((member) => <View className="row" key={member.user_id}>
          <Text>{member.email} · {MEMBER_ROLE_LABEL[member.role]}</Text>
          {canManage && member.role !== "owner" ? <View>
            <Button className="button ghost" onClick={() => void changeMember(member, "role")}>设为{member.role === "member" ? "查看者" : "成员"}</Button>
            <Button className="button ghost" onClick={() => void changeMember(member, "remove")}>移除</Button>
          </View> : null}
        </View>)}
        {canManage ? <View>
          <Text className="label">邀请成员邮箱</Text>
          <Input className="input" value={email} placeholder="name@example.com" onInput={(event) => setEmail(event.detail.value)} />
          <Button className="button ghost" onClick={() => setMemberRole(memberRole === "member" ? "viewer" : "member")}>邀请角色：{MEMBER_ROLE_LABEL[memberRole]}</Button>
          <Button className="button" loading={issuingInvitation} disabled={issuingInvitation || !email.trim()} onClick={addMember}>签发邀请</Button>
          {visible && issuedInvitation ? <View>
            <Text>请将领取码交给 {issuedInvitation.email}。领取码 7 天内有效，仅可使用一次。</Text>
            <Text selectable>{issuedInvitation.code}</Text>
          </View> : null}
        </View> : null}
      </View> : null}
      {detail && section === "materials" && !showManagement ? <View className="card">
        <View className="project-heading">
          <Text className="section-heading">素材</Text>
          {canWrite ? <Text className="selection-count">已选 {selected.length} 个</Text> : null}
        </View>
        {canWrite ? <>
          <Button className="button" disabled={uploading} onClick={upload}>选择图片或视频</Button>
          <Text className="muted">每次最多 {MINIAPP_FILE_COUNT} 个，单文件 ≤ {MINIAPP_FILE_LIMIT / 1024 / 1024} MiB。同一任务可选一组 JPG / PNG 或一个视频。</Text>
        </> : null}
        {uploads.map((item, index) => <View className="row" key={`${item.file.path}-${index}`}>
          <Text>{item.file.name} · {item.status === "failed" ? item.error : `${item.progress}%`}</Text>
          {item.status === "failed" ? <Button className="button ghost" disabled={uploading} onClick={() => void runUploads(item.owner, uploads, [index])}>重试上传</Button> : null}
          {item.status === "failed" ? <Button className="button ghost" disabled={uploading} onClick={() => void abandonUpload(item)}>移除此项</Button> : null}
        </View>)}
        {!detail.assets.length && !uploads.length ? <Text className="muted">暂无素材</Text> : null}
        {canWrite && detail.assets.length > 0 ? <View className="selection-tools">
          <Button className="button ghost compact" onClick={() => choose(detail.assets, true)}>全选本页图片</Button>
          <Button className="button ghost compact" disabled={!selected.length} onClick={() => setSelected([])}>清空选择</Button>
        </View> : null}
        <View className="asset-grid">
        {detail.assets.map((asset) => <View className={`asset-tile${selected.some((item) => item.id === asset.id) ? " selected" : ""}`} key={asset.id}>
          <AssetThumbnail asset={asset} />
          <View className="asset-choice" role={canWrite ? "checkbox" : undefined} aria-checked={canWrite ? selected.some((item) => item.id === asset.id) : undefined} aria-disabled={!canWrite || asset.status !== "READY"} onClick={() => { if (canWrite && asset.status === "READY") choose([asset]); }}>
            <Text>{asset.filename}</Text>
            <Text className="muted">{selected.some((item) => item.id === asset.id) ? "已选" : ASSET_STATUS_LABELS[asset.status]}</Text>
          </View>
          {canWrite ? <Button className="button ghost compact danger-action" aria-label={`删除 ${asset.filename}`} onClick={() => void removeAsset(asset)}>删除</Button> : null}
        </View>)}
        </View>
        {pageControls("素材", assetPages, detail.nextAssetCursor, setAssetPages)}
      </View> : null}
      {canWrite && section === "build" && !showManagement ? <View className="card">
        <Text className="section-heading">重建路线</Text>
        {PROFILES.map((value) => {
          const option = RECONSTRUCTION_PROFILES[value];
          return <Button className={`button route-option${profile === value ? " selected" : ""}`} aria-pressed={profile === value} key={value} onClick={() => setProfile(value)}>
            <Text className="label">{option.title} · {value.toUpperCase()}</Text>
            <Text className="muted">{option.description} · 最多 {option.frames} 帧</Text>
          </Button>;
        })}
        <View className="project-heading">
          <Text className={worker?.online ? "success-state" : "muted"}>
            {worker ? (worker.online ? "计算节点在线" : "计算节点离线，提交后排队") : "暂无计算节点状态"}
          </Text>
          <Button className="button ghost compact" onClick={loadWorker}>刷新</Button>
        </View>
        {!selected.length ? <Text className="muted">请先从素材列表选择要重建的文件</Text> : null}
        {!selected.length ? <Button className="button ghost" onClick={() => showSection("materials")}>返回选择素材</Button> : null}
      </View> : null}
      {detail && section === "tasks" && !showManagement ? <View className="card">
        <Text className="section-heading">重建任务</Text>
        {jobs.map((item) => <Button className={`button route-option${job?.id === item.id ? " selected" : ""}`} aria-pressed={job?.id === item.id} key={item.id} onClick={() => {
          setJob(item);
          setShowLogs(false);
          Taro.nextTick(() => { void Taro.pageScrollTo({ selector: "#task-detail", duration: 160 }).catch(() => undefined); });
        }}>
          <Text className="label">{RECONSTRUCTION_PROFILES[item.profile].title} · {JOB_STATUS_LABELS[item.status]}</Text>
          <Text className="muted">{new Date(item.created_at).toLocaleString()} · {item.id.slice(0, 8)}</Text>
        </Button>)}
        {pageControls("任务", jobPages, detail.nextJobCursor, setJobPages)}
        {job ? <View className="task-detail" id="task-detail">
          <Text className={job.status === "SUCCEEDED" ? "success-state" : job.status === "FAILED" ? "error" : "label"}>{JOB_STATUS_LABELS[job.status]} · 第 {job.attempt} 次</Text>
          <Text className="muted">{stageLabel(job.current_stage)} · {Math.round(job.progress * 100)}%</Text>
          <Progress percent={Math.round(job.progress * 100)} strokeWidth={5} borderRadius={6} activeColor="#7c9bff" backgroundColor="#07080c" />
          <Text className="muted">更新于 {new Date(job.updated_at).toLocaleString()}</Text>
          {timeline.map((row) => <View key={row.key}>
            <Text className="muted">{stageLabel(row.stage)} · {row.status} · {Math.round(row.progress * 100)}%</Text>
            {row.message && row.stage !== "queued" ? <Text className="muted">{row.message}</Text> : null}
          </View>)}
          {job.status === "QUEUED" ? <Text className="muted">{queuedJobHint(worker?.online)}</Text> : null}
          {job.error_code || job.error_message ? <Text className="error">{jobErrorHint(job.error_code) || job.error_message || job.error_code}</Text> : null}
          {canWrite && ACTIVE[job.status] ? <Button className="button ghost" disabled={jobBusy || job.cancel_requested} loading={jobBusy} onClick={() => void changeJob("cancel")}>{job.cancel_requested ? "取消中" : "取消任务"}</Button> : null}
          {canWrite && job.error_code === "INVALID_INPUT" ? <Button className="button ghost" onClick={() => showSection("materials")}>更换素材</Button> : null}
          {canWrite && canRetryJob(job) ? <Button className="button ghost" disabled={jobBusy} loading={jobBusy} onClick={() => void changeJob("retry")}>重试任务</Button> : null}
          {reconstructionId ? <>
            <Button className="button" onClick={() => void copyViewer(reconstructionId)}>复制浏览器查看链接</Button>
            <Text className="muted">在手机浏览器中粘贴链接，登录后即可查看。</Text>
          </> : null}
        </View> : <Text className="muted">暂无任务</Text>}
      </View> : null}
      {job && section === "tasks" && !showManagement ? <View className="card">
        <Button className="button ghost" aria-expanded={showLogs} onClick={() => setShowLogs((value) => !value)}>
          {showLogs ? "收起运行日志" : `查看运行日志（${logs.length}）`}
        </Button>
        {showLogs ? <>
          <View className="segmented">
            {LOG_LEVELS.map(([value, label]) => (
              <View className={logLevel === value ? "tab active" : "tab"} key={value || "all"} onClick={() => setLogLevel(value)}>{label}</View>
            ))}
          </View>
          <Button className="button ghost" disabled={!logs.length} onClick={() => void loadEarlierLogs()}>加载更早</Button>
          {logs.length === 0 ? <Text className="muted">暂无运行日志。</Text> : null}
          <ScrollView scrollY className="log-panel">
            {logs.map((row) => <Text className="log" key={row.id}>{row.created_at} · {row.level} · {row.message}</Text>)}
          </ScrollView>
        </> : null}
      </View> : null}
      {canWrite && reconstructionId && section === "tasks" && !showManagement ? <View className="card">
        <Text className="label">分享</Text>
        <Text className="label">分享有效期</Text>
        {SHARE_PRESETS.map((preset) => <Text className={`row profile ${sharePreset === preset.value ? "active" : ""}`} key={preset.value} onClick={() => setSharePreset(preset.value)}>{sharePreset === preset.value ? "● " : "○ "}{preset.label}</Text>)}
        <Button className="button" loading={sharing} disabled={sharing} onClick={createShare}>创建分享</Button>
        {shareUrl ? <View>
          <Text className="muted">链接仅在创建时显示，请及时复制；复制后可粘贴到微信会话发送。</Text>
          <Button className="button ghost" onClick={copyShare}>复制新链接</Button>
          {shareToken && apiBaseUrl ? <Image className="qr" src={client.shareQrUrl(shareToken)} mode="aspectFit" /> : null}
          {shareToken ? <Button className="button ghost" onClick={() => void Taro.navigateTo({ url: `/pages/viewer/index?share=${encodeURIComponent(shareToken)}` })}>打开转发页面</Button> : null}
          <Text className="muted">可在“三维场景”页右上角菜单转发小程序链接；普通网页链接需接收方在浏览器打开。</Text>
        </View> : null}
        {shares.map((share) => <View className="row" key={share.id}>
          <Text>{share.id} · {share.revoked_at ? `已撤销 ${share.revoked_at}` : `有效期 ${share.expires_at ?? "不限"}`}</Text>
          {!share.revoked_at ? <Button className="button ghost" onClick={() => void revokeShare(share.id)}>撤销</Button> : null}
        </View>)}
      </View> : null}
      {canWrite && section !== "tasks" && !showManagement ? <>
        <View className="selection-spacer" />
        <View className="selection-bar">
          <View><Text className="label">已选 {selected.length} 个 · {(selectionBytes(selected) / 1024 ** 2).toFixed(1)} MiB</Text>
            <Text className="muted">{RECONSTRUCTION_PROFILES[profile].title}{worker?.online === false ? " · 离线排队" : ""}</Text></View>
          <Button className="button" disabled={creating || !selected.length || uploading} loading={creating} onClick={section === "materials" ? () => showSection("build") : createJob}>
            {section === "materials" ? "选择路线" : creating ? "正在创建…" : "开始重建"}
          </Button>
        </View>
      </> : null}
    </Screen>
  );
}
