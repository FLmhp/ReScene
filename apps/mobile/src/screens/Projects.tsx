import { explainError, isOfflineError } from "@rescene/api-client";
import { QUEUE_PAUSED, newIdempotencyKey } from "@rescene/uploader";
import { JOB_STATUS_LABELS, projectLibraryPage } from "@rescene/schemas";
import type { ProjectSummary } from "@rescene/schemas";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { client, currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { AssetThumbnail } from "../AssetThumbnail";
import { Inbox } from "./Inbox";
import { enqueue, replayQueued } from "../queue";
import { useAppearance } from "../appearance";
import { Button, Card, ErrorText, Field, ScaledText as Text, Screen, useTextStyles } from "../ui";

type ProjectsPage = "projects" | "new-project" | "claim-invite" | "notifications";
const FORM_WIDTH = { maxWidth: 560, width: "100%" as const, alignSelf: "center" as const };

export function ProjectsScreen({ page, onNavigate, onSettings, onBack, onReturnToProject, onOpen, onJob, returnToProject }: {
  page: ProjectsPage | null;
  onNavigate: (page: ProjectsPage) => void;
  onSettings: () => void;
  onBack: () => void;
  onReturnToProject?: () => void;
  returnToProject?: boolean;
  onOpen: (project: { id: string; name: string }) => void;
  onJob?: (jobId: string) => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const [projectPage, setProjectPage] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [unread, setUnread] = useState(0);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const attemptKey = useRef<{ name: string; key: string } | null>(null);
  const replayed = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadUnread = useCallback(async () => {
    try {
      setUnread(await client.notificationCount());
    } catch {
      // Notifications are advisory; a failure must not hide the project list.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      setProjects(await client.listProjectSummaries());
    } catch (reason) {
      setListError(explainError(reason, "加载项目失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); void loadUnread(); }, [load, loadUnread]);

  const previousPage = useRef(page);
  useEffect(() => {
    const returning = previousPage.current !== page && page !== null;
    previousPage.current = page;
    if (!returning || page !== "projects") return;
    void load();
    void loadUnread();
  }, [load, loadUnread, page]);

  const replay = useCallback(() => {
    const owner = currentQueueOwner();
    if (!owner) return;
    void replayQueued(owner, () => undefined).then(({ created, uploaded }) => {
      if (isQueueOwnerCurrent(owner) && (created || uploaded)) void load();
    }).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    replay();
  }, [replay]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      replay();
      void loadUnread();
    });
    return () => subscription.remove();
  }, [loadUnread, page, replay]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || flight.current) return;
    const owner = currentQueueOwner();
    if (!owner) { setError(QUEUE_PAUSED); return; }
    const scopedClient = queueClient(owner);
    // Retry with the same key; a different name starts a new operation.
    const attempt = attemptKey.current?.name === trimmed ? attemptKey.current : { name: trimmed, key: newIdempotencyKey() };
    attemptKey.current = attempt;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const project = await scopedClient.createProject(trimmed, attempt.key);
      attemptKey.current = null;
      if (!isQueueOwnerCurrent(owner)) return;
      setName("");
      onOpen(project);
      void load();
      void loadUnread();
    } catch (reason) {
      if (!isQueueOwnerCurrent(owner)) return;
      if (isOfflineError(reason)) {
        try {
          await enqueue(owner, {
            kind: "project",
            id: `project-${Date.now()}`,
            name: trimmed,
            createdAt: Date.now(),
            idempotencyKey: attempt.key,
          });
          attemptKey.current = null;
          if (!isQueueOwnerCurrent(owner)) return;
          setName("");
          setNotice("已离线保存，联网后自动创建。");
          onNavigate("projects");
        } catch {
          if (isQueueOwnerCurrent(owner)) setError("保存到本地队列失败。");
        }
      } else {
        setError(explainError(reason, "创建项目失败"));
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function acceptInvitation() {
    const code = inviteCode.trim();
    if (!code || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await client.acceptInvitation(code);
    } catch (reason) {
      setError(explainError(reason, "领取邀请失败"));
      return;
    } finally {
      flight.current = false;
      setBusy(false);
    }
    setInviteCode("");
    setSearch("");
    setProjectPage(0);
    setNotice("已领取邀请。");
    onNavigate("projects");
    void load();
    void loadUnread();
  }

  if (page === null) return null;
  const library = projectLibraryPage(projects, search, projectPage);
  const titles: Record<ProjectsPage, string> = {
    projects: "项目列表", "new-project": "新建项目", "claim-invite": "领取邀请",
    notifications: "通知",
  };
  const rootPage = page === "projects" || page === "notifications";
  return (
    <Screen
      scroll
      title={titles[page]}
      onBack={rootPage ? (returnToProject ? onReturnToProject ?? onBack : undefined) : onBack}
      backLabel={returnToProject && rootPage ? "返回项目" : "返回"}
      navigation={rootPage ? <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", paddingHorizontal: 16, paddingBottom: 12 }}>
        {page !== "projects" ? <Button label="项目列表" tone="ghost" onPress={() => onNavigate("projects")} /> : null}
        {page !== "notifications" ? <Button accessibilityLabel="通知" label={unread ? `通知（${unread}）` : "通知"} tone="ghost" onPress={() => onNavigate("notifications")} /> : null}
        <Button label="设置" tone="ghost" onPress={onSettings} />
      </View> : undefined}
    >
      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
      {page === "projects" ? <>
        <Field label="搜索项目" value={search} onChangeText={(value) => { setSearch(value); setProjectPage(0); }} placeholder="按名称筛选" />
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <Button label="新建项目" onPress={() => onNavigate("new-project")} />
          <Pressable accessibilityRole="button" onPress={() => onNavigate("claim-invite")}
            style={{ justifyContent: "center", minHeight: 44, paddingHorizontal: 4 }}>
            <Text style={{ color: theme.accent, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>领取邀请</Text>
          </Pressable>
        </View>
        {loading ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>正在加载项目…</Text> : null}
        {listError ? <Card><ErrorText>{listError}</ErrorText><Button label="重新加载" onPress={() => void load()} tone="ghost" /></Card> : null}
        {!loading && !listError && library.count === 0 ? <Text style={textStyles.muted}>{search.trim() ? "没有匹配的项目。" : "还没有项目。创建第一个项目开始上传素材。"}</Text> : null}
        {!listError ? library.items.map((item) => (
          <Pressable accessibilityHint="打开项目" accessibilityLabel={item.name} accessibilityRole="button" key={item.id} onPress={() => onOpen(item)}
            style={{ flexDirection: "row", gap: 12, padding: 18, borderRadius: 12, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.borderSoft, minHeight: 112 }}>
            {item.cover ? <View style={{ width: 88, flexShrink: 0, alignSelf: "center", borderRadius: 8, overflow: "hidden" }}>
              <AssetThumbnail asset={item.cover} />
            </View> : null}
            <View style={{ flex: 1, gap: 8, justifyContent: "center" }}>
              <Text style={textStyles.heading}>{item.name}</Text>
              <Text style={textStyles.muted}>{{ owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" }[item.effective_role]} · {item.asset_count} 个素材 · {item.job_count} 个任务</Text>
              <Text style={textStyles.muted}>{item.latest_job ? `最近任务：${JOB_STATUS_LABELS[item.latest_job.status]}` : "暂无任务"}</Text>
            </View>
          </Pressable>
        )) : null}
        {!listError && library.pages > 1 ? <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Button label="上一页" tone="ghost" disabled={library.index === 0} onPress={() => setProjectPage(library.index - 1)} />
          <Text style={[textStyles.muted, textStyles.numeric]}>第 {library.index + 1} / {library.pages} 页</Text>
          <Button label="下一页" tone="ghost" disabled={library.index + 1 >= library.pages} onPress={() => setProjectPage(library.index + 1)} />
        </View> : null}
      </> : null}
      {page === "new-project" ? <Card style={FORM_WIDTH}>
        <Field label="项目名称" value={name} onChangeText={setName} placeholder="例如：街角重建" />
        <Button accessibilityLabel="创建项目" disabled={busy || !name.trim()} label="创建项目" onPress={create} />
      </Card> : null}
      {page === "claim-invite" ? <Card style={FORM_WIDTH}>
        <Field label="领取码" value={inviteCode} onChangeText={setInviteCode} autoComplete="off" />
        <Button disabled={busy || !inviteCode.trim()} label="领取邀请" onPress={acceptInvitation} />
      </Card> : null}
      {page === "notifications" ? (
        <Inbox projects={projects} onJob={onJob} onOpen={onOpen} onUnreadChange={setUnread} />
      ) : null}
    </Screen>
  );
}
