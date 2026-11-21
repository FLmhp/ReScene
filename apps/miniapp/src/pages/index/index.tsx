import { Screen } from "../../screen";
import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import type { AppNotification, Project, User } from "@rescene/schemas";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiBaseUrl, authenticate, changeSessionPassword, client, currentQueueOwner, hasToken, isQueueOwnerCurrent,
  onSessionExpired, queueClient, renewSession, signOutSession, verifySession,
} from "../../api";
import { LEGACY_QUEUE_NOTICE, QUEUE_PAUSED, type QueueOwner } from "@rescene/uploader";
import { enqueue, hasLegacyQueue, replayQueued } from "../../queue";

// api.ts relaunches this page when a credential expires, so the notice must
// survive that remount to stay actionable.
const EXPIRY_NOTICE_KEY = "rescene-session-expired";
const EXPIRED_NOTICE = "登录已过期，请重新登录。";
const ROLE_LABEL: Record<Project["effective_role"], string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  viewer: "只读",
};

function serverLabel(): string {
  if (!apiBaseUrl) return "未配置（请设置 TARO_APP_API_URL）";
  if (!apiBaseUrl.startsWith("https://")) return `${apiBaseUrl}（非 HTTPS，微信真机无法访问）`;
  return apiBaseUrl;
}

function message(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 401) return "登录已过期，请重新登录。";
    if (reason.status === 403) return "没有权限执行此操作。";
    if (reason.status === 422) return reason.detail || "输入无效，请检查后重试。";
    return explainError(reason, reason.detail || fallback);
  }
  return reason instanceof Error ? reason.message : fallback;
}

