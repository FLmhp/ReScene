import { Screen } from "../../screen";
import { AssetThumbnail } from "../../asset-thumbnail";
import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, stageLabel } from "@rescene/schemas";
import type { Asset, Job, JobLog, MemberRole, Profile, ProjectDetail, ProjectMember, ShareSummary, WorkerStatus } from "@rescene/schemas";
import { Button, Image, Input, Progress, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, client, webBaseUrl } from "../../api";
import { enqueue, loadQueue, replayQueued, saveQueue } from "../../queue";
import {
  chooseMedia,
  uploadFile,
  UploadError,
  UploadSelectionError,
  MINIAPP_FILE_COUNT,
  MINIAPP_FILE_LIMIT,
  type ChosenFile,
} from "../../upload";

const PROFILES: Profile[] = ["fast", "balanced", "quality"];
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
  metrics: Record<string, unknown>;
};
type UploadItem = { id: string; file: ChosenFile; progress: number; status: "waiting" | "uploading" | "failed" | "done"; error?: string };
const message = (reason: unknown, fallback: string) => {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 403) return "没有权限执行此操作，或你不是该项目成员。";
    if (reason.status === 404) return "项目或资源不存在，可能已被删除。";
    if (reason.status === 409) return reason.detail || "当前状态不允许此操作；请检查是否有进行中的任务。";
    return explainError(reason, reason.detail || fallback);
  }
  return reason instanceof Error ? reason.message : fallback;
};
const isVideo = (filename: string) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(filename);

