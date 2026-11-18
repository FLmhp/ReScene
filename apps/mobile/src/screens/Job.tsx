import { explainError } from "@rescene/api-client";
import { JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, jobErrorHint, stageLabel } from "@rescene/schemas";
import type { Artifact, Job, JobLog, ShareSummary } from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Linking, Platform, Share, Text, View } from "react-native";

import { client, webBaseUrl } from "../api";
import { useAppearance } from "../appearance";
import { Button, Card, Screen, Segmented, useTextStyles } from "../ui";

const ACTIVE: Record<string, true> = { QUEUED: true, LEASED: true, RUNNING: true };
const LOG_POLL_MS = 3000;
const LOG_PAGE_SIZE = 200;
const LOG_KEEP = 2000;

type LogLevel = "all" | "info" | "warning" | "error";
const LOG_LEVELS: { value: LogLevel; label: string }[] = [
  { value: "all", label: "全部" },
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

export function JobScreen({ jobId, onOpenScene, onBack }: {
  jobId: string; onOpenScene: (reconstructionId: string) => void; onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const LOG_TEXT = {
  color: theme.muted,
  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  fontSize: 12,
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
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [logLevel, setLogLevel] = useState<LogLevel>("all");
  const [hasEarlier, setHasEarlier] = useState(false);
  const logTail = useRef(0);
  const logReady = useRef(false);

  useEffect(() => {
    let active = true;
    setJob(null); setArtifacts([]); setShares([]); setWriter(false);
    void client.getJob(jobId).then(async (value) => {
      if (!active) return;
      setJob(value);
      const project = await client.getProjectSummary(value.project_id);
      if (active) setWriter(project.effective_role !== "viewer");
    }).catch((reason: unknown) => { if (active) setError(explainError(reason, "操作失败，请检查网络后重试")); });
    void client.getWorkerStatus().then((status) => { if (active) setOnline(status.online); }).catch(() => { if (active) setOnline(null); });
    const stop = client.subscribeJob(jobId, (event) => {
      if (!active) return;
      if ("stage" in event) {
        setJob((current) => current ? { ...current, progress: event.progress, current_stage: event.stage } : current);
        setTimeline((current) => [...current, { key: `live-${Date.now()}-${event.stage}`, stage: event.stage, status: event.status, progress: event.progress, message: event.message, metrics: event.metrics }].slice(-100));
      } else setJob(event);
      setError("");
    }, (reason) => { if (active) setError(reason.message); }, { transport: "polling" });
    return () => { active = false; stop(); };
  }, [jobId, reload]);

  useEffect(() => { setShareToken(""); setTimeline([]); }, [jobId]);

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
    let active = true;
    logTail.current = 0;
    logReady.current = false;
    setLogs([]);
    setHasEarlier(false);
    const level = logLevel === "all" ? undefined : logLevel;
    void client.listJobLogs(jobId, { limit: LOG_PAGE_SIZE, level }).then((rows) => {
      if (!active) return;
      logTail.current = rows.length ? rows[rows.length - 1]!.id : 0;
      setLogs(rows);
      setHasEarlier(rows.length >= LOG_PAGE_SIZE);
      logReady.current = true;
    }).catch(() => { if (active) logReady.current = true; });
    return () => { active = false; };
  }, [jobId, logLevel]);

  useEffect(() => {
    if (!jobStatus || !ACTIVE[jobStatus]) return;
    let active = true;
    let polling = false;
    const level = logLevel === "all" ? undefined : logLevel;
    const timer = setInterval(() => {
      if (!active || !logReady.current || polling) return;
      polling = true;
      void client.listJobLogs(jobId, { afterId: logTail.current, limit: LOG_PAGE_SIZE, level }).then((rows) => {
        polling = false;
        if (!active || rows.length === 0) return;
        logTail.current = rows[rows.length - 1]!.id;
        setLogs((current) => {
          const seen = new Set(current.map((row) => row.id));
          const fresh = rows.filter((row) => !seen.has(row.id));
          return fresh.length > 0 ? [...current, ...fresh].slice(-LOG_KEEP) : current;
        });
      }).catch(() => { polling = false; });
    }, LOG_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, jobStatus, logLevel]);

  useEffect(() => {
    const id = job?.reconstruction_id;
    if (!id || job?.status !== "SUCCEEDED") return;
    let active = true;
    void client.getManifest(id).then((manifest) => { if (active) setArtifacts(manifest.artifacts); }).catch((reason: unknown) => { if (active) setError(explainError(reason, "操作失败，请检查网络后重试")); });
    if (writer) void client.listShares(id).then((value) => { if (active) setShares(value); }).catch((reason: unknown) => { if (active) setError(explainError(reason, "操作失败，请检查网络后重试")); });
    return () => { active = false; };
  }, [job?.reconstruction_id, job?.status, writer]);

  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (reason) { setError(explainError(reason, "操作失败，请检查网络后重试")); } finally { setBusy(false); }
  }
  async function loadEarlier() {
    const oldest = logs[0]?.id;
    if (!oldest) return;
    const level = logLevel === "all" ? undefined : logLevel;
    const rows = await client.listJobLogs(jobId, { beforeId: oldest, limit: LOG_PAGE_SIZE, level });
    setHasEarlier(rows.length >= LOG_PAGE_SIZE);
    if (rows.length > 0) setLogs((current) => [...rows, ...current]);
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
  return (
    <Screen title="重建任务" scroll>
      <Card>
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
        {job?.status === "QUEUED" ? <Text style={textStyles.muted}>{online === false ? "Worker 离线，任务将在其上线后执行" : online === true ? "任务排队中" : "正在等待 Worker（状态未知）"}</Text> : null}
        {job?.error_message || job?.error_code ? <Text accessibilityLiveRegion="polite" style={textStyles.error}>{jobErrorHint(job.error_code) || job.error_message || job.error_code}</Text> : null}
        {writer && job && ACTIVE[job.status] ? <Button label={job.cancel_requested ? "取消中" : "取消任务"} tone="ghost" disabled={busy || job.cancel_requested} onPress={() => Alert.alert("取消任务", "确定取消此任务？", [{ text: "返回", style: "cancel" }, { text: "取消任务", style: "destructive", onPress: () => void action(async () => setJob(await client.cancelJob(job.id))) }])} /> : null}
        {writer && job && job.error_code !== "INVALID_INPUT" && (job.status === "FAILED" || job.status === "CANCELLED") ? <Button label="重试任务" disabled={busy} onPress={() => void action(async () => setJob(await client.retryJob(job.id)))} /> : null}
        {job?.reconstruction_id && artifacts.some((a) => a.kind === "spz" || a.kind === "ply") ? <Button label="打开三维场景" onPress={() => onOpenScene(job.reconstruction_id!)} /> : null}
      </Card>
      {timeline.length > 0 ? <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>阶段记录</Text>
        {timeline.map((row) => <View key={row.key} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
          <Text style={textStyles.body}>{stageLabel(row.stage)} · {row.status} · {Math.round(row.progress * 100)}%</Text>
          {row.message ? <Text style={textStyles.muted}>{row.message}</Text> : null}
          {Object.keys(row.metrics).length > 0 ? <Text style={textStyles.muted}>{JSON.stringify(row.metrics)}</Text> : null}
        </View>)}
      </Card> : null}
      <Card>
        <Button tone="ghost" label={showLogs ? "收起运行日志" : `查看运行日志（${logs.length}）`} onPress={() => setShowLogs((value) => !value)} />
        {showLogs ? <>
          <Segmented value={logLevel} onChange={setLogLevel} options={LOG_LEVELS} />
          {logs.length === 0 ? <Text style={textStyles.muted}>{jobStatus && ACTIVE[jobStatus] ? "等待 Worker 输出…" : "暂无运行日志。"}</Text> : logs.map((row) => (
            <Text key={row.id} selectable style={LOG_TEXT}>{new Date(row.created_at).toLocaleTimeString()} · {LOG_TAG[row.level]} · {row.message}</Text>
          ))}
          {hasEarlier ? <Button disabled={busy} label="加载更早" tone="ghost" onPress={() => void action(loadEarlier)} /> : null}
        </> : null}
      </Card>
      {error ? <Card>
        <Text accessibilityRole="alert" style={textStyles.error}>{error}</Text>
        <Button label="重新加载任务" onPress={() => { setError(""); setReload((value) => value + 1); }} />
      </Card> : null}
      {artifacts.map((artifact) => <Card key={artifact.kind}>
        <Text style={textStyles.body}>{artifact.kind.toUpperCase()} · {artifact.size == null ? "大小未知" : `${(artifact.size / 1024 / 1024).toFixed(1)} MB`}</Text>
        <Text selectable style={textStyles.muted}>SHA-256: {artifact.sha256 ?? "未提供"}</Text>
        <Button label={`下载 ${artifact.kind.toUpperCase()}`} disabled={busy} onPress={() => void action(() => download(artifact.kind))} />
      </Card>)}
      {writer && job?.reconstruction_id && job.status === "SUCCEEDED" ? <Card>
        <Text style={textStyles.body}>分享管理</Text>
        <Text style={textStyles.muted}>新链接有效期（已有链接不会显示原始令牌）</Text>
        <Segmented value={sharePreset} onChange={setSharePreset} options={SHARE_PRESETS.map(({ value, label }) => ({ value, label }))} />
        <Button label="创建并分享链接" disabled={busy} onPress={() => void action(createShare)} />
        {shareToken ? <Image
          accessibilityLabel="分享二维码"
          source={{ uri: client.shareQrUrl(shareToken) }}
          style={{ width: 160, height: 160, backgroundColor: "#fff", borderRadius: 8, marginTop: 12 }}
        /> : null}
        {shares.map((share) => <Card key={share.id}>
          <Text style={textStyles.muted}>{share.revoked_at ? "已撤销" : "有效或等待到期"} · 到期：{share.expires_at ? new Date(share.expires_at).toLocaleString() : "无期限"}</Text>
          {!share.revoked_at ? <Button label="撤销分享" disabled={busy} tone="ghost" onPress={() => Alert.alert("撤销分享", "撤销后链接将立即失效。", [{ text: "返回", style: "cancel" }, { text: "撤销", style: "destructive", onPress: () => void action(async () => { await client.revokeShare(share.id); setShares(await client.listShares(job.reconstruction_id!)); if (shareToken) setShareToken(""); }) }])} /> : null}
        </Card>)}
      </Card> : null}
      <Button label="返回项目" onPress={onBack} tone="ghost" />
    </Screen>
  );
}