export default function IndexPage() {
  const [panel, setPanel] = useState<"notifications" | "account" | null>(null);
  const [projectPage, setProjectPage] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [recovering, setRecovering] = useState(hasToken());
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [acceptingInvitation, setAcceptingInvitation] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [legacyQueue] = useState(hasLegacyQueue);
  const [busy, setBusy] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [nextConfirm, setNextConfirm] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const authLock = useRef(false);
  const passwordLock = useRef(false);
  const projectLock = useRef(false);
  const recoveryLock = useRef(false);
  const booted = useRef(false);

  useEffect(() => {
    try {
      if (Taro.getStorageSync<string>(EXPIRY_NOTICE_KEY)) {
        Taro.removeStorageSync(EXPIRY_NOTICE_KEY);
        setError(EXPIRED_NOTICE);
      }
    } catch { /* The login form is available even when local storage fails. */ }
    return onSessionExpired(() => {
      setUser(null);
      setInviteCode("");
      setProjects([]);
      setNotifications([]);
      setUnread(0);
      setName("");
      setNotice("");
      setRecovering(false);
      setError(EXPIRED_NOTICE);
    });
  }, []);

  const loadProjects = useCallback(async (owner: QueueOwner) => {
    try {
      const list = await queueClient(owner).listProjects();
      if (isQueueOwnerCurrent(owner)) setProjects(list);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) throw reason;
    }
  }, []);

  const replay = useCallback((owner: QueueOwner) => {
    void replayQueued(owner, () => undefined).then(({ created }) => {
      if (created && isQueueOwnerCurrent(owner)) return loadProjects(owner);
    }).catch((reason) => {
      if (isQueueOwnerCurrent(owner)) setError(message(reason, "同步离线数据失败。"));
    });
  }, [loadProjects]);

  async function acceptInvitation() {
    const code = inviteCode.trim();
    if (!code || acceptingInvitation) return;
    const owner = currentQueueOwner();
    if (!owner) {
      setError(QUEUE_PAUSED);
      return;
    }
    setAcceptingInvitation(true);
    setError("");
    setNotice("");
    try {
      await queueClient(owner).acceptInvitation(code);
      if (!isQueueOwnerCurrent(owner)) return;
      setInviteCode("");
      setSearch("");
      setProjectPage(0);
      setNotice("已领取邀请。");
      await loadProjects(owner);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setError(message(reason, "领取邀请失败"));
    } finally {
      setAcceptingInvitation(false);
    }
  }

  const recover = useCallback(async () => {
    if (!hasToken() || recoveryLock.current) return;
    recoveryLock.current = true;
    if (!booted.current) setRecovering(true);
    setError("");
    try {
      const current = await verifySession();
      const owner = currentQueueOwner();
      if (!current || !owner || current.id !== owner.id) return;
      setUser(current);
      if (!await renewSession() || !isQueueOwnerCurrent(owner)) return;
      replay(owner);
      await loadProjects(owner);
      return isQueueOwnerCurrent(owner);
    } catch (reason) {
      setError(message(reason, "恢复登录失败，请检查服务器连接后重试。"));
    } finally {
      booted.current = true;
      recoveryLock.current = false;
      setRecovering(false);
    }
  }, [loadProjects, replay]);

  const loadNotifications = useCallback(async () => {
    const owner = currentQueueOwner();
    if (!owner) return;
    const scopedClient = queueClient(owner);
    try {
      const [items, count] = await Promise.all([scopedClient.listNotifications(true, 5), scopedClient.notificationCount()]);
      if (!isQueueOwnerCurrent(owner)) return;
      setNotifications(items);
      setUnread(count);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setError(message(reason, "加载通知失败。"));
    }
  }, []);

  useDidShow(() => {
    void (async () => {
      if (await recover()) await loadNotifications();
    })();
  });

  async function login() {
    if (authLock.current) return;
    authLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = await authenticate("login", email.trim(), password);
      const owner = currentQueueOwner();
      if (!current || !owner || current.id !== owner.id) return;
      Taro.removeStorageSync(EXPIRY_NOTICE_KEY);
      setPassword("");
      setUser(current);
      replay(owner);
      await loadProjects(owner);
      await loadNotifications();
    } catch (reason) {
      if (reason instanceof ResceneApiError && (reason.status === 401 || reason.status === 403)) {
        setError("邮箱或密码不正确。");
      } else {
        setError(message(reason, "登录失败，请重试。"));
      }
    } finally {
      authLock.current = false;
      setBusy(false);
    }
  }

  async function register() {
    if (authLock.current) return;
    const address = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      setError("请输入有效的邮箱地址。");
      return;
    }
    if (password.length < 12) {
      setError("密码至少 12 位。");
      return;
    }
    if (confirm !== password) {
      setError("两次输入的密码不一致。");
      return;
    }
    authLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = await authenticate("register", address, password);
      const owner = currentQueueOwner();
      if (!current || !owner || current.id !== owner.id) return;
      Taro.removeStorageSync(EXPIRY_NOTICE_KEY);
      setPassword("");
      setConfirm("");
      setUser(current);
      replay(owner);
      await loadProjects(owner);
      await loadNotifications();
    } catch (reason) {
      if (reason instanceof ResceneApiError && reason.status === 409) {
        setError("该邮箱已注册，请直接登录。");
      } else {
        setError(message(reason, "注册失败，请重试。"));
      }
    } finally {
      authLock.current = false;
      setBusy(false);
    }
  }

  async function createProject() {
    const trimmed = name.trim();
    if (!trimmed || projectLock.current) return;
    if (trimmed.length > 200) {
      setError("项目名称最多 200 个字符。");
      return;
    }
    const owner = currentQueueOwner();
    if (!owner) { setError(QUEUE_PAUSED); return; }
    const scopedClient = queueClient(owner);
    projectLock.current = true;
    setCreatingProject(true);
    setError("");
    try {
      const project = await scopedClient.createProject(trimmed);
      if (!isQueueOwnerCurrent(owner)) return;
      setName("");
      setProjects((current) => [project, ...current]);
    } catch (reason) {
      if (!isQueueOwnerCurrent(owner)) return;
      if (isOfflineError(reason)) {
        try {
          await enqueue(owner, {
            kind: "project",
            id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: trimmed,
            createdAt: Date.now(),
          });
          if (!isQueueOwnerCurrent(owner)) return;
          setName("");
          setError("");
          setNotice("已离线保存，联网后自动创建。");
        } catch {
          if (isQueueOwnerCurrent(owner)) setError("保存到本地队列失败。");
        }
      } else {
        setError(message(reason, "创建项目失败。"));
      }
    } finally {
      projectLock.current = false;
      setCreatingProject(false);
    }
  }

  async function changePassword() {
    if (passwordLock.current) return;
    if (nextPassword.length < 12) {
      setError("新密码至少 12 位。");
      return;
    }
    if (nextPassword !== nextConfirm) {
      setError("两次输入的新密码不一致。");
      return;
    }
    passwordLock.current = true;
    setChangingPassword(true);
    setError("");
    setNotice("");
    try {
      if (!await changeSessionPassword(currentPassword, nextPassword)) return;
      setCurrentPassword("");
      setNextPassword("");
      setNextConfirm("");
      setNotice("密码已更新，其他设备已退出登录。");
    } catch (reason) {
      setError(message(reason, "更新密码失败。"));
    } finally {
      passwordLock.current = false;
      setChangingPassword(false);
    }
  }

  async function markAllRead() {
    try {
      await client.markNotificationsRead();
      await loadNotifications();
    } catch (reason) {
      setError(message(reason, "标记已读失败。"));
    }
  }

  async function openNotification(item: AppNotification) {
    try {
      await client.markNotificationsRead([item.id]);
      await loadNotifications();
    } catch (reason) {
      setError(message(reason, "标记已读失败。"));
    }
    if (item.project_id) {
      const job = item.job_id ? `&view=tasks&job=${encodeURIComponent(item.job_id)}` : "";
      void Taro.navigateTo({ url: `/pages/project/index?id=${encodeURIComponent(item.project_id)}${job}` });
    }
  }

  async function signOut() {
    if (authLock.current) return;
    authLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const signingOut = signOutSession();
    setUser(null);
    setInviteCode("");
    setProjects([]);
    setNotifications([]);
    setUnread(0);
    setCurrentPassword("");
    setNextPassword("");
    setNextConfirm("");
    setSearch("");
    setProjectPage(0);
    setName("");
    const revoked = await signingOut;
    setBusy(false);
    authLock.current = false;
    if (!revoked) setError("本机已退出，但服务器无法确认会话已撤销。请检查网络并联系管理员撤销会话。");
  }

  const filtered = projects.filter((project) => project.name.toLowerCase().includes(search.trim().toLowerCase()));
  const pageSize = 8;
  const projectPageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(projectPage, projectPageCount - 1);
  const visibleProjects = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const unreadItems = notifications.filter((item) => item.read_at === null);

  if (recovering) {
    return <Screen><Text className="muted">正在恢复登录…</Text></Screen>;
  }

  if (!user && !currentQueueOwner()) {
    return (
      <Screen>
        <Text className="muted">影像到三维空间</Text>
        <Text className="title">登录 / 注册</Text>
  
        <View className="card">
          <View className="segmented">
            <View className={mode === "login" ? "tab active" : "tab"} onClick={() => { setMode("login"); setError(""); }}>登录</View>
            <View className={mode === "register" ? "tab active" : "tab"} onClick={() => { setMode("register"); setError(""); }}>注册</View>
          </View>
          <Text className="label">邮箱</Text>
          <Input className="input" placeholder="name@example.com" value={email} onInput={(event) => setEmail(event.detail.value)} />
          <Text className="label">{mode === "login" ? "密码" : "密码（至少 12 位）"}</Text>
          <Input className="input" password={!showPassword} value={password} onInput={(event) => setPassword(event.detail.value)} />
          <Button className="button ghost compact" onClick={() => setShowPassword(!showPassword)}>{showPassword ? "隐藏密码" : "显示密码"}</Button>
          {mode === "register" ? (
            <>
              <Text className="label">确认密码</Text>
              <Input className="input" password value={confirm} onInput={(event) => setConfirm(event.detail.value)} />
            </>
          ) : null}
          {mode === "login" ? (
            <Button className="button" loading={busy} disabled={busy} onClick={() => void login()}>邮箱登录</Button>
          ) : (
            <Button className="button" loading={busy} disabled={busy} onClick={() => void register()}>创建账号</Button>
          )}
          <Text className="muted">{mode === "login" ? "首次使用请切换到注册；密码至少 12 位。" : "注册后即可创建项目；密码至少 12 位。"}</Text>
          {hasToken() ? <Button className="button ghost" onClick={() => void recover()}>重试恢复登录</Button> : null}
        </View>
        {hasToken() ? <Text className="muted">{QUEUE_PAUSED}</Text> : null}
        {error ? <Text className="error">{error} · {serverLabel()}</Text> : null}
        {notice ? <Text>{notice}</Text> : null}
      </Screen>
    );
  }

  return (
    <Screen>
      
      <Text className="title">我的项目</Text>
      {user ? <Text className="muted">{user.email}{user.is_admin ? " · 管理员" : ""}</Text>
        : <Button className="button ghost" onClick={() => void recover()}>重试恢复登录</Button>}

      <View className="selection-tools">
        <Button className="button ghost compact" onClick={() => setPanel(panel === "notifications" ? null : "notifications")}>通知（{unread}）</Button>
        <Button className="button ghost compact" onClick={() => setPanel(panel === "account" ? null : "account")}>账户设置</Button>
      </View>
      {panel === "notifications" ? <View className="card">
        <View className="row">
          <Text className="label">通知（{unread}）</Text>
          <Button className="button ghost" size="mini" disabled={!unread} onClick={() => void markAllRead()}>全部已读</Button>
        </View>
        {unreadItems.length === 0 ? <Text className="muted">暂无通知</Text> : null}
        {unreadItems.map((item) => (
          <View className="row" key={item.id} onClick={() => void openNotification(item)}>
            <Text>{item.title}</Text>
            <Text className="muted">{item.created_at}</Text>
          </View>
        ))}
      </View> : null}
      <View className="card">
        <Text className="label">搜索项目</Text>
        <Input className="input" value={search} onInput={(event) => { setSearch(event.detail.value); setProjectPage(0); }} />
        <Text className="label">新项目名称</Text>
        <Input className="input" maxlength={200} value={name} onInput={(event) => setName(event.detail.value)} />
        <Button className="button" loading={creatingProject} disabled={creatingProject || !name.trim()} onClick={() => void createProject()}>创建项目</Button>
      </View>
      <View className="card">
        <Text className="label">领取码</Text>
        <Input className="input" maxlength={128} value={inviteCode} onInput={(event) => setInviteCode(event.detail.value)} />
        <Button className="button" loading={acceptingInvitation} disabled={acceptingInvitation || !inviteCode.trim()} onClick={() => void acceptInvitation()}>领取邀请</Button>
      </View>
      {visibleProjects.map((project) => (
        <View className="project-tile" key={project.id} onClick={() => void Taro.navigateTo({ url: `/pages/project/index?id=${encodeURIComponent(project.id)}&name=${encodeURIComponent(project.name)}` })}>
          <Text className="label">{project.name}</Text><Text className="muted">{ROLE_LABEL[project.effective_role]} · 打开 ›</Text>
        </View>
      ))}
      {projectPageCount > 1 ? <View className="page-controls">
        <Button className="button ghost compact" disabled={page === 0} onClick={() => setProjectPage(page - 1)}>上一页</Button>
        <Text className="muted">{page + 1} / {projectPageCount}</Text>
        <Button className="button ghost compact" disabled={page + 1 === projectPageCount} onClick={() => setProjectPage(page + 1)}>下一页</Button>
      </View> : null}
      {filtered.length === 0 ? <Text className="muted">{search.trim() ? "没有匹配的项目。" : "还没有项目。"}</Text> : null}
      {user?.is_admin ? (
        <Button className="button ghost" onClick={() => void Taro.navigateTo({ url: "/pages/admin/index" })}>管理控制台</Button>
      ) : null}
      {legacyQueue ? <Text className="muted">{LEGACY_QUEUE_NOTICE}</Text> : null}
      {error ? <Text className="error">{error}</Text> : null}
      {notice ? <Text>{notice}</Text> : null}
      {panel === "account" ? <View className="card">
        <Text className="section-heading">账户安全</Text>
        <Text className="label">当前密码</Text>
        <Input className="input" password value={currentPassword} onInput={(event) => setCurrentPassword(event.detail.value)} />
        <Text className="label">新密码（至少 12 位）</Text>
        <Input className="input" password value={nextPassword} onInput={(event) => setNextPassword(event.detail.value)} />
        <Text className="label">确认新密码</Text>
        <Input className="input" password value={nextConfirm} onInput={(event) => setNextConfirm(event.detail.value)} />
        <Button className="button" loading={changingPassword} disabled={changingPassword || !currentPassword || !nextPassword || !nextConfirm} onClick={() => void changePassword()}>更新密码</Button>
      </View> : null}
      <Button className="button ghost" loading={busy} disabled={busy} onClick={() => void signOut()}>退出登录</Button>
    </Screen>
  );
}