export default function ProjectPage() {
  const router = useRouter();
  const [showManagement, setShowManagement] = useState(false);
  const [visibleAssets, setVisibleAssets] = useState(24);
  const [showLogs, setShowLogs] = useState(false);
  const projectId = router.params.id ?? "";
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile>("balanced");
  const [job, setJob] = useState<Job | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<MemberRole>("member");
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [shareUrl, setShareUrl] = useState("");
  const [shareToken, setShareToken] = useState("");
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
  const jobLock = useRef(false);
  const shareLock = useRef(false);
  const renameLock = useRef(false);
  const selectLock = useRef(false);
  const uploadLock = useRef(false);
  const logsRef = useRef<JobLog[]>([]);
  const role = detail?.effective_role;
  const canManage = role === "owner" || role === "admin";
  const canWrite = canManage || role === "member";
  const jobs = [...(detail?.jobs ?? [])].sort((left, right) => right.created_at.localeCompare(left.created_at));

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const value = await client.getProject(projectId);
      setDetail(value);
      void Taro.setNavigationBarTitle({ title: value.name }).catch(() => undefined);
      setName((current) => current || value.name);
      setSelected((current) => current.filter((id) => value.assets.some((asset) => asset.id === id && asset.status === "READY")));
      const latest = value.jobs.reduce<Job | null>(
        (best, item) => (!best || item.created_at > best.created_at ? item : best),
        null,
      );
      setJob((current) => (current ? value.jobs.find((item) => item.id === current.id) ?? latest : latest));
      setError("");
    } catch (reason) {
      setError(message(reason, "加载项目失败"));
    }
  }, [projectId]);

  const loadMembers = useCallback(async () => {
    if (!projectId) return;
    try { setMembers(await client.listMembers(projectId)); }
    catch (reason) { setError(message(reason, "加载成员失败")); }
  }, [projectId]);

  const loadWorker = useCallback(async () => {
    try { setWorker(await client.getWorkerStatus()); }
    catch (reason) { setError(message(reason, "加载 Worker 状态失败")); }
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
    void replayQueued(client, () => undefined)
      .then(({ uploaded }) => { if (uploaded) void load(); })
      .catch((reason) => setError(message(reason, "同步离线上传失败")));
    reload();
  });

  useDidHide(() => setVisible(false));

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
          metrics: row.metrics,
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
          metrics: event.metrics,
        }].slice(-100));
        return;
      }
      setJob(event);
      setDetail((current) => current ? { ...current, jobs: current.jobs.map((item) => item.id === event.id ? event : item) } : current);
      if (!ACTIVE[event.status]) void load();
    }, (reason) => setError(message(reason, "任务更新失败")), { transport: "polling", pollIntervalMs: POLL_MS });
  }, [jobId, jobActive, load]);
  useEffect(() => { logsRef.current = logs; }, [logs]);
  useEffect(() => {
    logsRef.current = [];
    setLogs([]);
    if (!jobId) return;
    let cancelled = false;
    void client.listJobLogs(jobId, { limit: 200, ...(logLevel ? { level: logLevel } : {}) })
      .then((rows) => { if (!cancelled) setLogs(rows); })
      .catch((reason) => { if (!cancelled) setError(message(reason, "加载运行日志失败")); });
    return () => { cancelled = true; };
  }, [jobId, logLevel]);
  useEffect(() => {
    if (!jobId || !jobActive) return;
    let cancelled = false;
    // useDidHide flips `visible`, which stops `jobActive` and clears this timer
    // while the page is in the background.
    const timer = setInterval(() => {
      const last = logsRef.current[logsRef.current.length - 1];
      if (!last) return;
      void client.listJobLogs(jobId, { afterId: last.id, limit: 200, ...(logLevel ? { level: logLevel } : {}) })
        .then((rows) => {
          if (cancelled || rows.length === 0) return;
          setLogs((previous) => {
            const known = new Set(previous.map((row) => row.id));
            return [...previous, ...rows.filter((row) => !known.has(row.id))].slice(-400);
          });
        })
        .catch((reason) => { if (!cancelled) setError(message(reason, "刷新运行日志失败")); });
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobId, jobActive, logLevel]);

  const reconstructionId = job?.reconstruction_id ?? "";
  const loadShares = useCallback(async () => {
    if (!reconstructionId || !canWrite) return;
    try { setShares(await client.listShares(reconstructionId)); }
    catch (reason) { setError(message(reason, "加载分享失败")); }
  }, [reconstructionId, canWrite]);
  useEffect(() => {
    setShares([]);
    setShareUrl("");
    setShareToken("");
    if (reconstructionId && canWrite) void loadShares();
  }, [reconstructionId, canWrite, loadShares]);

  async function runUploads(items: UploadItem[], indexes: number[]) {
    if (uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    try {
      for (const index of indexes) {
        const item = items[index];
        const file = item.file;
        setUploads((current) => current.map((row, i) => i === index ? { ...row, status: "uploading", progress: 0, error: undefined } : row));
        try {
          const entries = await loadQueue();
          const queued = entries.find((entry) => entry.kind === "upload" && entry.id === item.id);
          const assetId = queued && queued.kind === "upload" ? queued.assetId : undefined;
          if (!queued) {
            // A retry of a row that failed online still needs its queue slot so an
            // offline retry is durable rather than only announced.
            await saveQueue([...entries, {
              kind: "upload",
              id: item.id,
              projectId,
              uri: file.path,
              name: file.name,
              mimeType: file.contentType,
              size: file.size,
              createdAt: Date.now(),
            }]);
          }
          await uploadFile(client, projectId, file, (progress) => setUploads((current) => current.map((row, i) => i === index ? { ...row, progress } : row)), {
            assetId,
            onAsset: (id) => {
              void (async () => {
                const stored = await loadQueue();
                await saveQueue(stored.map((entry) => entry.kind === "upload" && entry.id === item.id ? { ...entry, assetId: id } : entry));
              })().catch(() => undefined);
            },
          });
          await saveQueue((await loadQueue()).filter((entry) => entry.id !== item.id));
          setUploads((current) => current.map((row, i) => i === index ? { ...row, status: "done", progress: 100 } : row));
        } catch (reason) {
          const failedFile = reason instanceof UploadError ? reason.file : file;
          const offline = isOfflineError(reason) || (reason instanceof UploadError && reason.offline);
          if (!offline) await saveQueue((await loadQueue()).filter((entry) => entry.id !== item.id));
          setUploads((current) => current.map((row, i) => i === index ? {
            ...row,
            file: failedFile,
            status: "failed",
            error: offline ? "已保存，联网后自动重试。" : message(reason, "上传失败"),
          } : row));
        }
      }
      await load();
      setUploads((current) => current.filter((item) => item.status !== "done"));
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  }

  async function upload() {
    if (selectLock.current || uploadLock.current) return;
    selectLock.current = true;
    try {
      const files = await chooseMedia();
      const failed = uploads.filter((item) => item.status === "failed");
      const pending: UploadItem[] = [];
      for (const file of files) {
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await enqueue({
          kind: "upload",
          id,
          projectId,
          uri: file.path,
          name: file.name,
          mimeType: file.contentType,
          size: file.size,
          createdAt: Date.now(),
        });
        pending.push({ id, file, progress: 0, status: "waiting" });
      }
      const items = [...failed, ...pending];
      setUploads(items);
      await runUploads(items, pending.map((_, index) => failed.length + index));
    } catch (reason) {
      if (reason instanceof UploadSelectionError && reason.cancelled) return;
      setError(message(reason, "选择文件失败"));
    } finally {
      selectLock.current = false;
    }
  }

  async function createJob() {
    if (createLock.current || !selected.length) return;
    const chosen = (detail?.assets ?? []).filter((asset) => selected.includes(asset.id));
    if (chosen.length !== selected.length || chosen.some((asset) => asset.status !== "READY")) {
      setError("部分素材尚未就绪，请重新选择");
      return;
    }
    if (new Set(chosen.map((asset) => isVideo(asset.filename))).size > 1) {
      setError("同一任务不能混合图片与视频，请重新选择");
      return;
    }
    createLock.current = true;
    setCreating(true);
    try {
      const created = await client.createJob(projectId, profile, selected);
      setJob(created);
      setSelected([]);
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
        content: action === "cancel" ? "确定取消当前重建任务？" : "确定重试当前任务？已完成的产物不会被复用。",
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
    if (!address) { setError("请输入成员邮箱"); return; }
    try {
      const result = await client.addMember(projectId, address, memberRole);
      setEmail("");
      if (result.status === "invited") setNotice(`已邀请 ${result.email}，对方注册后自动加入。`);
      else await loadMembers();
    } catch (reason) { setError(message(reason, "添加成员失败")); }
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
    shareLock.current = true;
    setSharing(true);
    try {
      const share = await client.createShare(reconstructionId, expires);
      setShareToken(share.token);
      setShareUrl(`${webBaseUrl.replace(/\/+$/, "")}/share/${encodeURIComponent(share.token)}`);
      await loadShares();
    } catch (reason) { setError(message(reason, "创建分享失败")); }
    finally { shareLock.current = false; setSharing(false); }
  }

  async function revokeShare(id: string) {
    const result = await Taro.showModal({ title: "撤销分享", content: "撤销后该链接将无法访问。" });
    if (!result.confirm) return;
    try { await client.revokeShare(id); setShareUrl(""); setShareToken(""); await loadShares(); }
    catch (reason) { setError(message(reason, "撤销分享失败")); }
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

  function toggle(asset: Asset) {
    if (!canWrite || asset.status !== "READY") return;
    if (selected.includes(asset.id)) {
      setSelected((current) => current.filter((id) => id !== asset.id));
      return;
    }
    const first = detail?.assets.find((item) => item.id === selected[0]);
    if (first && isVideo(first.filename) !== isVideo(asset.filename)) {
      setError("同一任务不能混合图片与视频，请先取消已选素材");
      return;
    }
    setSelected((current) => [...current, asset.id]);
  }

  async function removeAsset(asset: Asset) {
    const result = await Taro.showModal({ title: "删除素材", content: `确定删除「${asset.filename}」？` });
    if (!result.confirm) return;
    try {
      await client.deleteAsset(asset.id);
      setSelected((current) => current.filter((id) => id !== asset.id));
      await load();
    } catch (reason) { setError(message(reason, "删除失败，请稍后重试。")); }
  }

  return (
    <Screen>
      <Text className="title">{detail?.name ?? "项目"}</Text>
      {detail && role ? <View className="project-heading">
        <Text className="muted">{EFFECTIVE_ROLE_LABEL[role]} · {detail.assets.length} 个素材</Text>
        <Button className="button ghost compact" aria-expanded={showManagement} onClick={() => setShowManagement((value) => !value)}>
          {showManagement ? "收起管理" : canManage ? "项目管理" : "查看成员"}
        </Button>
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
          <Button className="button" onClick={addMember}>添加成员</Button>
        </View> : null}
      </View> : null}
      {detail ? <View className="card">
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
          {item.status === "failed" ? <Button className="button ghost" disabled={uploading} onClick={() => void runUploads(uploads, [index])}>重试上传</Button> : null}
        </View>)}
        {!detail.assets.length && !uploads.length ? <Text className="muted">暂无素材</Text> : null}
        {canWrite && detail.assets.length > 0 ? <View className="selection-tools">
          <Button className="button ghost compact" onClick={() => setSelected(detail.assets.filter((asset) => asset.status === "READY" && /\.(jpe?g|png)$/i.test(asset.filename)).map((asset) => asset.id))}>全选图片</Button>
          <Button className="button ghost compact" disabled={!selected.length} onClick={() => setSelected([])}>清空选择</Button>
        </View> : null}
        {detail.assets.slice(0, visibleAssets).map((asset) => <View className={`row asset-row${selected.includes(asset.id) ? " selected" : ""}`} key={asset.id}>
          <AssetThumbnail asset={asset} />
          <View className="asset-choice" role={canWrite ? "checkbox" : undefined} aria-checked={canWrite ? selected.includes(asset.id) : undefined} aria-disabled={!canWrite || asset.status !== "READY"} onClick={() => toggle(asset)}>
            <Text>{asset.filename}</Text>
            <Text className="muted">{selected.includes(asset.id) ? "已选" : ASSET_STATUS_LABELS[asset.status]}</Text>
          </View>
          {canWrite ? <Button className="button ghost compact danger-action" aria-label={`删除 ${asset.filename}`} onClick={() => void removeAsset(asset)}>删除</Button> : null}
        </View>)}
        {detail.assets.length > visibleAssets ? <Button className="button ghost" onClick={() => setVisibleAssets((count) => count + 24)}>加载更多素材（{visibleAssets}/{detail.assets.length}）</Button> : null}
      </View> : null}
      {canWrite ? <View className="card">
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
        <Button className="button" disabled={creating || !selected.length || uploading} loading={creating} onClick={createJob}>
          {selected.length ? `开始重建（${selected.length}）` : "开始重建"}
        </Button>
        {!selected.length ? <Text className="muted">请先从素材列表选择要重建的文件</Text> : null}
      </View> : null}
      {detail ? <View className="card">
        <Text className="section-heading">重建任务</Text>
        {jobs.map((item) => <Button className={`button route-option${job?.id === item.id ? " selected" : ""}`} aria-pressed={job?.id === item.id} key={item.id} onClick={() => setJob(item)}>
          <Text className="label">{RECONSTRUCTION_PROFILES[item.profile].title} · {JOB_STATUS_LABELS[item.status]}</Text>
          <Text className="muted">{new Date(item.created_at).toLocaleString()} · {item.id.slice(0, 8)}</Text>
        </Button>)}
        {job ? <View className="task-detail">
          <Text className={job.status === "SUCCEEDED" ? "success-state" : job.status === "FAILED" ? "error" : "label"}>{JOB_STATUS_LABELS[job.status]} · 第 {job.attempt} 次</Text>
          <Text className="muted">{stageLabel(job.current_stage)} · {Math.round(job.progress * 100)}%</Text>
          <Progress percent={Math.round(job.progress * 100)} strokeWidth={5} borderRadius={6} activeColor="#7c9bff" backgroundColor="#07080c" />
          <Text className="muted">更新于 {new Date(job.updated_at).toLocaleString()}</Text>
          {timeline.map((row) => <View key={row.key}>
            <Text className="muted">{stageLabel(row.stage)} · {row.status} · {Math.round(row.progress * 100)}%</Text>
            {row.message ? <Text className="muted">{row.message}</Text> : null}
            {Object.keys(row.metrics).length > 0 ? <Text className="muted">{JSON.stringify(row.metrics)}</Text> : null}
          </View>)}
          {job.status === "QUEUED" ? <Text className="muted">任务已排队，Worker 上线或前序任务结束后会自动开始；这不是失败。</Text> : null}
          {job.error_message ? <Text className="error">{job.error_code ? `${job.error_code}: ` : ""}{job.error_message}</Text> : null}
          {canWrite && ACTIVE[job.status] ? <Button className="button ghost" disabled={jobBusy} loading={jobBusy} onClick={() => void changeJob("cancel")}>取消任务</Button> : null}
          {canWrite && (job.status === "FAILED" || job.status === "CANCELLED") ? <Button className="button ghost" disabled={jobBusy} loading={jobBusy} onClick={() => void changeJob("retry")}>重试任务</Button> : null}
          {reconstructionId ? <Button className="button" onClick={() => void Taro.navigateTo({ url: `/pages/viewer/index?id=${encodeURIComponent(reconstructionId)}` })}>打开三维场景</Button> : null}
        </View> : <Text className="muted">暂无任务</Text>}
      </View> : null}
      {job ? <View className="card">
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
          {logs.map((row) => <Text className="log" key={row.id}>{row.created_at} · {row.level} · {row.message}</Text>)}
        </> : null}
      </View> : null}
      {canWrite && reconstructionId ? <View className="card">
        <Text className="label">分享</Text>
        <Text className="label">分享有效期</Text>
        {SHARE_PRESETS.map((preset) => <Text className={`row profile ${sharePreset === preset.value ? "active" : ""}`} key={preset.value} onClick={() => setSharePreset(preset.value)}>{sharePreset === preset.value ? "● " : "○ "}{preset.label}</Text>)}
        <Button className="button" loading={sharing} disabled={sharing} onClick={createShare}>创建分享</Button>
        {shareUrl ? <View>
          <Text className="muted">链接仅在创建时显示，请及时复制；复制后可粘贴到微信会话发送。</Text>
          <Button className="button ghost" onClick={copyShare}>复制新链接</Button>
          {shareToken && apiBaseUrl ? <Image className="qr" src={client.shareQrUrl(shareToken)} mode="aspectFit" /> : null}
          {shareToken ? <Button className="button ghost" onClick={() => void Taro.navigateTo({ url: `/pages/viewer/index?share=${encodeURIComponent(shareToken)}` })}>在小程序内预览分享</Button> : null}
          <Text className="muted">可在“三维场景”页右上角菜单转发小程序链接；普通网页链接需接收方在浏览器打开。</Text>
        </View> : null}
        {shares.map((share) => <View className="row" key={share.id}>
          <Text>{share.id} · {share.revoked_at ? `已撤销 ${share.revoked_at}` : `有效期 ${share.expires_at ?? "不限"}`}</Text>
          {!share.revoked_at ? <Button className="button ghost" onClick={() => void revokeShare(share.id)}>撤销</Button> : null}
        </View>)}
      </View> : null}
    </Screen>
  );
}
