import { explainError } from "@rescene/api-client";
import { JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, canRetryJob, jobErrorHint, queuedJobHint, stageLabel } from "@rescene/schemas";
import type { Artifact, Job, JobLog, ShareSummary } from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Linking, Share, View } from "react-native";

import { client, currentQueueOwner, isQueueOwnerCurrent, queueClient, webBaseUrl } from "../api";
import { useAppearance } from "../appearance";
import { Button, Card, ScaledText as Text, Screen, Segmented, useTextStyles } from "../ui";

const ACTIVE: Record<string, true> = { QUEUED: true, LEASED: true, RUNNING: true };
const LOG_POLL_MS = 3000;
const LOG_PAGE_SIZE = 200;

type LogLevel = "all" | "debug" | "info" | "warning" | "error";
const LOG_LEVELS: { value: LogLevel; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "debug", label: "调试" },
  { value: "info", label: "信息" },
  { value: "warning", label: "警告" },
  { value: "error", label: "错误" },
];
const LOG_TAG: Record<JobLog["level"], string> = { debug: "调试", info: "信息", warning: "警告", error: "错误" };


type TimelineRow = { key: string; stage: string; status: string; progress: number; message?: string | null; metrics: Record<string, unknown> };
type SharePreset = "never" | "1d" | "7d" | "30d";
const SHARE_PRESETS: { value: SharePreset; label: string; ms: number | null }[] = [
  { value: "never", label: "永久", ms: null },
  { value: "1d", label: "1 天", ms: 86_400_000 },
  { value: "7d", label: "7 天", ms: 604_800_000 },
  { value: "30d", label: "30 天", ms: 2_592_000_000 },
];

