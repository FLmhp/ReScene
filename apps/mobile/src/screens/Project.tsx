import { explainError, isOfflineError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, stageLabel } from "@rescene/schemas";
import type { Asset, MemberRole, Profile, ProjectDetail, ProjectMember } from "@rescene/schemas";
import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { client } from "../api";
import { AssetThumbnail } from "../AssetThumbnail";
import { enqueue, loadQueue, replayQueued, saveQueue } from "../queue";
import { useAppearance } from "../appearance";
import type { Palette } from "@rescene/design-tokens";
import { type PickedFile, uploadFile } from "../upload";
import { Button, Card, ErrorText, Field, Screen, useTextStyles } from "../ui";

const PROFILES: Profile[] = ["fast", "balanced", "quality"];
const ROLE_LABEL = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };
type Upload = { id: string; file: PickedFile; progress: number; status: "uploading" | "failed" | "done"; error?: string };
type TimelineRow = { key: string; stage: string; status: string; progress: number; message?: string | null; metrics: Record<string, unknown> };

// Asset responses contain filenames but not MIME types.
function mediaType(asset: Asset): "image" | "video" | null {
  const extension = asset.filename.split(".").pop()?.toLowerCase();
  if (extension && ["jpg", "jpeg", "png"].includes(extension)) return "image";
  if (extension && ["mp4", "mov", "mkv", "avi", "webm", "m4v"].includes(extension)) return "video";
  return null;
}

