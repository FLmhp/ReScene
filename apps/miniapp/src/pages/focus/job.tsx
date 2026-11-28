import { explainError, ResceneApiError } from "@rescene/api-client";
import { canRetryJob, jobErrorHint, JOB_STATUS_LABELS, queuedJobHint, RECONSTRUCTION_PROFILES, stageLabel, type Job, type JobLog, type JobStage, type ProjectSummary, type ShareSummary } from "@rescene/schemas";
import { Button, Image, Progress, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl, client, currentQueueOwner, isQueueOwnerCurrent, queueClient, webBaseUrl } from "../../api";
import { requestMaterialsReturn } from "../../navigation";
import { useScreenPalette } from "../../screen";
import { createJobLogReader, type JobLogReader } from "../project/job-logs";

const ACTIVE: Record<string, boolean> = { QUEUED: true, LEASED: true, RUNNING: true };
const PRESETS = [{ label: "永久", ms: 0 }, { label: "1 天", ms: 86400000 }, { label: "7 天", ms: 604800000 }, { label: "30 天", ms: 2592000000 }];
function message(reason: unknown, fallback: string) { return reason instanceof ResceneApiError ? explainError(reason, reason.detail || fallback) : reason instanceof Error ? reason.message : fallback; }

export function JobFocus({ projectId, jobId, view }: { projectId: string; jobId: string; view: string }) {
  const palette = useScreenPalette(); const [job, setJob] = useState<Job | null>(null); const [project, setProject] = useState<ProjectSummary | null>(null);
  const [stages, setStages] = useState<JobStage[]>([]); const [logs, setLogs] = useState<JobLog[]>([]); const [level, setLevel] = useState<"" | "debug" | "info" | "warning" | "error">(""); const [logBusy, setLogBusy] = useState(false);
  const [logReady, setLogReady] = useState(false);
  const [logError, setLogError] = useState<{ message: string; older: boolean } | null>(null);
  const earlierRequest = useRef(0);
  const [shares, setShares] = useState<ShareSummary[]>([]); const [token, setToken] = useState(""); const [preset, setPreset] = useState(2); const [visible, setVisible] = useState(true); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const lock = useRef(false); const generation = useRef(0);
  const reader = useRef<JobLogReader | null>(null);
  if (!reader.current) reader.current = createJobLogReader(async (id, options) => {
    const owner = currentQueueOwner();
    if (!owner) return [];
    const rows = await queueClient(owner).listJobLogs(id, options);
    return isQueueOwnerCurrent(owner) ? rows : [];
  }, (rows) => {
    setLogs(rows);
  }, (reason, older) => setLogError({ message: message(reason, "加载运行日志失败。"), older }));
  const load = useCallback(async () => { const request = ++generation.current; try { const [nextJob, nextProject] = await Promise.all([client.getJob(jobId), client.getProjectSummary(projectId)]); if (request !== generation.current) return; if (nextJob.project_id !== projectId) throw new Error("任务不属于此项目。"); setJob(nextJob); setProject(nextProject); setError(""); } catch (reason) { if (request === generation.current) { setJob(null); setProject(null); setError(message(reason, "加载任务失败。")); } } }, [jobId, projectId]);
  useDidShow(() => { setVisible(true); void load(); });
  useDidHide(() => { generation.current++; earlierRequest.current++; setVisible(false); setLogBusy(false); reader.current?.context(jobId, level, false); });
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (!visible || !job || view !== "job") return; let active = true; void client.getJobStages(jobId).then((rows) => { if (active) setStages(rows); }).catch((reason) => { if (active) setError(message(reason, "加载任务阶段失败。")); }); return () => { active = false; }; }, [jobId, visible, Boolean(job), view]);
  useEffect(() => { if (!visible || !job || !ACTIVE[job.status] || view !== "job") return; return client.subscribeJob(jobId, (event) => { if ("id" in event) { if (event.project_id === projectId) setJob(event); return; } setStages((rows) => [...rows, { id: `live-${Date.now()}-${event.stage}`, stage: event.stage, status: event.status, progress: event.progress, message: event.message ?? null, metrics: {}, created_at: new Date().toISOString() }].slice(-100)); }, (reason) => setError(message(reason, "任务更新失败。")), { transport: "polling", pollIntervalMs: 3000 }); }, [jobId, projectId, visible, job?.status, view]);
  useEffect(() => {
    const r = reader.current!;
    const active = visible && job?.id === jobId && view === "job-logs";
    let current = true;
    r.context(jobId, level, active);
    setLogReady(false);
    setLogBusy(false);
    setLogError(null);
    const poll = async () => {
      await r.poll();
      if (current) setLogReady(true);
    };
    if (active) void poll();
    const timer = active ? setInterval(() => void poll(), 3000) : undefined;
    return () => { current = false; earlierRequest.current++; clearInterval(timer); r.context(jobId, level, false); };
  }, [jobId, level, visible, job?.id, view]);
  const canWrite = project?.effective_role === "owner" || project?.effective_role === "admin" || project?.effective_role === "member";
  const reconstruction = job?.status === "SUCCEEDED" ? job.reconstruction_id : null;
  const loadShares = useCallback(async () => { if (!reconstruction || !canWrite) return; try { setShares(await client.listShares(reconstruction)); } catch (reason) { setError(message(reason, "加载分享失败。")); } }, [reconstruction, canWrite]);
  useEffect(() => { if (visible && view === "shares") void loadShares(); }, [visible, view, loadShares]);
  function open(next: string) { void Taro.navigateTo({ url: `/pages/focus/index?view=${next}&id=${encodeURIComponent(projectId)}&job=${encodeURIComponent(jobId)}` }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" })); }
  async function change(action: "cancel" | "retry") { if (!job || !canWrite || lock.current) return; const result = await Taro.showModal({ title: action === "cancel" ? "取消任务" : "重试任务", content: action === "cancel" ? "确定取消当前重建任务？" : "确定使用原素材重新排队？" }); if (!result.confirm) return; lock.current = true; setBusy(true); try { setJob(action === "cancel" ? await client.cancelJob(jobId) : await client.retryJob(jobId)); } catch (reason) { setError(message(reason, "任务操作失败。")); } finally { lock.current = false; setBusy(false); } }
  async function earlier() {
    if (logBusy || !visible) return;
    const request = ++earlierRequest.current;
    setLogBusy(true);
    setLogError(null);
    try { await reader.current?.earlier(); }
    finally { if (request === earlierRequest.current) setLogBusy(false); }
  }
  async function replaceAssets() { const owner = currentQueueOwner(); if (!owner) return; requestMaterialsReturn(projectId, owner.id); const pages = Taro.getCurrentPages(); const parentIndex = pages.findIndex((page) => page.route === "pages/project/index" && String(page.options?.id ?? "") === projectId); if (parentIndex >= 0) await Taro.navigateBack({ delta: pages.length - 1 - parentIndex }); else await Taro.redirectTo({ url: `/pages/project/index?id=${encodeURIComponent(projectId)}` }); }
  async function copyViewer() { const base = (webBaseUrl ?? "").replace(/\/+$/, ""); if (!reconstruction || !/^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(base)) { setError("查看器地址未配置为有效的 HTTPS 地址。"); return; } try { await Taro.setClipboardData({ data: `${base}/viewer?reconstruction=${encodeURIComponent(reconstruction)}` }); } catch (reason) { setError(message(reason, "复制查看链接失败。")); } }
  async function createShare() { const base = (webBaseUrl ?? "").replace(/\/+$/, ""); if (!reconstruction || !canWrite || lock.current) return; if (!/^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(base)) { setError("请配置有效的 HTTPS 小程序网页地址后创建分享。"); return; } lock.current = true; setBusy(true); try { const share = await client.createShare(reconstruction, PRESETS[preset].ms ? new Date(Date.now() + PRESETS[preset].ms).toISOString() : undefined); setToken(share.token); await loadShares(); } catch (reason) { setError(message(reason, "创建分享失败。")); } finally { lock.current = false; setBusy(false); } }
  async function revoke(id: string) { const result = await Taro.showModal({ title: "撤销分享", content: "撤销后该链接将无法访问。" }); if (!result.confirm) return; try { await client.revokeShare(id); setToken(""); await loadShares(); } catch (reason) { setError(message(reason, "撤销分享失败。")); } }
  return <>{error ? <View className="card"><Text className="error">{error}</Text>{!job || view === "job" ? <Button className="button ghost" onClick={() => void load()}>重试</Button> : view === "job-logs" ? <Button className="button ghost" onClick={() => void reader.current?.poll()}>重试</Button> : view === "shares" ? <Button className="button ghost" onClick={() => void loadShares()}>重试</Button> : null}</View> : null}{!job && !error ? <Text className="muted">加载中…</Text> : null}{job ? <>
    {view === "job" ? <View className="card"><Text className="section-heading">{RECONSTRUCTION_PROFILES[job.profile].title} · {JOB_STATUS_LABELS[job.status]}</Text><Text className="muted">{stageLabel(job.current_stage)} · {Math.round(job.progress * 100)}%</Text><Progress percent={Math.round(job.progress * 100)} strokeWidth={5} borderRadius={6} activeColor={palette.accent} backgroundColor={palette.divider} />{stages.filter((stage) => stage.stage !== "queued").map((stage) => <View key={stage.id}><Text>{stageLabel(stage.stage)} · {stage.status} · {Math.round(stage.progress * 100)}%</Text>{stage.message && stage.stage !== "queued" ? <Text className="muted">{stage.message}</Text> : null}</View>)}{job.status === "QUEUED" ? <Text className="muted">{queuedJobHint(undefined)}</Text> : null}{job.error_code || job.error_message ? <Text className="error">{jobErrorHint(job.error_code) || job.error_message || job.error_code}</Text> : null}{canWrite && ACTIVE[job.status] ? <Button className="button ghost" disabled={busy || job.cancel_requested} onClick={() => void change("cancel")}>{job.cancel_requested ? "取消中" : "取消任务"}</Button> : null}{canWrite && canRetryJob(job) ? <Button className="button ghost" disabled={busy} onClick={() => void change("retry")}>重试任务</Button> : null}{canWrite && job.error_code === "INVALID_INPUT" ? <Button className="button ghost" onClick={() => void replaceAssets()}>更换素材</Button> : null}{reconstruction ? <Button className="button" onClick={() => open("result")}>查看结果</Button> : null}<Button className="button ghost" onClick={() => open("job-logs")}>运行日志</Button></View> : null}
    {view === "job-logs" ? <View className="card">
      <View className="segmented">{([["", "全部"], ["debug", "调试"], ["info", "信息"], ["warning", "警告"], ["error", "错误"]] as const).map(([value, label]) => (
        <Button key={value || "all"} className={`button tab${level === value ? " active" : ""}`} onClick={() => setLevel(value)}>{label}</Button>
      ))}</View>
      {logError ? <View><Text className="error">{logError.message}</Text><Button className="button ghost" disabled={logError.older && logBusy} onClick={() => {
        if (logError.older) void earlier();
        else { setLogError(null); void reader.current?.poll(); }
      }}>重试</Button></View> : null}
      {reader.current?.canLoadEarlier() ? <Button className="button ghost" disabled={logBusy} loading={logBusy} onClick={() => void earlier()}>加载更早</Button> : null}
      {!logs.length && !logError ? <Text className="muted">{logReady ? "暂无运行日志。" : "正在加载运行日志…"}</Text> : null}
      <ScrollView scrollY className="log-panel">{logs.map((row) => <Text className="log" key={row.id}>{new Date(row.created_at).toLocaleString()} · {row.attempt == null ? "轮次未知" : `第 ${row.attempt} 轮`} · {row.level} · {row.message}</Text>)}</ScrollView>
    </View> : null}
    {view === "result" ? <View className="card">{reconstruction ? <><Text className="section-heading">{RECONSTRUCTION_PROFILES[job.profile].title} · {new Date(job.created_at).toLocaleString()}</Text><Text className="muted">复制链接到手机浏览器，用 ReScene 账号登录后查看场景。</Text><Button className="button" onClick={() => void copyViewer()}>复制浏览器查看链接</Button>{canWrite ? <Button className="button ghost" onClick={() => open("shares")}>分享管理</Button> : null}</> : <Text className="muted">此任务暂无重建结果。</Text>}</View> : null}
    {view === "shares" ? <View className="card">{reconstruction && canWrite ? <><Text className="label">分享有效期</Text>{PRESETS.map((item, index) => <Button key={item.label} className={`button ghost${preset === index ? " active" : ""}`} onClick={() => setPreset(index)}>{item.label}</Button>)}<Button className="button" disabled={busy} loading={busy} onClick={() => void createShare()}>创建分享</Button>{token ? <View><Text className="muted">链接仅在创建时显示，请及时复制。</Text><Button className="button ghost" onClick={() => void Taro.setClipboardData({ data: `${(webBaseUrl ?? "").replace(/\/+$/, "")}/share/${encodeURIComponent(token)}` })}>复制新链接</Button>{apiBaseUrl ? <Image className="qr" src={client.shareQrUrl(token)} mode="aspectFit" /> : null}<Button className="button ghost" onClick={() => void Taro.navigateTo({ url: `/pages/viewer/index?share=${encodeURIComponent(token)}` })}>打开转发页面</Button></View> : null}{shares.map((share) => <View className="row" key={share.id}><Text>{share.id} · {share.revoked_at ? `已撤销 ${share.revoked_at}` : `有效期 ${share.expires_at ?? "不限"}`}</Text>{!share.revoked_at ? <Button className="button ghost compact" onClick={() => void revoke(share.id)}>撤销</Button> : null}</View>)}</> : <Text className="error">{reconstruction ? "此成果不可分享，或你没有分享权限。" : "此任务暂无重建结果。"}</Text>}</View> : null}
  </> : null}</>;
}
