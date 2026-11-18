import { explainError, isOfflineError } from "@rescene/api-client";
import type { AppNotification, Project, User } from "@rescene/schemas";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";

import { client, persistSession } from "../api";
import { enqueue, replayQueued } from "../queue";
import { useAppearance } from "../appearance";
import { Button, Card, ErrorText, Field, Screen, useTextStyles } from "../ui";

export function ProjectsScreen({ onOpen, onSignOut, onAdmin, onJob }: {
  onOpen: (project: { id: string; name: string }) => void;
  onSignOut: () => void;
  onAdmin: () => void;
  onJob?: (jobId: string) => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const [panel, setPanel] = useState<"notifications" | "account" | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const replayed = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadNotifications = useCallback(async () => {
    try {
      const [items, count] = await Promise.all([client.listNotifications(true, 5), client.notificationCount()]);
      setNotifications(items);
      setUnread(count);
    } catch {
      // Notifications are advisory; a failure must not hide the project list.
    }
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const [nextProjects, user] = await Promise.all([client.listProjects(), client.getMe()]);
      setProjects(nextProjects);
      setMe(user);
    } catch (reason) {
      setError(explainError(reason, "加载项目失败"));
    }
  }, []);

  useEffect(() => { void load(); void loadNotifications(); }, [load, loadNotifications]);

  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    void replayQueued(client, () => undefined).then(({ created, uploaded }) => { if (created || uploaded) void load(); }).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void replayQueued(client, () => undefined).then(({ created, uploaded }) => { if (created || uploaded) void load(); }).catch(() => undefined);
      void loadNotifications();
    });
    return () => subscription.remove();
  }, [load, loadNotifications]);

  async function create() {
    if (!name.trim() || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const project = await client.createProject(name.trim());
      setName("");
      onOpen(project);
    } catch (reason) {
      if (isOfflineError(reason)) {
        try {
          await enqueue({ kind: "project", id: `project-${Date.now()}`, name: name.trim(), createdAt: Date.now() });
          setName("");
          setNotice("已离线保存，联网后自动创建。");
        } catch {
          setError("保存到本地队列失败。");
        }
      } else {
        setError(explainError(reason, "创建项目失败"));
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) { setError("两次输入的新密码不一致。"); return; }
    if (!currentPassword || newPassword.length < 12 || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.changePassword(currentPassword, newPassword);
      await persistSession(result.access_token);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("密码已更新，其他设备已退出登录。");
    } catch (reason) {
      setError(explainError(reason, "更新密码失败。"));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function markAllRead() {
    try {
      await client.markNotificationsRead();
      await loadNotifications();
    } catch (reason) {
      setError(explainError(reason, "操作失败"));
    }
  }

  async function openNotification(item: AppNotification) {
    try {
      await client.markNotificationsRead([item.id]);
      await loadNotifications();
      if (item.job_id && onJob) {
        onJob(item.job_id);
        return;
      }
      if (item.project_id) onOpen({ id: item.project_id, name: "" });
    } catch (reason) {
      setError(explainError(reason, "操作失败"));
    }
  }

  const visible = projects.filter((project) => project.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <Screen scroll title="我的项目">
      <Text style={textStyles.muted}>把拍摄素材整理成项目，重建并分享三维场景。</Text>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button tone="ghost" label={`通知（${unread}）`} onPress={() => setPanel(panel === "notifications" ? null : "notifications")} />
        <Button tone="ghost" label="账户设置" onPress={() => setPanel(panel === "account" ? null : "account")} />
      </View>
      {panel === "notifications" ? <Card>
        <Text style={textStyles.body}>通知（{unread}）</Text>
        <Button disabled={busy || (notifications.length === 0 && unread === 0)} label="全部已读" tone="ghost" onPress={() => void markAllRead()} />
        {notifications.length === 0 ? <Text style={textStyles.muted}>暂无未读通知。</Text> : notifications.map((item) => (
          <Pressable
            accessibilityRole="button"
            key={item.id}
            onPress={() => void openNotification(item)}
            style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border }}
          >
            <Text style={textStyles.body}>{item.kind === "announcement" ? "公告 · " : ""}{item.title}</Text>
            {item.body ? <Text numberOfLines={2} style={textStyles.muted}>{item.body}</Text> : null}
            <Text style={textStyles.muted}>{new Date(item.created_at).toLocaleString()}</Text>
          </Pressable>
        ))}
      </Card> : null}
      <Card>
        <Text style={textStyles.body}>{me ? `${me.email} · ${me.is_admin ? "管理员" : "成员"}` : "正在加载账户…"}</Text>
        <Field label="搜索项目" value={search} onChangeText={setSearch} placeholder="按名称筛选" />
        <Field label="新项目" value={name} onChangeText={setName} placeholder="项目名称" />
        <Button disabled={busy || !name.trim()} label="创建项目" onPress={create} />
      </Card>
      {error ? <Card>
        <ErrorText>{error}</ErrorText>
        <Button label="重新加载" onPress={() => void load()} tone="ghost" />
      </Card> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
      {visible.length === 0 ? <Text style={textStyles.muted}>{search.trim() ? "没有匹配的项目。" : "还没有项目。"}</Text> : null}
      {visible.map((item) => (
        <Pressable
          accessibilityHint="打开项目"
          accessibilityRole="button"
          key={item.id}
          onPress={() => onOpen(item)}
          style={{ padding: 22, gap: 14, borderRadius: 16, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.borderSoft, minHeight: 128 }}
        >
          <Text style={textStyles.heading}>{item.name}</Text>
          <Text style={textStyles.muted}>{{ owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" }[item.effective_role]} · 打开项目 ↗</Text>
        </Pressable>
      ))}
      {me?.is_admin ? <View><Button label="管理控制台" onPress={onAdmin} /></View> : null}
      {panel === "account" ? <Card>
        <Text style={textStyles.heading}>账户安全</Text>
        <Field label="当前密码" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry autoComplete="current-password" />
        <Field label="新密码（至少 12 位）" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" />
        <Field label="确认新密码" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" />
        <Button disabled={busy || !currentPassword || newPassword.length < 12 || !confirmPassword} label="更新密码" onPress={() => void changePassword()} />
      </Card> : null}
      <View><Button label="退出登录" onPress={onSignOut} tone="ghost" /></View>
    </Screen>
  );
}
