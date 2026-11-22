import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { ASSET_STATUS_LABELS, JOB_STATUS_LABELS, PROJECT_SECTIONS, RECONSTRUCTION_PROFILES, reconcileWorkspaceSelection, selectWorkspaceAssets, selectionBytes } from "@rescene/schemas";
import type { Asset, MemberRole, Profile, ProjectSection, ProjectWorkspace, ProjectMember } from "@rescene/schemas";
import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, AppState, Pressable, StyleSheet, View } from "react-native";

import { assertQueueOwner, client, currentQueueOwner, isQueueOwnerCurrent } from "../api";
import { AssetThumbnail } from "../AssetThumbnail";
import { discardQueued, enqueue, replayQueued, uploadQueued } from "../queue";
import { useAppearance } from "../appearance";
import type { Palette } from "@rescene/design-tokens";
import { isQueuedMediaMissing, MediaPreflightError, mediaType, newIdempotencyKey, QUEUE_PAUSED, summarizeMediaWarnings, uploadErrorCode, type QueueOwner } from "@rescene/uploader";
import { inspectPickedFiles, isStorageShortage, persistPickedFile, removeManagedMedia, type PickedFile } from "../upload";
import { Button, Card, ErrorText, Field, ScaledText as Text, Screen, useTextStyles } from "../ui";

const PROFILES: Profile[] = ["fast", "balanced", "quality"];
const ROLE_LABEL = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };
const FORM_WIDTH = { maxWidth: 560, width: "100%" as const, alignSelf: "center" as const };
type Upload = { owner: QueueOwner; id: string; file: PickedFile; progress: number; status: "uploading" | "failed" | "done"; error?: string };
type PageRequest = { kind: "assets" | "jobs"; stack: string[]; projectId: string };

export type ProjectDraft = { assets: Asset[]; profile: Profile; section: ProjectSection; assetPages: string[]; jobPages: string[] };