export function JobScreen({ jobId, page, backLabel = "返回", onNavigate, onOpenScene, onReplaceAssets, onBack }: {
  jobId: string;
  page: "job" | "job-logs" | "result" | "downloads" | "shares" | null;
  backLabel?: string;
  onNavigate: (page: "job-logs" | "result" | "downloads" | "shares") => void;
  onOpenScene: (reconstructionId: string) => void;
  onReplaceAssets: (project: { id: string; name: string }) => void;
  onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const LOG_TEXT = {
    color: theme.muted,
    fontSize: 14,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  } as const;
  const [job, setJob] = useState<Job | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [writer, setWriter] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharePreset, setSharePreset] = useState<SharePreset>("7d");
  const [shareToken, setShareToken] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [resultRevision, setResultRevision] = useState(0);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>("all");
  const [logError, setLogError] = useState<{ message: string; direction: "initial" | "tail" | "earlier" } | null>(null);
  const [logRevision, setLogRevision] = useState(0);
  const [tailRevision, setTailRevision] = useState(0);
  const [logReady, setLogReady] = useState(false);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const logTail = useRef(0);
  const earlierPending = useRef<number | null>(null);
  const logGeneration = useRef(0);

  useEffect(() => {
    logGeneration.current += 1;
    return () => { logGeneration.current += 1; };
  }, [jobId, page, logLevel, logRevision]);

  useEffect(() => {
    let active = true;
    let receivedSnapshot = false;
    setJob(null); setArtifacts([]); setShares([]); setWriter(false);
    void client.getJob(jobId).then(async (value) => {
      if (!active) return;
      if (!receivedSnapshot) setJob(value);
      const project = await client.getProjectSummary(value.project_id);
      if (active) setWriter(project.effective_role !== "viewer");
    }).catch((reason: unknown) => { if (active) setError(explainError(reason, "操作失败，请检查网络后重试")); });
    const stop = client.subscribeJob(jobId, (event) => {
      if (!active) return;
      if ("stage" in event) {
        setJob((current) => current ? { ...current, progress: event.progress, current_stage: event.stage } : current);
        setTimeline((current) => [...current, { key: `live-${Date.now()}-${event.stage}`, stage: event.stage, status: event.status, progress: event.progress, message: event.message, metrics: event.metrics }].slice(-100));
      } else { receivedSnapshot = true; setJob(event); }
    }, (reason) => { if (active) setError(reason.message); }, { transport: "polling" });
    return () => { active = false; stop(); };
  }, [jobId, reload]);

  useEffect(() => {
    if (page !== "job" || job?.status !== "QUEUED") return;
    let active = true;
    async function refreshWorker() {
      const status = await client.getWorkerStatus().catch(() => null);
      if (active) setOnline(status?.online ?? null);
    }
    setOnline(null);
    void refreshWorker();
    const timer = setInterval(() => void refreshWorker(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, page, job?.status]);

  useEffect(() => { setShareToken(""); setTimeline([]); }, [jobId]);
  useEffect(() => { setError(""); }, [page]);

  useEffect(() => {
    let active = true;
    void client.getJobStages(jobId).then((rows) => {
      if (!active) return;
      const persisted = rows.map((row) => ({ key: row.id, stage: row.stage, status: row.status, progress: row.progress, message: row.message, metrics: row.metrics }));
      // Persisted rows win; a live stage the server has not stored yet stays visible.
      setTimeline((current) => [
        ...persisted,
        ...current.filter((row) => row.key.startsWith("live-") && !persisted.some((item) => item.stage === row.stage && item.status === row.status)),
      ].slice(-100));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [jobId, job?.current_stage, job?.status]);

  const jobStatus = job?.status;

  // Newest slice for the current level; the tail marks where polling resumes.
  useEffect(() => {
    if (page !== "job-logs") return;
    let active = true;
    const generation = logGeneration.current;
    const owner = currentQueueOwner();
    setLogError(null);
    logTail.current = 0;
    setLogReady(false);
    setEarlierBusy(false);
    setLogs([]);
    setHasEarlier(false);
    if (!owner) return;
    const level = logLevel === "all" ? undefined : logLevel;
    void queueClient(owner).listJobLogs(jobId, { limit: LOG_PAGE_SIZE, level }).then((rows) => {
      if (!active || generation !== logGeneration.current || !isQueueOwnerCurrent(owner)) return;
      logTail.current = rows.at(-1)?.id ?? 0;
      setLogs(rows);
      setHasEarlier(rows.length >= LOG_PAGE_SIZE);
      setLogReady(true);
    }).catch((reason: unknown) => {
      if (active && generation === logGeneration.current && isQueueOwnerCurrent(owner)) {
        setLogError({ message: explainError(reason, "加载运行日志失败"), direction: "initial" });
      }
    });
    return () => { active = false; };
  }, [jobId, logLevel, page, logRevision]);

  useEffect(() => {
    const owner = currentQueueOwner();
    if (!owner || page !== "job-logs" || !jobStatus || !logReady) return;
    let active = true;
    let polling = false;
    const generation = logGeneration.current;
    const level = logLevel === "all" ? undefined : logLevel;
    async function poll() {
      if (!active || polling || !owner || !isQueueOwnerCurrent(owner)) return;
      polling = true;
      try {
        const rows = await queueClient(owner).listJobLogs(jobId, { afterId: logTail.current, limit: LOG_PAGE_SIZE, level });
        if (!active || generation !== logGeneration.current || !isQueueOwnerCurrent(owner)) return;
        const tail = logTail.current;
        const fresh = rows.filter((row) => row.id > tail);
        if (fresh.length) {
          logTail.current = fresh[fresh.length - 1]!.id;
          setLogs((current) => [...current, ...fresh]);
        }
        setLogError((current) => current?.direction === "tail" ? null : current);
      } catch (reason) {
        if (active && generation === logGeneration.current && isQueueOwnerCurrent(owner)) {
          setLogError({ message: explainError(reason, "更新运行日志失败"), direction: "tail" });
        }
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = ACTIVE[jobStatus] ? setInterval(() => void poll(), LOG_POLL_MS) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [jobId, jobStatus, logLevel, page, logReady, tailRevision]);

  useEffect(() => {
    const id = job?.reconstruction_id;
    if (!id || job?.status !== "SUCCEEDED" || (page !== "result" && page !== "downloads")) return;
    let active = true;
    setArtifacts([]);
    void client.getManifest(id).then((manifest) => { if (active) setArtifacts(manifest.artifacts); }).catch((reason: unknown) => { if (active) setError(explainError(reason, "加载成果失败")); });
    return () => { active = false; };
  }, [job?.reconstruction_id, job?.status, page, resultRevision]);

  useEffect(() => {
    const id = job?.reconstruction_id;
    if (!id || job?.status !== "SUCCEEDED" || page !== "shares" || !writer) return;
    let active = true;
    setShares([]);
    void client.listShares(id).then((value) => { if (active) setShares(value); }).catch((reason: unknown) => { if (active) setError(explainError(reason, "加载分享失败")); });
    return () => { active = false; };
  }, [job?.reconstruction_id, job?.status, writer, page, resultRevision]);

  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (reason) { setError(explainError(reason, "操作失败，请检查网络后重试")); } finally { setBusy(false); }
  }
  async function loadEarlier() {
    const oldest = logs[0]?.id;
    const owner = currentQueueOwner();
    const generation = logGeneration.current;
    if (!oldest || !hasEarlier || !owner || earlierPending.current === generation) return;
    earlierPending.current = generation;
    setEarlierBusy(true);
    try {
      const level = logLevel === "all" ? undefined : logLevel;
      const rows = await queueClient(owner).listJobLogs(jobId, { beforeId: oldest, limit: LOG_PAGE_SIZE, level });
      if (generation !== logGeneration.current || !isQueueOwnerCurrent(owner)) return;
      setLogError((current) => current?.direction === "earlier" ? null : current);
      setHasEarlier(rows.length >= LOG_PAGE_SIZE);
      if (rows.length) setLogs((current) => [...rows, ...current]);
    } catch (reason) {
      if (generation === logGeneration.current && isQueueOwnerCurrent(owner)) {
        setLogError({ message: explainError(reason, "加载更早日志失败"), direction: "earlier" });
      }
    } finally {
      if (earlierPending.current === generation) {
        earlierPending.current = null;
        if (generation === logGeneration.current && isQueueOwnerCurrent(owner)) setEarlierBusy(false);
      }
    }
  }
  async function createShare() {
    if (!job?.reconstruction_id) return;
    const preset = SHARE_PRESETS.find((item) => item.value === sharePreset);
    const expiresAt = preset?.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
    const result = await client.createShare(job.reconstruction_id, expiresAt);
    setShares(await client.listShares(job.reconstruction_id));
    setShareToken(result.token);
    await Share.share({ message: `${webBaseUrl}/share/${encodeURIComponent(result.token)}` });
  }
  async function download(kind: string) {
    if (!job?.reconstruction_id) return;
    const manifest = await client.getManifest(job.reconstruction_id);
    const artifact = manifest.artifacts.find((item) => item.kind === kind);
    if (!artifact) throw new Error("产物不可用");
    await Linking.openURL(artifact.url);
  }
  const progress = Math.round((job?.progress ?? 0) * 100);
  if (!page) return null;
  const title = { job: "任务详情", "job-logs": "运行日志", result: "成果详情", downloads: "下载与校验", shares: "分享管理" }[page];
  return (
    <Screen title={title} scroll onBack={onBack} backLabel={backLabel}>
      {page === "job" ? <Card>
        <Text accessibilityLiveRegion="polite" style={[textStyles.heading, job?.status === "SUCCEEDED" && { color: theme.success }, job?.status === "FAILED" && textStyles.error]}>
          {job ? JOB_STATUS_LABELS[job.status] : "加载中…"}
        </Text>
        {job ? <>
          <Text style={textStyles.body}>{stageLabel(job.current_stage)} · {progress}%</Text>
          <View
            accessible accessibilityRole="progressbar" accessibilityLabel="重建进度"
            accessibilityValue={{ min: 0, max: 100, now: progress }}
            style={{ height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: theme.bgDeep }}
          >
            <View style={{ width: `${progress}%`, height: 8, backgroundColor: theme.accentStrong }} />
          </View>
          <Text selectable style={textStyles.muted}>{RECONSTRUCTION_PROFILES[job.profile].title} · 第 {job.attempt} 次 · {job.id.slice(0, 8)}</Text>
        </> : null}
        {job?.status === "QUEUED" ? <Text style={textStyles.muted}>{queuedJobHint(online)}</Text> : null}
        {job?.error_message || job?.error_code ? <Text accessibilityLiveRegion="polite" style={textStyles.error}>{jobErrorHint(job.error_code) || job.error_message || job.error_code}</Text> : null}
        {writer && job && ACTIVE[job.status] ? <Button accessibilityLabel="取消任务" label={job.cancel_requested ? "取消中" : "取消任务"} tone="ghost" disabled={busy || job.cancel_requested} onPress={() => Alert.alert("取消任务", "确定取消此任务？", [{ text: "返回", style: "cancel" }, { text: "取消任务", style: "destructive", onPress: () => void action(async () => setJob(await client.cancelJob(job.id))) }])} /> : null}
        {writer && job?.error_code === "INVALID_INPUT" ? <Button label="更换素材" disabled={busy} onPress={() => void action(async () => onReplaceAssets(await client.getProjectSummary(job.project_id)))} /> : null}
        {writer && job && canRetryJob(job) ? <Button label="重试任务" disabled={busy} onPress={() => void action(async () => {
          setJob(await client.retryJob(job.id));
          setReload((value) => value + 1);
        })} /> : null}
        {job?.status === "SUCCEEDED" && job.reconstruction_id ? <Button label="查看结果" onPress={() => onNavigate("result")} /> : null}
        <Button label="运行日志" tone="ghost" onPress={() => onNavigate("job-logs")} />
      </Card> : null}
      {page === "result" && job?.status === "SUCCEEDED" && job.reconstruction_id ? <Card>
        <Text style={textStyles.muted}>任务 {job.id.slice(0, 8)} · {RECONSTRUCTION_PROFILES[job.profile].title}</Text>
        {artifacts.some((artifact) => artifact.kind === "spz" || artifact.kind === "ply") ? <Button label="打开三维场景" onPress={() => onOpenScene(job.reconstruction_id!)} /> : null}
        <Button label="下载与校验" tone="ghost" onPress={() => onNavigate("downloads")} />
        {writer ? <Button label="分享管理" tone="ghost" onPress={() => onNavigate("shares")} /> : null}
      </Card> : null}
      {page === "result" && job && !(job.status === "SUCCEEDED" && job.reconstruction_id) ? <Card>
        <Text style={textStyles.body}>该任务尚无可用成果。</Text>
        <Button label="返回任务详情" tone="ghost" onPress={onBack} />
      </Card> : null}
      {page === "downloads" && artifacts.length === 0 && job?.status === "SUCCEEDED" && job.reconstruction_id ? <Card>
        <Text style={textStyles.body}>暂无可下载产物。</Text>
        <Button label="重新读取" tone="ghost" onPress={() => setResultRevision((value) => value + 1)} />
      </Card> : null}
      {page === "downloads" && artifacts.length > 0 ? <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>下载</Text>
        {artifacts.map((artifact) => <View key={artifact.kind} style={{ paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: theme.divider }}>
          <Text style={textStyles.body}>{artifact.kind.toUpperCase()} · {artifact.size == null ? "大小未知" : `${(artifact.size / 1024 / 1024).toFixed(1)} MB`}</Text>
          <Text selectable style={textStyles.muted}>SHA-256: {artifact.sha256 ?? "未提供"}</Text>
          <Button label={`下载 ${artifact.kind.toUpperCase()}`} disabled={busy} onPress={() => void action(() => download(artifact.kind))} />
          {artifact.kind === "ply" && job?.reconstruction_id ? <Button label="打开 PLY 场景" tone="ghost" onPress={() => onOpenScene(job.reconstruction_id!)} /> : null}
        </View>)}
      </Card> : null}
      {page === "shares" && writer && job?.reconstruction_id && job.status === "SUCCEEDED" ? <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>分享管理</Text>
        <Text style={textStyles.muted}>新链接有效期（已有链接不会显示原始令牌）</Text>
        <Segmented value={sharePreset} onChange={setSharePreset} options={SHARE_PRESETS.map(({ value, label }) => ({ value, label }))} />
        <Button label="创建并分享链接" disabled={busy} onPress={() => void action(createShare)} />
        {shareToken ? <Image
          accessibilityLabel="分享二维码"
          source={{ uri: client.shareQrUrl(shareToken) }}
          style={{ width: 160, height: 160, backgroundColor: "#fff", borderRadius: 8, marginTop: 12 }}
        /> : null}
        {shares.map((share) => <View key={share.id} style={{ paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: theme.divider }}>
          <Text style={textStyles.muted}>{share.revoked_at ? "已撤销" : "有效或等待到期"} · 到期：{share.expires_at ? new Date(share.expires_at).toLocaleString() : "无期限"}</Text>
          {!share.revoked_at ? <Button label="撤销分享" disabled={busy} tone="ghost" onPress={() => Alert.alert("撤销分享", "撤销后链接将立即失效。", [{ text: "返回", style: "cancel" }, { text: "撤销", style: "destructive", onPress: () => void action(async () => { await client.revokeShare(share.id); setShares(await client.listShares(job.reconstruction_id!)); if (shareToken) setShareToken(""); }) }])} /> : null}
        </View>)}
      </Card> : null}
      {page === "job" && timeline.length > 0 ? <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>阶段记录</Text>
        {timeline.some((row) => Object.keys(row.metrics).length > 0) ? <Button tone="ghost" label={showMetrics ? "隐藏技术指标" : "查看技术指标"} onPress={() => setShowMetrics((value) => !value)} /> : null}
        {timeline.map((row) => <View key={row.key} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
          <Text style={textStyles.body}>{stageLabel(row.stage)} · {row.status} · {Math.round(row.progress * 100)}%</Text>
          {row.message ? <Text style={textStyles.muted}>{row.message}</Text> : null}
          {showMetrics && Object.keys(row.metrics).length > 0 ? <Text style={textStyles.muted}>{JSON.stringify(row.metrics)}</Text> : null}
        </View>)}
      </Card> : null}
      {page === "job-logs" ? <Card>
        <Segmented value={logLevel} onChange={setLogLevel} options={LOG_LEVELS} />
        {logError ? <><Text accessibilityRole="alert" style={textStyles.error}>{logError.message}</Text><Button label="重试加载日志" disabled={earlierBusy} onPress={() => {
          if (logError.direction === "earlier") void loadEarlier();
          else if (logError.direction === "tail") setTailRevision((value) => value + 1);
          else setLogRevision((value) => value + 1);
        }} /></> : null}
        {!logError && logs.length === 0 ? <Text style={textStyles.muted}>{!logReady ? "正在加载运行日志…" : jobStatus && ACTIVE[jobStatus] ? "等待 Worker 输出…" : "暂无运行日志。"}</Text> : logs.map((row) => {
          const attemptText = row.attempt == null ? "轮次未知" : `第 ${row.attempt} 轮`;
          return (
            <Text key={row.id} selectable style={LOG_TEXT}>{new Date(row.created_at).toLocaleTimeString()} · {attemptText} · {LOG_TAG[row.level]} · {row.message}</Text>
          );
        })}
        {hasEarlier ? <Button disabled={earlierBusy} label="加载更早" tone="ghost" onPress={() => void loadEarlier()} /> : null}
      </Card> : null}
      {error ? <Card>
        <Text accessibilityRole="alert" style={textStyles.error}>{error}</Text>
        <Button label="重试" onPress={() => { setError(""); if (page === "job" || !job) setReload((value) => value + 1); else setResultRevision((value) => value + 1); }} />
      </Card> : null}
    </Screen>
  );
}
