import { explainError, isOfflineError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, reconcileWorkspaceSelection, selectWorkspaceAssets, selectionBytes, stageLabel } from "@rescene/schemas";
import type { Asset, MemberRole, Profile, ProjectWorkspace, ProjectMember } from "@rescene/schemas";
import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { client } from "../api";
import { AssetThumbnail } from "../AssetThumbnail";
import { enqueue, loadQueue, replayQueued, saveQueue } from "../queue";
import { useAppearance } from "../appearance";
import type { Palette } from "@rescene/design-tokens";
import { MediaPreflightError, mediaType, summarizeMediaWarnings } from "@rescene/uploader";
import { inspectPickedFiles, type PickedFile, uploadFile } from "../upload";
import { Button, Card, ErrorText, Field, Screen, useTextStyles } from "../ui";

const PROFILES: Profile[] = ["fast", "balanced", "quality"];
const ROLE_LABEL = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };
type Upload = { id: string; file: PickedFile; progress: number; status: "uploading" | "failed" | "done"; error?: string };
type TimelineRow = { key: string; stage: string; status: string; progress: number; message?: string | null; metrics: Record<string, unknown> };

export type ProjectDraft = { assets: Asset[]; profile: Profile };

export function ProjectScreen({ project, draft, onJob, onBack }: {
  project: { id: string; name: string };
  draft?: ProjectDraft;
  onJob: (jobId: string, draft: ProjectDraft) => void;
  onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const styles = makeStyles(theme);
  const [showManagement, setShowManagement] = useState(false);
  const [assetPages, setAssetPages] = useState([""]);
  const [jobPages, setJobPages] = useState([""]);
  const [pageLoading, setPageLoading] = useState(false);
  const requestId = useRef(0);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<ProjectWorkspace | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [selected, setSelected] = useState<Asset[]>(draft?.assets ?? []);
  const [profile, setProfile] = useState<Profile>(draft?.profile ?? "balanced");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [name, setName] = useState(project.name);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const mutationFlight = useRef(false);
  const jobFlight = useRef(false);
  const uploadFlights = useRef(new Set<string>());
  const uploadSequence = useRef(0);
  const picking = useRef(false);
  const [checkingMedia, setCheckingMedia] = useState(false);
  const replayed = useRef(false);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [inviteNotice, setInviteNotice] = useState("");
  const [issuedInvitation, setIssuedInvitation] = useState<{ email: string; code: string } | null>(null);
  const invitationContext = useRef(0);
  const [error, setError] = useState("");

  useEffect(() => {
    setIssuedInvitation(null);
    return () => { invitationContext.current += 1; };
  }, [project.id, showManagement]);
  useEffect(() => {
    if (!issuedInvitation) return;
    const timer = setTimeout(() => setIssuedInvitation(null), 120_000);
    return () => clearTimeout(timer);
  }, [issuedInvitation]);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setPageLoading(true);
    try {
      const [next, nextMembers] = await Promise.all([
        client.getWorkspace(project.id, assetPages[assetPages.length - 1], jobPages[jobPages.length - 1]),
        client.listMembers(project.id),
      ]);
      if (request !== requestId.current) return;
      setDetail(next);
      setName(next.name);
      setMembers(nextMembers);
      setSelected((current) => reconcileWorkspaceSelection(current, next.assets));
    } catch (reason) {
      if (request === requestId.current) setError(explainError(reason, "加载失败"));
    } finally {
      if (request === requestId.current) setPageLoading(false);
    }
  }, [assetPages, jobPages, project.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    async function refreshWorker() {
      const status = await client.getWorkerStatus().catch(() => null);
      if (active) setWorkerOnline(status?.online ?? null);
    }
    void refreshWorker();
    const timer = setInterval(() => void refreshWorker(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [project.id]);

  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    void replayQueued(client, () => undefined).then(({ uploaded }) => { if (uploaded) void load(); }).catch(() => undefined);
  }, [load]);

  const latestJobId = detail?.latest_job?.id;
  useEffect(() => {
    if (!latestJobId) { setTimeline([]); return; }
    let active = true;
    void client.getJobStages(latestJobId).then((rows) => {
      if (active) setTimeline(rows.map((row) => ({ key: row.id, stage: row.stage, status: row.status, progress: row.progress, message: row.message, metrics: row.metrics })));
    }).catch(() => { if (active) setTimeline([]); });
    return () => { active = false; };
  }, [latestJobId]);

  const canManage = detail?.effective_role === "owner" || detail?.effective_role === "admin";
  const canWrite = canManage || detail?.effective_role === "member";

  async function mutate(action: () => Promise<void>, fallback = "操作失败") {
    if (mutationFlight.current) return;
    mutationFlight.current = true;
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(explainError(reason, fallback)); }
    finally { mutationFlight.current = false; setBusy(false); }
  }

  async function runUpload(id: string, file: PickedFile) {
    if (uploadFlights.current.has(id)) return;
    uploadFlights.current.add(id);
    setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "uploading", progress: 0, error: undefined } : item));
    const queued = (await loadQueue()).find((item) => item.kind === "upload" && item.id === id);
    try {
      await uploadFile(client, project.id, file, (progress) => setUploads((current) => current.map((item) => item.id === id ? { ...item, progress } : item)), {
        assetId: queued?.kind === "upload" ? queued.assetId : undefined,
        onAsset: async (assetId) => {
          const entries = await loadQueue();
          await saveQueue(entries.map((item) => (item.kind === "upload" && item.id === id ? { ...item, assetId } : item)));
        },
      });
      const rest = (await loadQueue()).filter((item) => item.id !== id);
      await saveQueue(rest);
      setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "done", progress: 100 } : item));
      await load();
    } catch (reason) {
      setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error: isOfflineError(reason) ? "已保存，联网后自动重试。" : explainError(reason, "上传失败") } : item));
    } finally { uploadFlights.current.delete(id); }
  }

  async function pickAndUpload() {
    if (picking.current || !canWrite) return;
    picking.current = true;
    setCheckingMedia(true);
    try {
      setError("");
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, type: ["image/*", "video/*"], copyToCacheDirectory: true });
      if (result.canceled) return;
      const files = result.assets.map((asset): PickedFile => ({
        uri: asset.uri, name: asset.name, mimeType: mediaType(asset.name) ?? "application/octet-stream", size: asset.size ?? 0,
      }));
      const warnings = await inspectPickedFiles(files);
      if (warnings.length) {
        const confirmed = await new Promise<boolean>((resolve) => Alert.alert("素材检查提示", summarizeMediaWarnings(warnings), [
          { text: "重新选择", style: "cancel", onPress: () => resolve(false) },
          { text: "仍然上传", onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) }));
        if (!confirmed) return;
      }
      for (const file of files) {
        const id = `${Date.now()}-${++uploadSequence.current}`;
        await enqueue({ kind: "upload", id, projectId: project.id, uri: file.uri, name: file.name, mimeType: file.mimeType, size: file.size, createdAt: Date.now() });
        setUploads((current) => [...current, { id, file, progress: 0, status: "uploading" }]);
        void runUpload(id, file);
      }
    } catch (reason) { setError(reason instanceof MediaPreflightError ? reason.message : explainError(reason, "选择文件失败")); }
    finally { picking.current = false; setCheckingMedia(false); }
  }

  async function createJob() {
    if (jobFlight.current || !canWrite || !detail || !selected.length) return;
    jobFlight.current = true;
    setCreating(true);
    setError("");
    try { const job = await client.createJob(project.id, profile, selected.map((asset) => asset.id)); onJob(job.id, { assets: selected, profile }); }
    catch (reason) { setError(explainError(reason, "创建任务失败")); }
    finally { jobFlight.current = false; setCreating(false); }
  }

  function choose(assets: Asset[], imagesOnly = false) {
    try { setSelected(selectWorkspaceAssets(selected, assets, imagesOnly)); setError(""); }
    catch (reason) { Alert.alert("无法选择素材", explainError(reason, "请检查已选素材")); }
  }

  function pageControls(label: string, pages: string[], next: string | null, setPages: (pages: string[]) => void) {
    if (pages.length === 1 && !next) return null;
    const move = (cursor?: string) => { setPageLoading(true); setPages(cursor ? [...pages, cursor] : pages.slice(0, -1)); };
    return <View style={styles.rowHeader}>
      <Button tone="ghost" label={`${label}上一页`} disabled={pageLoading || pages.length === 1} onPress={() => move()} />
      <Text style={textStyles.muted}>第 {pages.length} 页</Text>
      <Button tone="ghost" label={`${label}下一页`} disabled={pageLoading || !next} onPress={() => { if (next) move(next); }} />
    </View>;
  }

  return (
    <Screen scroll title={detail?.name ?? project.name} footer={canWrite ? <View style={styles.selectionBar}>
      <View style={styles.selectionText}>
        <Text accessibilityLiveRegion="polite" style={textStyles.body}>已选 {selected.length} 个 · {(selectionBytes(selected) / 1024 ** 2).toFixed(1)} MiB</Text>
        <Text style={textStyles.muted}>{RECONSTRUCTION_PROFILES[profile].title}{workerOnline === false ? " · 离线排队" : ""}</Text>
      </View>
      <Button disabled={creating || !selected.length} label={creating ? "正在创建…" : "开始重建"} onPress={createJob} />
    </View> : null}>
      {error ? <Card>
        <ErrorText>{error}</ErrorText>
        <Button label="刷新项目" onPress={() => void load()} tone="ghost" />
      </Card> : null}
        {detail ? <View style={styles.projectHeader}>
          <Text style={textStyles.muted}>{ROLE_LABEL[detail.effective_role]} · {detail.asset_count} 个素材 · {detail.job_count} 个任务</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showManagement }} style={styles.action} onPress={() => setShowManagement((value) => !value)}>
            <Text style={styles.link}>{showManagement ? "收起管理" : canManage ? "项目管理" : "查看成员"}</Text>
          </Pressable>
        </View> : <Text style={textStyles.muted}>加载中…</Text>}
        {showManagement && canManage ? <Card>
          <Field label="项目名称" value={name} onChangeText={setName} />
          <Button disabled={busy || !name.trim() || name.trim() === detail?.name} label="保存名称" onPress={() => void mutate(async () => { await client.updateProject(project.id, name.trim()); await load(); })} />
          <Button disabled={busy} label="删除项目" tone="ghost" onPress={() => Alert.alert("删除项目", "确定删除此项目？此操作无法撤销。", [
            { text: "取消", style: "cancel" },
            { text: "删除", style: "destructive", onPress: () => void mutate(async () => { await client.deleteProject(project.id); onBack(); }) },
          ])} />
        </Card> : null}
        {showManagement && detail ? <Card>
          <Text accessibilityRole="header" style={textStyles.heading}>成员</Text>
          {members.map((member) => <View key={member.user_id} style={{ paddingVertical: 8 }}>
            <Text style={textStyles.body}>{member.email} · {member.role}</Text>
            {canManage && member.role !== "owner" ? <>
              <Button disabled={busy} tone="ghost" label={member.role === "member" ? "改为查看者" : "改为成员"} onPress={() => void mutate(async () => { await client.updateMemberRole(project.id, member.user_id, member.role === "member" ? "viewer" : "member"); await load(); })} />
              <Button disabled={busy} tone="ghost" label="移除成员" onPress={() => Alert.alert("移除成员", `确定移除 ${member.email}？`, [
                { text: "取消", style: "cancel" },
                { text: "移除", style: "destructive", onPress: () => void mutate(async () => { await client.removeMember(project.id, member.user_id); await load(); }) },
              ])} />
            </> : null}
          </View>)}
          {canManage ? <>
            <Field label="成员邮箱" value={email} onChangeText={setEmail} />
            <Pressable onPress={() => setRole(role === "member" ? "viewer" : "member")}><Text style={textStyles.body}>角色：{role}（点击切换）</Text></Pressable>
            <Button disabled={busy || !email.trim()} label="签发邀请" onPress={() => void mutate(async () => {
              const context = invitationContext.current;
              setIssuedInvitation(null);
              setInviteNotice("");
              const added = await client.addMember(project.id, email.trim(), role);
              if (context !== invitationContext.current) return;
              setEmail("");
              if (added.status === "member") setInviteNotice("该账号已是项目成员，可在成员列表调整角色。");
              else if (added.claim_code) setIssuedInvitation({ email: added.email, code: added.claim_code });
              else setInviteNotice("当前服务端版本无法提供领取码。请在升级后重新签发邀请。");
            }, "签发邀请失败")} />
            {inviteNotice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{inviteNotice}</Text> : null}
            {issuedInvitation ? <View>
              <Text accessibilityLiveRegion="polite" style={textStyles.body}>请将领取码交给 {issuedInvitation.email}。领取码 7 天内有效，仅可使用一次。</Text>
              <Text selectable style={textStyles.body}>{issuedInvitation.code}</Text>
            </View> : null}
          </> : null}
        </Card> : null}
        {detail ? <Card>
          <View style={styles.rowHeader}>
            <Text accessibilityRole="header" style={textStyles.heading}>素材</Text>
            {canWrite ? <Text style={styles.link}>已选 {selected.length} 个</Text> : null}
          </View>
          {canWrite && detail.assets.length > 0 ? <View style={styles.rowHeader}>
            <Button tone="ghost" label="全选本页图片" onPress={() => choose(detail.assets, true)} />
            <Button tone="ghost" disabled={!selected.length} label="清空选择" onPress={() => setSelected([])} />
          </View> : null}
          {canWrite ? <>
            <Button disabled={checkingMedia} label={checkingMedia ? "正在检查素材…" : "选择图片或视频上传"} onPress={pickAndUpload} />
            <Text style={textStyles.muted}>一组 JPG / PNG 图片或一个视频。单文件 ≤ 5 GiB，单任务 ≤ 8 GiB。</Text>
          </> : null}
          {uploads.map((item) => <View key={item.id}>
            <Text style={textStyles.muted}>{item.file.name} · {item.progress}% · {item.status === "failed" ? "失败" : item.status === "done" ? "完成" : "上传中"}</Text>
            {item.error ? <Text style={textStyles.error}>{item.error}</Text> : null}
            {item.status === "failed" ? <Button label="重试上传" onPress={() => void runUpload(item.id, item.file)} tone="ghost" /> : null}
          </View>)}
          {!detail.assets.length && !uploads.length ? <Text style={textStyles.muted}>暂无素材</Text> : null}
          <View style={styles.assetGrid}>
          {detail.assets.map((asset) => <View key={asset.id} style={[styles.asset, selected.some((item) => item.id === asset.id) && styles.selected]}>
            <AssetThumbnail asset={asset} />
            <Pressable
              accessibilityRole={canWrite ? "checkbox" : undefined}
              accessibilityState={canWrite ? { checked: selected.some((item) => item.id === asset.id), disabled: asset.status !== "READY" } : undefined}
              disabled={!canWrite || asset.status !== "READY"}
              onPress={() => choose([asset])}
              style={styles.assetChoice}
            >
              <Text numberOfLines={2} style={textStyles.body}>{asset.filename}</Text>
              <Text style={textStyles.muted}>{selected.some((item) => item.id === asset.id) ? "已选" : ASSET_STATUS_LABELS[asset.status]}</Text>
            </Pressable>
            {canWrite ? <Pressable
              accessibilityRole="button"
              accessibilityLabel={`删除 ${asset.filename}`}
              onPress={() => Alert.alert("删除素材", `确定删除「${asset.filename}」？`, [
                { text: "取消", style: "cancel" },
                { text: "删除", style: "destructive", onPress: () => void mutate(async () => { await client.deleteAsset(asset.id); setSelected((items) => items.filter((item) => item.id !== asset.id)); await load(); }, "删除失败，请稍后重试。") },
              ])}
              style={styles.action}
            >
              <Text style={textStyles.error}>删除</Text>
            </Pressable> : null}
          </View>)}
          </View>
          {pageControls("素材", assetPages, detail.nextAssetCursor, setAssetPages)}
        </Card> : null}
        {canWrite ? <Card>
          <Text accessibilityRole="header" style={textStyles.heading}>重建路线</Text>
          {PROFILES.map((value) => {
            const option = RECONSTRUCTION_PROFILES[value];
            return (
              <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: profile === value }} style={[styles.route, profile === value && styles.selected]} onPress={() => setProfile(value)}>
                <Text style={profile === value ? styles.link : textStyles.body}>{option.title} · {value.toUpperCase()}</Text>
                <Text style={textStyles.muted}>{option.description} · 最多 {option.frames} 帧</Text>
              </Pressable>
            );
          })}
          <Text style={workerOnline ? styles.online : textStyles.muted}>
            {workerOnline === true ? "计算节点在线" : workerOnline === false ? "计算节点离线，提交后排队" : "计算节点状态未知"}
          </Text>
          {!selected.length ? <Text style={textStyles.muted}>请先从素材列表选择要重建的文件</Text> : null}
        </Card> : null}
        <Card>
          <Text accessibilityRole="header" style={textStyles.heading}>任务历史</Text>
          {timeline.length > 0 ? <>
            <Text style={textStyles.muted}>最近任务阶段</Text>
            {timeline.map((row) => <View key={row.key} style={{ paddingVertical: 8 }}>
              <Text style={textStyles.body}>{stageLabel(row.stage)} · {row.status} · {Math.round(row.progress * 100)}%</Text>
              {row.message ? <Text style={textStyles.muted}>{row.message}</Text> : null}
              {Object.keys(row.metrics).length > 0 ? <Text style={textStyles.muted}>{JSON.stringify(row.metrics)}</Text> : null}
            </View>)}
          </> : null}
          {!detail?.jobs.length ? <Text style={textStyles.muted}>暂无任务。</Text> : null}
          {detail?.jobs.map((job) => <Pressable accessibilityRole="button" key={job.id} onPress={() => onJob(job.id, { assets: selected, profile })} style={styles.route}>
            <View style={styles.rowHeader}>
              <Text style={textStyles.body}>{RECONSTRUCTION_PROFILES[job.profile].title}</Text>
              <Text style={job.status === "FAILED" ? textStyles.error : styles.link}>{JOB_STATUS_LABELS[job.status]}</Text>
            </View>
            <Text style={textStyles.muted}>{new Date(job.created_at).toLocaleString()} · {job.id.slice(0, 8)}</Text>
          </Pressable>)}
          {detail ? pageControls("任务", jobPages, detail.nextJobCursor, setJobPages) : null}
        </Card>
        <Button label="返回项目列表" onPress={onBack} tone="ghost" />
    </Screen>
  );
}

const makeStyles = (theme: Palette) => StyleSheet.create({
  projectHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: "space-between" },
  rowHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: "space-between" },
  action: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 8 },
  link: { color: theme.accent, fontWeight: "600" },
  online: { color: theme.success },
  assetGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  asset: { width: "48.5%", overflow: "hidden", borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 12 },
  assetChoice: { flex: 1, minHeight: 48, padding: 10, gap: 4 },
  selectionBar: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: theme.borderSoft, backgroundColor: theme.panel },
  selectionText: { flex: 1, gap: 3 },
  selected: { borderColor: theme.accent, backgroundColor: theme.surfaceStrong },
  route: { gap: 5, minHeight: 48, padding: 12, borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 12 },
});
