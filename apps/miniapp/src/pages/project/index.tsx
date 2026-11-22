import { Screen, WorkspaceEntry } from "../../screen";
import { AssetThumbnail } from "../../asset-thumbnail";
import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, PROJECT_SECTIONS, RECONSTRUCTION_PROFILES, reconcileWorkspaceSelection, selectWorkspaceAssets, selectionBytes } from "@rescene/schemas";
import type { Asset, Job, Profile, ProjectSection, ProjectWorkspace, WorkerStatus } from "@rescene/schemas";
import { isQueuedMediaMissing, MediaPreflightError, newIdempotencyKey, QUEUE_PAUSED, summarizeMediaWarnings, type QueueOwner } from "@rescene/uploader";
import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useReady, useRouter } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { assertQueueOwner, client, currentQueueOwner, isQueueOwnerCurrent, onSessionExpired } from "../../api";
import { consumeMaterialsReturn } from "../../navigation";
import { discardQueued, enqueue, replayQueued, uploadQueued } from "../../queue";
import { ConfigureForm, type ConfigureState } from "../focus/configure";
import { chooseMedia, inspectChosenFiles, persistChosenFile, removeManagedMedia, UploadError, UploadSelectionError, MINIAPP_FILE_COUNT, MINIAPP_FILE_LIMIT, type ChosenFile } from "../../upload";