export function ProjectScreen({ project, draft, page, backLabel = "返回项目列表", onJob, onBack, onConfigure, onManagement, onNavigateRoot, materialsRequest }: {
  project: { id: string; name: string };
  draft?: ProjectDraft;
  page: "project" | "configure" | "project-management" | null;
  backLabel?: string;
  onJob: (jobId: string, draft: ProjectDraft, entry: "job" | "result") => void;
  onBack: () => void;
  onConfigure: () => void;
  onManagement: () => void;
  onNavigateRoot: (page: "projects" | "notifications" | "settings") => void;
  materialsRequest?: number;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const styles = makeStyles(theme);
  const [section, setSection] = useState<ProjectSection>(draft?.section ?? "materials");
  useEffect(() => { if (materialsRequest) setSection("materials"); }, [materialsRequest]);
  const [assetPages, setAssetPages] = useState(draft?.assetPages ?? [""]);
  const [jobPages, setJobPages] = useState(draft?.jobPages ?? [""]);
  const committedPages = useRef({ assets: draft?.assetPages ?? [""], jobs: draft?.jobPages ?? [""] });
  const pendingPage = useRef<PageRequest | null>(null);
  const [loadingPage, setLoadingPage] = useState<PageRequest | null>(null);
  const [failedPage, setFailedPage] = useState<PageRequest | null>(null);
  const [scrollReset, setScrollReset] = useState(0);
  useEffect(() => { setScrollReset((value) => value + 1); }, [section]);
  const requestId = useRef(0);
  const membersRequest = useRef(0);
  const [membersError, setMembersError] = useState("");
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
  const jobAttempt = useRef<{ signature: string; key: string } | null>(null);
  const uploadSequence = useRef(0);
  const picking = useRef(false);
  const uploadLock = useRef(false);
  const [checkingMedia, setCheckingMedia] = useState(false);
  const [uploading, setUploading] = useState(false);
  const replayed = useRef(false);
  const [inviteNotice, setInviteNotice] = useState("");
  const [issuedInvitation, setIssuedInvitation] = useState<{ email: string; code: string } | null>(null);
  const invitationContext = useRef(0);
  const [error, setError] = useState("");
  const [errorPage, setErrorPage] = useState<typeof page>(page);
  const pageRef = useRef(page);
  pageRef.current = page;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const clearError = useCallback(() => { setError(""); setErrorPage(null); }, []);
  const fail = useCallback((text: string, scope: typeof page = pageRef.current) => { setError(text); setErrorPage(scope); }, []);

  useEffect(() => {
    setIssuedInvitation(null);
    return () => { invitationContext.current += 1; };
  }, [project.id, page]);
  useEffect(() => {
    if (!issuedInvitation) return;
    const timer = setTimeout(() => setIssuedInvitation(null), 120_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setIssuedInvitation(null);
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [issuedInvitation]);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    const candidate = pendingPage.current;
    const scope = candidate ? "project" : pageRef.current;
    const assets = candidate?.kind === "assets" ? candidate.stack : committedPages.current.assets;
    const jobs = candidate?.kind === "jobs" ? candidate.stack : committedPages.current.jobs;
    try {
      const next = await client.getWorkspace(project.id, assets[assets.length - 1], jobs[jobs.length - 1]);
      if (request !== requestId.current || candidate !== pendingPage.current) return;
      setDetail(next);
      setName(next.name);
      setSelected((current) => reconcileWorkspaceSelection(current, next.assets));
      clearError();
      if (candidate) {
        committedPages.current = { assets, jobs };
        setAssetPages(assets);
        setJobPages(jobs);
        pendingPage.current = null;
        setLoadingPage(null);
        setFailedPage(null);
        setScrollReset((value) => value + 1);
        AccessibilityInfo.announceForAccessibility(`${candidate.kind === "assets" ? "素材" : "任务"}列表第 ${candidate.stack.length} 页已加载`);
      }
    } catch (reason) {
      if (request !== requestId.current || candidate !== pendingPage.current) return;
      if (reason instanceof ResceneApiError && [401, 403, 404].includes(reason.status)) setDetail(null);
      if (candidate) {
        pendingPage.current = null;
        setLoadingPage(null);
        setFailedPage(candidate);
        fail(`无法加载第 ${candidate.stack.length} 页：${explainError(reason, "请重试")}`, scope);
      } else fail(explainError(reason, "加载失败"), scope);
    }
  }, [clearError, fail, project.id]);
  useEffect(() => { void load(); return () => { requestId.current += 1; pendingPage.current = null; }; }, [load]);
  const previousPage = useRef(page);
  useEffect(() => {
    const returned = previousPage.current !== page && page === "project";
    previousPage.current = page;
    if (returned) void load();
  }, [load, page]);
  const loadMembers = useCallback(async () => {
    const request = ++membersRequest.current;
    setMembersError("");
    try {
      const next = await client.listMembers(project.id);
      if (request === membersRequest.current) setMembers(next);
    } catch (reason) {
      if (request === membersRequest.current) setMembersError(explainError(reason, "加载成员失败"));
    }
  }, [project.id]);
  useEffect(() => {
    if (page !== "project-management") return;
    void loadMembers();
    return () => { membersRequest.current += 1; };
  }, [loadMembers, page]);
  useEffect(() => {
    if (page !== "configure") return;
    if (detailRef.current) void load();
    let active = true;
    async function refreshWorker() {
      const status = await client.getWorkerStatus().catch(() => null);
      if (active) setWorkerOnline(status?.online ?? null);
    }
    void refreshWorker();
    const timer = setInterval(() => void refreshWorker(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [load, page]);

  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    const owner = currentQueueOwner();
    if (!owner) return;
    void replayQueued(owner, () => undefined).then(({ uploaded }) => {
      if (isQueueOwnerCurrent(owner) && uploaded) void load();
    }).catch(() => undefined);
  }, [load]);

  const canManage = detail?.effective_role === "owner" || detail?.effective_role === "admin";
  const canWrite = canManage || detail?.effective_role === "member";
  const errorVisible = Boolean(error) && !failedPage && (errorPage === page || !detail);

  async function mutate(action: () => Promise<void>, fallback = "操作失败") {
    if (mutationFlight.current) return;
    const scope = pageRef.current;
    mutationFlight.current = true;
    setBusy(true);
    clearError();
    try { await action(); } catch (reason) { fail(explainError(reason, fallback), scope); }
    finally { mutationFlight.current = false; setBusy(false); }
  }

  async function runUpload(owner: QueueOwner, id: string) {
    if (!isQueueOwnerCurrent(owner)) return;
    setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "uploading", progress: 0, error: undefined } : item));
    try {
      await uploadQueued(owner, id, (progress) => setUploads((current) => current.map((item) => item.id === id ? { ...item, progress } : item)));
      if (!isQueueOwnerCurrent(owner)) return;
      setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "done", progress: 100 } : item));
      await load();
    } catch (reason) {
      if (!isQueueOwnerCurrent(owner)) return;
      const error = isQueuedMediaMissing(reason)
        ? "本地素材副本已丢失，请移除后重新选择。"
        : isStorageShortage(reason) ? "设备存储不足，请清理空间后重试。"
        : uploadErrorCode(reason) === "asset.upload_hash_mismatch"
          ? "本地文件与已上传内容不一致，请移除后重新选择该文件。"
          : isOfflineError(reason) ? "已保存，联网后自动重试。" : explainError(reason, "上传失败");
      setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error } : item));
    }
  }

  /**
   * One whole-file body is built per upload, so a batch must not start them
   * together: 50 selected videos would need 50x the file size in cache.
   */
  async function runUploads(owner: QueueOwner, ids: string[]) {
    if (uploadLock.current || !isQueueOwnerCurrent(owner)) return;
    uploadLock.current = true;
    setUploading(true);
    try {
      for (const id of ids) {
        if (!isQueueOwnerCurrent(owner)) return;
        await runUpload(owner, id);
      }
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  }

  async function abandonUpload(item: Upload) {
    const scope = pageRef.current;
    try {
      await discardQueued(item.owner, item.id);
      setUploads((current) => current.filter((row) => row.id !== item.id));
    } catch (reason) { fail(explainError(reason, "移除失败"), scope); }
  }

  async function pickAndUpload() {
    if (picking.current || uploadLock.current || !canWrite) return;
    const scope = pageRef.current;
    const owner = currentQueueOwner();
    if (!owner) { fail(QUEUE_PAUSED, scope); return; }
    picking.current = true;
    setCheckingMedia(true);
    const queuedIds: string[] = [];
    try {
      clearError();
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, type: ["image/*", "video/*"], copyToCacheDirectory: true });
      if (result.canceled) return;
      const files = result.assets.map((asset): PickedFile => ({
        uri: asset.uri, name: asset.name, mimeType: mediaType(asset.name) ?? "application/octet-stream", size: asset.size ?? 0,
      }));
      const warnings = await inspectPickedFiles(files);
      assertQueueOwner(owner);
      if (warnings.length) {
        const confirmed = await new Promise<boolean>((resolve) => Alert.alert("素材检查提示", summarizeMediaWarnings(warnings), [
          { text: "重新选择", style: "cancel", onPress: () => resolve(false) },
          { text: "仍然上传", onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) }));
        if (!confirmed) return;
      }
      for (const file of files) {
        const id = `${Date.now()}-${++uploadSequence.current}`;
        let stored: { uri: string; size: number };
        try {
          stored = await persistPickedFile(owner, id, file);
        } catch (reason) {
          if (isQueueOwnerCurrent(owner)) fail(explainError(reason, `无法保存 ${file.name}，请检查设备存储后重新选择。`), scope);
          continue;
        }
        try {
          await enqueue(owner, { kind: "upload", id, projectId: project.id, uri: stored.uri, name: file.name, mimeType: file.mimeType, size: stored.size, managed: true, createdAt: Date.now() });
        } catch (reason) {
          await removeManagedMedia(stored.uri);
          throw reason;
        }
        if (!isQueueOwnerCurrent(owner)) return;
        setUploads((current) => [...current, { owner, id, file: { ...file, uri: stored.uri, size: stored.size }, progress: 0, status: "uploading" }]);
        queuedIds.push(id);
      }
      if (queuedIds.length) {
        setCheckingMedia(false);
        await runUploads(owner, queuedIds);
      }
    } catch (reason) { if (isQueueOwnerCurrent(owner)) fail(reason instanceof MediaPreflightError ? reason.message : explainError(reason, "选择文件失败"), scope); }
    finally { picking.current = false; setCheckingMedia(false); }
  }

  async function createJob() {
    if (jobFlight.current || !canWrite || !detail || !selected.length || picking.current || uploadLock.current) return;
    const owner = currentQueueOwner();
    if (!owner) { fail(QUEUE_PAUSED, pageRef.current); return; }
    const scope = pageRef.current;
    jobFlight.current = true;
    setCreating(true);
    clearError();
    const ids = selected.map((asset) => asset.id);
    const signature = JSON.stringify([profile, [...ids].sort()]);
    const attempt = jobAttempt.current?.signature === signature ? jobAttempt.current : { signature, key: newIdempotencyKey() };
    jobAttempt.current = attempt;
    try {
      const job = await client.createJob(project.id, profile, ids, attempt.key);
      if (!isQueueOwnerCurrent(owner)) return;
      jobAttempt.current = null;
      setSection("tasks");
      onJob(job.id, { assets: selected, profile, section: "tasks", assetPages, jobPages }, "job");
    } catch (reason) { fail(explainError(reason, "创建任务失败"), scope); }
    finally { jobFlight.current = false; setCreating(false); }
  }

  function choose(assets: Asset[], imagesOnly = false) {
    try { setSelected(selectWorkspaceAssets(selected, assets, imagesOnly)); clearError(); }
    catch (reason) { Alert.alert("无法选择素材", explainError(reason, "请检查已选素材")); }
  }

  function requestPage(candidate: PageRequest) {
    if (pendingPage.current || candidate.projectId !== project.id) return;
    pendingPage.current = candidate;
    setLoadingPage(candidate);
    setFailedPage(null);
    clearError();
    void load();
  }

  function pageControls(kind: "assets" | "jobs", pages: string[], next: string | null) {
    if (pages.length === 1 && !next && !loadingPage && !failedPage) return null;
    const move = (cursor?: string) => {
      if (cursor && pages.includes(cursor)) return;
      requestPage({ kind, stack: cursor ? [...pages, cursor] : pages.slice(0, -1), projectId: project.id });
    };
    return <View>
      <View style={styles.rowHeader}>
        <Button tone="ghost" label="上一页" disabled={!!loadingPage || pages.length === 1} onPress={() => move()} />
        <Text style={textStyles.muted}>第 {pages.length} 页</Text>
        <Button tone="ghost" label="下一页" disabled={!!loadingPage || !next || pages.includes(next)} onPress={() => { if (next) move(next); }} />
      </View>
      {loadingPage?.kind === kind ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>正在加载第 {loadingPage.stack.length} 页…</Text> : null}
      {failedPage?.kind === kind ? <>
        <Text accessibilityRole="alert" style={textStyles.error}>{error}</Text>
        <Button tone="ghost" label="重试翻页" onPress={() => requestPage(failedPage)} />
      </> : null}
    </View>;
  }

  if (!page) return null;

  return (
    <Screen scroll scrollReset={scrollReset} title={page === "configure" ? "配置重建" : page === "project-management" ? (detail && !canManage ? "成员" : "项目管理") : detail?.name ?? project.name}
      onBack={onBack} backLabel={page === "configure" ? "返回素材" : page === "project" ? backLabel : "返回项目"}
      navigation={page === "project" ? <View style={styles.rowHeader}>
        <Button tone="ghost" label="项目列表" onPress={() => onNavigateRoot("projects")} />
        <Button tone="ghost" label="通知" onPress={() => onNavigateRoot("notifications")} />
        <Button tone="ghost" label="设置" onPress={() => onNavigateRoot("settings")} />
      </View> : undefined}
      toolbar={page === "project" ? <View style={styles.rowHeader}>{PROJECT_SECTIONS.map((item) => <Pressable key={item.value} accessibilityLabel={item.label} accessibilityRole="tab" accessibilityState={{ selected: section === item.value }} style={styles.action} onPress={() => setSection(item.value)}><Text style={section === item.value ? styles.link : textStyles.body}>{item.label}</Text></Pressable>)}</View> : undefined}
      footer={page === "project" && section === "materials" && canWrite ? <View style={styles.selectionBar}>
        <Text accessibilityLiveRegion="polite" style={textStyles.body}>已选 {selected.length} 个</Text>
        <Button disabled={!selected.length} label="配置重建" onPress={onConfigure} />
      </View> : null}>
      {errorVisible ? <Card>
        <ErrorText>{error}</ErrorText>
        <Button label="刷新项目" onPress={() => void load()} tone="ghost" />
      </Card> : null}
        {page === "project" && detail ? <View style={styles.projectHeader}>
          <Text style={textStyles.muted}>{ROLE_LABEL[detail.effective_role]} · {detail.asset_count} 个素材 · {detail.job_count} 个任务</Text>
          <Pressable accessibilityRole="button" style={styles.action} onPress={onManagement}>
            <Text style={styles.link}>{canManage ? "项目管理" : "查看成员"}</Text>
          </Pressable>
        </View> : !detail && !errorVisible ? <Text style={textStyles.muted}>加载中…</Text> : null}
        {page === "project-management" && canManage ? <Card style={FORM_WIDTH}>
          <Field label="项目名称" value={name} onChangeText={setName} />
          <Button disabled={busy || !name.trim() || name.trim() === detail?.name} label="保存名称" onPress={() => void mutate(async () => { await client.updateProject(project.id, name.trim()); await load(); })} />
          <Button disabled={busy} label="删除项目" tone="ghost" onPress={() => Alert.alert("删除项目", "确定删除此项目？此操作无法撤销。", [
            { text: "取消", style: "cancel" },
            { text: "删除", style: "destructive", onPress: () => void mutate(async () => { await client.deleteProject(project.id); onNavigateRoot("projects"); }) },
          ])} />
        </Card> : null}
        {page === "project-management" && detail ? <Card style={FORM_WIDTH}>
          <Text accessibilityRole="header" style={textStyles.heading}>成员</Text>
          {membersError ? <><ErrorText>{membersError}</ErrorText><Button tone="ghost" label="重试加载成员" onPress={() => void loadMembers()} /></> : null}
          {members.map((member) => <View key={member.user_id} style={{ paddingVertical: 8 }}>
            <Text style={textStyles.body}>{member.email} · {member.role}</Text>
            {canManage && member.role !== "owner" ? <>
              <Button disabled={busy} tone="ghost" label={member.role === "member" ? "改为查看者" : "改为成员"} onPress={() => void mutate(async () => { await client.updateMemberRole(project.id, member.user_id, member.role === "member" ? "viewer" : "member"); await loadMembers(); })} />
              <Button disabled={busy} tone="ghost" label="移除成员" onPress={() => Alert.alert("移除成员", `确定移除 ${member.email}？`, [
                { text: "取消", style: "cancel" },
                { text: "移除", style: "destructive", onPress: () => void mutate(async () => { await client.removeMember(project.id, member.user_id); await loadMembers(); }) },
              ])} />
            </> : null}
          </View>)}
          {canManage ? <>
            <Field label="成员邮箱" value={email} onChangeText={setEmail} />
            <Pressable accessibilityRole="button" style={styles.roleChoice} onPress={() => setRole(role === "member" ? "viewer" : "member")}><Text style={textStyles.body}>角色：{ROLE_LABEL[role]}（点击切换）</Text></Pressable>
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
        {page === "project" && section === "materials" && detail ? <Card>
          <View style={styles.rowHeader}>
            <Text accessibilityRole="header" style={textStyles.heading}>素材</Text>
          </View>
          {canWrite ? <>
            <Button tone="ghost" disabled={checkingMedia || uploading} label={checkingMedia ? "正在检查素材…" : uploading ? "正在上传…" : "选择图片或视频上传"} onPress={pickAndUpload} />
            <Text style={textStyles.muted}>一组 JPG / PNG 图片或一个视频。单文件 ≤ 5 GiB，单任务 ≤ 8 GiB。</Text>
          </> : null}
          {canWrite && (selected.length > 0 || detail.assets.some((asset) => asset.status === "READY")) ? <View style={styles.rowHeader}>
            {detail.assets.some((asset) => asset.status === "READY") ? <Button tone="ghost" label="全选本页图片" onPress={() => choose(detail.assets, true)} /> : null}
            <Button tone="ghost" disabled={!selected.length} label="清空选择" onPress={() => setSelected([])} />
          </View> : null}
          {uploads.map((item) => <View key={item.id}>
            <Text style={textStyles.muted}>{item.file.name} · {item.progress}% · {item.status === "failed" ? "失败" : item.status === "done" ? "完成" : "上传中"}</Text>
            {item.error ? <Text style={textStyles.error}>{item.error}</Text> : null}
            {item.status === "failed" ? <Button disabled={uploading} label="重试上传" onPress={() => void runUploads(item.owner, [item.id])} tone="ghost" /> : null}
            {item.status === "failed" ? <Button label="移除此项" onPress={() => void abandonUpload(item)} tone="ghost" /> : null}
          </View>)}
          {!detail.assets.length && !uploads.length ? <Text style={textStyles.muted}>暂无素材</Text> : null}
          {detail.assets.length > 0 && !detail.assets.some((asset) => asset.status === "READY") ? <Text style={textStyles.muted}>本页素材尚未处理完成，暂时不能选择。</Text> : null}
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
          {pageControls("assets", assetPages, detail.nextAssetCursor)}
        </Card> : null}
        {page === "configure" ? <Card style={FORM_WIDTH}>
          <Text style={textStyles.body}>已选 {selected.length} 个 · {(selectionBytes(selected) / 1024 ** 2).toFixed(1)} MiB</Text>
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
          {!selected.length ? <Text style={textStyles.muted}>请返回素材列表选择要重建的文件。</Text> : null}
          {detail && !canWrite ? <Text style={textStyles.muted}>当前权限不允许创建任务，请返回素材页。</Text> : null}
          {checkingMedia || uploading ? <Text style={textStyles.muted}>请等待素材上传完成。</Text> : null}
          <Button accessibilityLabel="开始重建" disabled={creating || !canWrite || !selected.length || checkingMedia || uploading} label={creating ? "正在创建…" : "开始重建"} onPress={createJob} />
        </Card> : null}
        {page === "project" && section !== "materials" && detail ? <Card>
          <Text accessibilityRole="header" style={textStyles.heading}>{section === "tasks" ? "任务" : "结果"}</Text>
          {section === "results" ? <Text style={textStyles.muted}>结果按任务页显示。</Text> : null}
          {section === "tasks" && !detail.jobs.length ? <Text style={textStyles.muted}>还没有任务。选择素材和路线后开始重建。</Text> : null}
          {section === "results" && !detail.jobs.some((job) => job.status === "SUCCEEDED" && job.reconstruction_id) ? <><Text style={textStyles.muted}>本页暂无重建结果</Text><Button tone="ghost" label="查看任务" onPress={() => setSection("tasks")} /></> : null}
          {detail.jobs.filter((job) => section === "tasks" || (job.status === "SUCCEEDED" && job.reconstruction_id)).map((job) => <Pressable accessibilityRole="button" key={job.id} onPress={() => onJob(job.id, { assets: selected, profile, section, assetPages, jobPages }, section === "results" ? "result" : "job")} style={styles.route}>
            <View style={styles.rowHeader}>
              <Text style={textStyles.body}>{RECONSTRUCTION_PROFILES[job.profile].title}</Text>
              <Text style={job.status === "FAILED" ? textStyles.error : styles.link}>{JOB_STATUS_LABELS[job.status]}</Text>
            </View>
            <Text style={textStyles.muted}>{new Date(job.created_at).toLocaleString()}</Text>
          </Pressable>)}
          {pageControls("jobs", jobPages, detail.nextJobCursor)}
        </Card> : null}
    </Screen>
  );
}

const makeStyles = (theme: Palette) => StyleSheet.create({
  projectHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: "space-between" },
  rowHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: "space-between" },
  action: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 8 },
  roleChoice: { minHeight: 44, justifyContent: "center" },
  link: { color: theme.accent, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  online: { color: theme.success, fontSize: 14, lineHeight: 20 },
  assetGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  asset: { width: "48.5%", overflow: "hidden", borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 12 },
  assetChoice: { flex: 1, minHeight: 48, padding: 10, gap: 4 },
  selectionBar: { gap: 8, padding: 12 },
  selected: { borderColor: theme.accent, backgroundColor: theme.surfaceStrong },
  route: { gap: 5, minHeight: 48, padding: 12, borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 12 },
});