export function ProjectScreen({ project, onJob, onBack }: {
  project: { id: string; name: string };
  onJob: (jobId: string) => void;
  onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const styles = makeStyles(theme);
  const [showManagement, setShowManagement] = useState(false);
  const [visibleAssets, setVisibleAssets] = useState(24);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile>("balanced");
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
  const replayed = useRef(false);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [inviteNotice, setInviteNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [next, nextMembers] = await Promise.all([client.getProject(project.id), client.listMembers(project.id)]);
      setDetail(next);
      setName(next.name);
      setMembers(nextMembers);
      setSelected((current) => current.filter((id) => next.assets.some((asset) => asset.id === id && asset.status === "READY")));
    } catch (reason) {
      setError(explainError(reason, "加载失败"));
    }
  }, [project.id]);
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

  const latestJobId = detail?.jobs[0]?.id;
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
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, type: ["image/*", "video/*"], copyToCacheDirectory: true });
      if (result.canceled) return;
      for (const asset of result.assets) {
        if (!asset.size) { setError(`${asset.name} 无法读取文件大小，请重新选择`); continue; }
        const file: PickedFile = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/octet-stream", size: asset.size };
        const id = `${Date.now()}-${++uploadSequence.current}`;
        await enqueue({ kind: "upload", id, projectId: project.id, uri: file.uri, name: file.name, mimeType: file.mimeType, size: file.size, createdAt: Date.now() });
        setUploads((current) => [...current, { id, file, progress: 0, status: "uploading" }]);
        void runUpload(id, file);
      }
    } catch (reason) { setError(explainError(reason, "选择文件失败")); }
  }

  async function createJob() {
    if (jobFlight.current || !canWrite || !detail || !selected.length) return;
    const assets = selected.map((id) => detail.assets.find((asset) => asset.id === id));
    const types = assets.map((asset) => asset && mediaType(asset));
    const singleVideo = types.length === 1 && types[0] === "video";
    const imagesOnly = types.every((type) => type === "image");
    if (assets.some((asset) => !asset || asset.status !== "READY") || !(singleVideo || imagesOnly)) {
      setError("请选择一组已就绪的图片，或一个视频。");
      return;
    }
    jobFlight.current = true;
    setCreating(true);
    setError("");
    try { const job = await client.createJob(project.id, profile, selected); onJob(job.id); }
    catch (reason) { setError(explainError(reason, "创建任务失败")); }
    finally { jobFlight.current = false; setCreating(false); }
  }

  function toggleAsset(asset: Asset) {
    if (asset.status !== "READY") return;
    if (selected.includes(asset.id)) { setSelected((current) => current.filter((id) => id !== asset.id)); return; }
    const type = mediaType(asset);
    const first = detail?.assets.find((item) => item.id === selected[0]);
    const currentType = first ? mediaType(first) : null;
    if (!type || (selected.length > 0 && (type === "video" || currentType === "video" || currentType !== type))) {
      setError("请选择一组图片，或一个视频。");
      return;
    }
    setError("");
    setSelected((current) => [...current, asset.id]);
  }

  return (
    <Screen scroll title={detail?.name ?? project.name}>
      {error ? <Card>
        <ErrorText>{error}</ErrorText>
        <Button label="刷新项目" onPress={() => void load()} tone="ghost" />
      </Card> : null}
        {detail ? <View style={styles.projectHeader}>
          <Text style={textStyles.muted}>{ROLE_LABEL[detail.effective_role]} · {detail.assets.length} 个素材 · {detail.jobs.length} 个任务</Text>
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
            <Button disabled={busy || !email.trim()} label="添加成员" onPress={() => void mutate(async () => {
              const added = await client.addMember(project.id, email.trim(), role);
              setEmail("");
              if (added.status === "invited") { setInviteNotice(`已邀请 ${added.email}，对方注册后自动加入。`); return; }
              setInviteNotice("");
              await load();
            })} />
            {inviteNotice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{inviteNotice}</Text> : null}
          </> : null}
        </Card> : null}
        {detail ? <Card>
          <View style={styles.rowHeader}>
            <Text accessibilityRole="header" style={textStyles.heading}>素材</Text>
            {canWrite ? <Text style={styles.link}>已选 {selected.length} 个</Text> : null}
          </View>
          {canWrite && detail.assets.length > 0 ? <View style={styles.rowHeader}>
            <Button tone="ghost" label="全选图片" onPress={() => setSelected(detail.assets.filter((asset) => asset.status === "READY" && mediaType(asset) === "image").map((asset) => asset.id))} />
            <Button tone="ghost" disabled={!selected.length} label="清空选择" onPress={() => setSelected([])} />
          </View> : null}
          {canWrite ? <>
            <Button label="选择图片或视频上传" onPress={pickAndUpload} />
            <Text style={textStyles.muted}>一组 JPG / PNG 图片或一个视频。单文件 ≤ 5 GiB，单任务 ≤ 8 GiB。</Text>
          </> : null}
          {uploads.map((item) => <View key={item.id}>
            <Text style={textStyles.muted}>{item.file.name} · {item.progress}% · {item.status === "failed" ? "失败" : item.status === "done" ? "完成" : "上传中"}</Text>
            {item.error ? <Text style={textStyles.error}>{item.error}</Text> : null}
            {item.status === "failed" ? <Button label="重试上传" onPress={() => void runUpload(item.id, item.file)} tone="ghost" /> : null}
          </View>)}
          {!detail.assets.length && !uploads.length ? <Text style={textStyles.muted}>暂无素材</Text> : null}
          {detail.assets.slice(0, visibleAssets).map((asset) => <View key={asset.id} style={[styles.asset, selected.includes(asset.id) && styles.selected]}>
            <AssetThumbnail asset={asset} />
            <Pressable
              accessibilityRole={canWrite ? "checkbox" : undefined}
              accessibilityState={canWrite ? { checked: selected.includes(asset.id), disabled: asset.status !== "READY" } : undefined}
              disabled={!canWrite || asset.status !== "READY"}
              onPress={() => toggleAsset(asset)}
              style={styles.assetChoice}
            >
              <Text style={textStyles.body}>{asset.filename}</Text>
              <Text style={textStyles.muted}>{selected.includes(asset.id) ? "已选" : ASSET_STATUS_LABELS[asset.status]}{!mediaType(asset) ? " · 未知媒体类型" : ""}</Text>
            </Pressable>
            {canWrite ? <Pressable
              accessibilityRole="button"
              accessibilityLabel={`删除 ${asset.filename}`}
              onPress={() => Alert.alert("删除素材", `确定删除「${asset.filename}」？`, [
                { text: "取消", style: "cancel" },
                { text: "删除", style: "destructive", onPress: () => void mutate(async () => { await client.deleteAsset(asset.id); await load(); }, "删除失败，请稍后重试。") },
              ])}
              style={styles.action}
            >
              <Text style={textStyles.error}>删除</Text>
            </Pressable> : null}
          </View>)}
          {detail.assets.length > visibleAssets ? <Button tone="ghost" label={`加载更多素材（${visibleAssets}/${detail.assets.length}）`} onPress={() => setVisibleAssets((count) => count + 24)} /> : null}
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
          {workerOnline != null ? <Text style={workerOnline ? styles.online : textStyles.muted}>
            {workerOnline ? "计算节点在线" : "计算节点离线，提交后排队"}
          </Text> : null}
          <Button disabled={creating || !selected.length} label={creating ? "正在创建…" : selected.length ? `开始重建（${selected.length}）` : "开始重建"} onPress={createJob} />
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
          {detail?.jobs.map((job) => <Pressable accessibilityRole="button" key={job.id} onPress={() => onJob(job.id)} style={styles.route}>
            <View style={styles.rowHeader}>
              <Text style={textStyles.body}>{RECONSTRUCTION_PROFILES[job.profile].title}</Text>
              <Text style={job.status === "FAILED" ? textStyles.error : styles.link}>{JOB_STATUS_LABELS[job.status]}</Text>
            </View>
            <Text style={textStyles.muted}>{new Date(job.created_at).toLocaleString()} · {job.id.slice(0, 8)}</Text>
          </Pressable>)}
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
  asset: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: theme.divider, borderRadius: 12 },
  assetChoice: { flex: 1, minHeight: 48, padding: 10, gap: 4 },
  selected: { borderColor: theme.accent, backgroundColor: theme.surfaceStrong },
  route: { gap: 5, minHeight: 48, padding: 12, borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 12 },
});