type UploadItem = { owner: QueueOwner; id: string; file: ChosenFile; progress: number; status: "waiting" | "uploading" | "failed" | "done"; error?: string };
type PageCandidate = { kind: "assets" | "jobs"; stack: string[]; projectId: string };
type Channel = { emit: (name: string, data: ConfigureState) => void };
const profiles: Profile[] = ["fast", "balanced", "quality"];
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
  const projectId = params.id ?? "";
  const [section, setSection] = useState<ProjectSection>(params.view === "tasks" ? "tasks" : "materials");
  const requestedJob = useRef(params.job);
  const [assetPages, setAssetPages] = useState([""]);
  const [jobPages, setJobPages] = useState([""]);
  const assetPagesRef = useRef(assetPages);
  const jobPagesRef = useRef(jobPages);
  const candidate = useRef<PageCandidate | null>(null);
  const [pendingPage, setPendingPage] = useState<PageCandidate | null>(null);
  const [failedPage, setFailedPage] = useState<PageCandidate | null>(null);
  const requestId = useRef(0);
  const alive = useRef(true);
  const [detail, setDetail] = useState<ProjectWorkspace | null>(null);
  const [selected, setSelected] = useState<Asset[]>([]);
  const [profile, setProfile] = useState<Profile>("balanced");
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdJob, setCreatedJob] = useState<string | null>(null);
  const [configureError, setConfigureError] = useState("");
  const [configureBlocked, setConfigureBlocked] = useState(false);
  const [inlineConfigure, setInlineConfigure] = useState(false);
  const [barHeight, setBarHeight] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const firstShow = useRef(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const createLock = useRef(false);
  const jobAttempt = useRef<{ signature: string; key: string } | null>(null);
  const selectLock = useRef(false);
  const uploadLock = useRef(false);
  const channel = useRef<Channel | null>(null);
  const inlineConfigureRef = useRef(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const role = detail?.effective_role;
  const canWrite = role === "owner" || role === "admin" || role === "member";
  const owner = currentQueueOwner();
  const configureState: ConfigureState = {
    chosenCount: selected.length, byteCount: selectionBytes(selected), profile,
    workerOnline: worker?.online ?? null, submitting: creating,
    canSubmit: Boolean(owner && canWrite && selected.length && !uploading && !creating && !createdJob && !configureBlocked),
    error: configureError, jobId: createdJob,
  };
  const stateRef = useRef(configureState);
  stateRef.current = configureState;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const canWriteRef = useRef(canWrite); canWriteRef.current = canWrite;
  const uploadingRef = useRef(uploading); uploadingRef.current = uploading;
  const createdRef = useRef(createdJob); createdRef.current = createdJob;
  useEffect(() => { channel.current?.emit("configure-state", configureState); }, [selected, profile, worker, creating, canWrite, uploading, createdJob, configureError, configureBlocked]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestId.current += 1;
      candidate.current = null;
      channel.current = null;
      inlineConfigureRef.current = false;
    };
  }, [projectId]);

  function showSection(next: ProjectSection) {
    setSection(next);
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => undefined);
  }
  const measureBar = useCallback(() => {
    if (section !== "materials") { setBarHeight(null); return; }
    try {
      Taro.nextTick(() => {
        try {
          Taro.createSelectorQuery().select("#selection-bar").boundingClientRect().exec((results) => {
            const height = (results as { height?: number }[] | undefined)?.[0]?.height;
            setBarHeight(typeof height === "number" && height > 0 ? height : null);
          });
        } catch { setBarHeight(null); }
      });
    } catch { setBarHeight(null); }
  }, [section]);
  useReady(measureBar);
  useEffect(() => { measureBar(); }, [measureBar, selected.length]);
  const load = useCallback(async () => {
    if (!projectId) return;
    const request = ++requestId.current;
    const pending = candidate.current;
    const assetStack = pending?.kind === "assets" ? pending.stack : assetPagesRef.current;
    const jobStack = pending?.kind === "jobs" ? pending.stack : jobPagesRef.current;
    const requestOwner = currentQueueOwner();
    try {
      const value = await client.getWorkspace(projectId, assetStack[assetStack.length - 1], jobStack[jobStack.length - 1]);
      if (!alive.current || projectRef.current !== projectId || request !== requestId.current || candidate.current !== pending || (requestOwner && !isQueueOwnerCurrent(requestOwner))) return;
      setDetail(value);
      setSelected((current) => reconcileWorkspaceSelection(current, value.assets));
      if (pending) {
        if (pending.kind === "assets") { assetPagesRef.current = pending.stack; setAssetPages(pending.stack); }
        else { jobPagesRef.current = pending.stack; setJobPages(pending.stack); }
        candidate.current = null; setPendingPage(null); setFailedPage(null);
        void Taro.pageScrollTo({ selector: pending.kind === "assets" ? "#materials-list" : "#jobs-list", duration: 0 }).catch(() => undefined);
      }
      setError("");
      const target = requestedJob.current;
      if (target) {
        requestedJob.current = undefined;
        try {
          const targetJob = value.jobs.find((item) => item.id === target) ?? await client.getJob(target);
          if (!alive.current || projectRef.current !== projectId || request !== requestId.current || (requestOwner && !isQueueOwnerCurrent(requestOwner))) return;
          if (targetJob.project_id !== projectId) { setError("任务不属于此项目，请从任务列表选择。"); return; }
          setSection("tasks");
          await Taro.navigateTo({ url: focusUrl("job", targetJob.id) });
        } catch { if (alive.current) setError("无法打开指定任务，请从任务列表重试。"); }
      }
    } catch (reason) {
      if (!alive.current || projectRef.current !== projectId || request !== requestId.current || candidate.current !== pending || (requestOwner && !isQueueOwnerCurrent(requestOwner))) return;
      if (pending) { candidate.current = null; setPendingPage(null); setFailedPage(pending); }
      if (reason instanceof ResceneApiError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) { setDetail(null); setSelected([]); setError(message(reason, "加载项目失败")); }
      else setError(pending ? '无法加载第 ' + pending.stack.length + ' 页' : message(reason, "加载项目失败"));
    }
  }, [projectId]);
  function focusUrl(view: string, jobId?: string) {
    return '/pages/focus/index?id=' + encodeURIComponent(projectId) + '&view=' + view + (jobId ? '&job=' + encodeURIComponent(jobId) : '');
  }
  async function openFocus(view: string, jobId?: string): Promise<boolean> {
    try { await Taro.navigateTo({ url: focusUrl(view, jobId) }); return true; }
    catch { void Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }); return false; }
  }
  const loadWorker = useCallback(async () => {
    try { const value = await client.getWorkerStatus(); if (alive.current) setWorker(value); }
    catch { if (alive.current) setWorker(null); }
  }, []);
  useEffect(() => { if (visible) void load(); }, [load, visible]);
  useDidShow(() => {
    const resumed = !firstShow.current && visible;
    firstShow.current = false;
    setVisible(true);
    channel.current = null;
    const current = currentQueueOwner();
    if (current && consumeMaterialsReturn(projectId, current.id)) { setSection("materials"); setError(""); }
    if (current) void replayQueued(current, () => undefined).then(({ uploaded }) => { if (uploaded && isQueueOwnerCurrent(current)) void load(); }).catch((reason) => { if (isQueueOwnerCurrent(current)) setError(message(reason, "同步离线上传失败")); });
    if (resumed) void load();
  });
  useDidHide(() => { setVisible(false); });
  useEffect(() => onSessionExpired(() => { setUploads([]); setSelected([]); setNotice(""); channel.current = null; inlineConfigureRef.current = false; }), []);

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


  async function createJob(chosenProfile: Profile) {
    const currentOwner = currentQueueOwner();
    const assets = selectedRef.current;
    if (createLock.current || createdRef.current) return;
    if (!profiles.includes(chosenProfile) || !currentOwner || !canWriteRef.current || !assets.length || uploadingRef.current) {
      setConfigureError("选材、权限或上传状态已变化，请返回素材检查后重试。"); return;
    }
    createLock.current = true;
    setProfile(chosenProfile); setConfigureError(""); setConfigureBlocked(false); setCreating(true);
    const ids = assets.map((asset) => asset.id);
    const signature = JSON.stringify([chosenProfile, [...ids].sort()]);
    const attempt = jobAttempt.current?.signature === signature ? jobAttempt.current : { signature, key: newIdempotencyKey() };
    jobAttempt.current = attempt;
    try {
      const result = await client.createJob(projectId, chosenProfile, ids, attempt.key);
      if (!alive.current || projectRef.current !== projectId || !isQueueOwnerCurrent(currentOwner)) return;
      jobAttempt.current = null;
      createdRef.current = result.id; setCreatedJob(result.id); setSection("tasks");
      setNotice("任务已创建");
      if (inlineConfigureRef.current) {
        const opened = await openFocus("job", result.id);
        if (opened) { inlineConfigureRef.current = false; setInlineConfigure(false); }
      }
      void load();
    } catch (reason) {
      if (alive.current && projectRef.current === projectId && isQueueOwnerCurrent(currentOwner)) {
        setConfigureError(message(reason, "创建任务失败"));
        if (reason instanceof ResceneApiError && (reason.status === 403 || reason.status === 404 || reason.status === 422)) setConfigureBlocked(true);
      }
    } finally {
      createLock.current = false;
      if (alive.current && projectRef.current === projectId && isQueueOwnerCurrent(currentOwner)) setCreating(false);
    }
  }
  const createRef = useRef(createJob); createRef.current = createJob;
  function pickProfile(value: Profile) { if (profiles.includes(value)) setProfile(value); }
  async function openConfigure() {
    if (!canWrite || !selected.length || uploading || creating) return;
    channel.current = null;
    setCreatedJob(null); createdRef.current = null; setConfigureError(""); setConfigureBlocked(false); setNotice("");
    void loadWorker();
    let supported = false;
    try { supported = Taro.canIUse("EventChannel"); } catch { supported = false; }
    if (!supported) { inlineConfigureRef.current = true; setInlineConfigure(true); return; }
    try {
      await Taro.navigateTo({
        url: focusUrl("configure"),
        events: {
          "configure-ready": () => channel.current?.emit("configure-state", stateRef.current),
          "configure-pick": (data: { profile: Profile }) => pickProfile(data?.profile),
          "configure-submit": (data: { profile: Profile }) => { void createRef.current(data?.profile); },
          "configure-close": () => { channel.current = null; },
        },
        success: (result) => {
          if (result.eventChannel && typeof result.eventChannel.emit === "function") {
            channel.current = result.eventChannel;
            channel.current.emit("configure-state", stateRef.current);
          } else {
            void Taro.navigateBack().then(() => { inlineConfigureRef.current = true; setInlineConfigure(true); }).catch(() => { void Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }); });
          }
        },
      });
    } catch { channel.current = null; void Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }); }
  }
  function choose(assets: Asset[], imagesOnly = false) {
    try { setSelected(selectWorkspaceAssets(selected, assets, imagesOnly)); setError(""); }
    catch (reason) { void Taro.showModal({ title: "无法选择素材", content: message(reason, "请检查已选素材"), showCancel: false }); }
  }
  function movePage(next: PageCandidate) {
    if (candidate.current || next.projectId !== projectId) return;
    candidate.current = next; setPendingPage(next); setFailedPage(null); setError("");
    void load();
  }
  function pageControls(kind: "assets" | "jobs", next: string | null) {
    const pages = kind === "assets" ? assetPages : jobPages;
    if (pages.length === 1 && !next && !pendingPage && !failedPage) return null;
    return <View className="page-controls">
      <Button className="button ghost compact" disabled={Boolean(pendingPage) || pages.length === 1} onClick={() => movePage({ kind, stack: pages.slice(0, -1), projectId })}>上一页</Button>
      <Text className="muted">第 {pages.length} 页</Text>
      <Button className="button ghost compact" disabled={Boolean(pendingPage) || !next || pages.includes(next)} onClick={() => { if (next && !pages.includes(next)) movePage({ kind, stack: [...pages, next], projectId }); }}>下一页</Button>
      {pendingPage?.kind === kind ? <Text className="muted">正在加载第 {pendingPage.stack.length} 页…</Text> : null}
    </View>;
  }
  async function removeAsset(asset: Asset) {
    const result = await Taro.showModal({ title: "删除素材", content: '确定删除「' + asset.filename + '」？' });
    if (!result.confirm) return;
    try { await client.deleteAsset(asset.id); setSelected((current) => current.filter((item) => item.id !== asset.id)); await load(); }
    catch (reason) { setError(message(reason, "删除失败，请稍后重试。")); }
  }
  if (inlineConfigure) {
    const back = () => { inlineConfigureRef.current = false; setInlineConfigure(false); };
    return <Screen>
      {configureState.chosenCount ? <ConfigureForm state={configureState} onPick={pickProfile} onSubmit={(value) => void createJob(value)} onBack={back} onOpenJob={() => { if (createdJob) void openFocus("job", createdJob).then((opened) => { if (opened) back(); }); }} />
        : <><Text className="error">无法恢复选材，请返回素材重新选择。</Text><Button className="button ghost" onClick={back}>返回素材</Button></>}
    </Screen>;
  }
  const jobs = detail?.jobs ?? [];
  const displayedJobs = section === "results" ? jobs.filter((item) => item.status === "SUCCEEDED" && item.reconstruction_id) : jobs;
  return <Screen>
    <View className="project-heading">
      <Text className="title">{detail?.name ?? "项目"}</Text>
      <View className="project-nav">
        <Button className="button ghost compact" onClick={() => void openFocus("notifications")}>通知</Button>
        <Button className="button ghost compact" onClick={() => void openFocus("settings")}>设置</Button>
      </View>
    </View>
    {detail ? <>
      <View className="project-heading">
        <Text className="muted">{detail.asset_count} 个素材 · {detail.job_count} 个任务</Text>
        <Button className="button ghost compact" onClick={() => void openFocus("project-management")}>{role === "owner" || role === "admin" ? "项目管理" : "查看成员"}</Button>
      </View>
      <View className="segmented project-sections">{PROJECT_SECTIONS.map(({ value, label }) => <Button key={value} className={'button tab' + (section === value ? ' active' : '')} aria-pressed={section === value} onClick={() => showSection(value)}>{label}</Button>)}</View>
    </> : null}
    {!projectId ? <Text className="error">缺少项目参数，请返回项目列表重新打开。</Text> : null}
    {projectId && !detail && !error ? <Text className="muted">加载中…</Text> : null}
    {error ? <View>
      <Text className="error">{error}</Text>
      <Button className="button ghost" onClick={() => failedPage ? movePage(failedPage) : void load()}>{failedPage ? "重试翻页" : "重试加载"}</Button>
    </View> : null}
    {notice ? <View><Text>{notice}</Text>{createdJob ? <Button className="button ghost" onClick={() => void openFocus("job", createdJob)}>查看任务</Button> : null}</View> : null}
    {configureError && !inlineConfigure ? <View className="card"><Text className="error">{configureError}</Text><Button className="button ghost" onClick={() => void openConfigure()}>重新配置</Button></View> : null}
    {detail && !canWrite ? <Text className="muted">你在此项目中只有查看权限，无法选择素材或创建任务。</Text> : null}
    {detail && section === "materials" ? <View id="materials-list">
      <View className="project-heading"><Text className="section-heading">素材</Text></View>
      {canWrite ? <><Button className="button" disabled={uploading} onClick={upload}>选择图片或视频</Button><Text className="muted">每次最多 {MINIAPP_FILE_COUNT} 个，单文件 ≤ {MINIAPP_FILE_LIMIT / 1024 / 1024} MiB。同一任务可选一组 JPG / PNG 或一个视频。</Text></> : null}
      {uploads.map((item, index) => <View className="row" key={item.id}><Text>{item.file.name} · {item.status === "failed" ? item.error : item.progress + "%"}</Text>{item.status === "failed" ? <><Button className="button ghost" disabled={uploading} onClick={() => void runUploads(item.owner, uploads, [index])}>重试上传</Button><Button className="button ghost" disabled={uploading} onClick={() => void abandonUpload(item)}>移除此项</Button></> : null}</View>)}
      {!detail.assets.length && !uploads.length ? <Text className="muted">暂无素材</Text> : null}
      {canWrite && detail.assets.some((asset) => asset.status === "READY") ? <View className="selection-tools"><Button className="button ghost compact" onClick={() => choose(detail.assets, true)}>全选本页图片</Button><Button className="button ghost compact" disabled={!selected.length} onClick={() => setSelected([])}>清空选择</Button></View> : canWrite && detail.assets.length ? <Text className="muted">本页没有可选择的素材。</Text> : null}
      <View className="asset-grid">{detail.assets.map((asset) => <View className={'asset-tile' + (selected.some((item) => item.id === asset.id) ? ' selected' : '')} key={asset.id}>
        <AssetThumbnail asset={asset} /><View className="asset-choice" role={canWrite ? "checkbox" : undefined} aria-checked={canWrite ? selected.some((item) => item.id === asset.id) : undefined} aria-disabled={!canWrite || asset.status !== "READY"} onClick={() => { if (canWrite && asset.status === "READY") choose([asset]); }}><Text>{asset.filename}</Text><Text className="muted">{selected.some((item) => item.id === asset.id) ? "已选" : ASSET_STATUS_LABELS[asset.status]}</Text></View>
        {canWrite ? <Button className="button ghost compact danger-action" aria-label={'删除 ' + asset.filename} onClick={() => void removeAsset(asset)}>删除</Button> : null}</View>)}</View>
      {pageControls("assets", detail.nextAssetCursor)}
    </View> : null}
    {detail && section !== "materials" ? <View id="jobs-list">
      <Text className="section-heading">{section === "tasks" ? "任务" : "结果"}</Text>
      {section === "results" ? <Text className="muted">结果按任务页显示。</Text> : null}
      {displayedJobs.map((item: Job) => <Button className="button route-option" key={item.id} onClick={() => void openFocus(section === "tasks" ? "job" : "result", item.id)}><Text className="label">{RECONSTRUCTION_PROFILES[item.profile].title} · {JOB_STATUS_LABELS[item.status]}</Text><Text className="muted">{new Date(item.created_at).toLocaleString()} · {item.id.slice(0, 8)}</Text></Button>)}
      {!displayedJobs.length ? <View><Text className="muted">{section === "results" ? "本页暂无重建结果" : "本页暂无任务"}</Text>{section === "results" ? <Button className="button ghost" onClick={() => showSection("tasks")}>查看任务</Button> : null}</View> : null}
      {pageControls("jobs", detail.nextJobCursor)}
    </View> : null}
    {canWrite && detail && section === "materials" ? <>
      {barHeight !== null ? <View className="selection-spacer" style={{ height: barHeight + "px" }} /> : null}
      <View id="selection-bar" className={'selection-bar' + (barHeight === null ? ' inline' : '')}><Text className="label">已选 {selected.length} 个</Text><Button className="button" disabled={!selected.length || uploading} onClick={() => void openConfigure()}>配置重建</Button></View>
    </> : null}
  </Screen>;
}
