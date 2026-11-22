import { Screen } from "../../screen";
import { explainError, ResceneApiError } from "@rescene/api-client";
import { JOB_STATUS_LABELS, projectLibraryPage, type Project, type ProjectSummary, type User } from "@rescene/schemas";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiBaseUrl, authenticate, client, currentQueueOwner, hasToken, isQueueOwnerCurrent,
  onSessionExpired, queueClient, renewSession, verifySession,
} from "../../api";
import { LEGACY_QUEUE_NOTICE, QUEUE_PAUSED, type QueueOwner } from "@rescene/uploader";
import { hasLegacyQueue, replayQueued } from "../../queue";
import { consumeLogoutNotice } from "../../navigation";

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

function ProjectTile({ project, onError }: { project: Project; onError: () => void }) {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSummary(null);
    setSummaryFailed(false);
    void client.getProjectSummary(project.id).then((value) => {
      if (active) setSummary(value);
    }).catch(() => { if (active) setSummaryFailed(true); });
    return () => { active = false; };
  }, [project.id]);
  return <View className="project-tile" role="button" onClick={() => void Taro.navigateTo({ url: `/pages/project/index?id=${encodeURIComponent(project.id)}&name=${encodeURIComponent(project.name)}`, fail: onError })}>
    <Text className="label">{project.name}</Text>
    <Text className="muted">{ROLE_LABEL[project.effective_role]}</Text>
    <Text className="muted">{summary ? `${summary.asset_count} 个素材 · ${summary.job_count} 个任务${summary.latest_job ? ` · ${JOB_STATUS_LABELS[summary.latest_job.status]}` : " · 暂无任务"}` : summaryFailed ? "项目概况暂不可用" : "正在加载项目概况…"}</Text>
  </View>;
}

export default function IndexPage() {
  const [projectPage, setProjectPage] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [recovering, setRecovering] = useState(hasToken());
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [legacyQueue] = useState(hasLegacyQueue);
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const authLock = useRef(false);
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
      setProjects([]);
      setUnread(0);
      setSearch("");
      setProjectPage(0);
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
      const count = await scopedClient.notificationCount();
      if (!isQueueOwnerCurrent(owner)) return;
      setUnread(count);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setError(message(reason, "加载通知失败。"));
    }
  }, []);

  useDidShow(() => {
    const logoutNotice = consumeLogoutNotice();
    if (logoutNotice) setNotice(logoutNotice);
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

  const library = projectLibraryPage(projects, search, projectPage);

  function openFocus(view: "new-project" | "claim-invite" | "notifications" | "settings" | "appearance") {
    void Taro.navigateTo({
      url: `/pages/focus/index?view=${view}`,
      events: {
        "library-change": (change: { notice: string; clearSearch: boolean }) => {
          if (change.clearSearch) { setSearch(""); setProjectPage(0); }
          setError("");
          setNotice(change.notice);
        },
      },
      fail: () => setError("无法打开页面，请重试。"),
    });
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setPassword("");
    setConfirm("");
    setShowPassword(false);
    setError("");
  }

  if (recovering) {
    return <Screen><Text className="muted">正在恢复登录…</Text></Screen>;
  }

  if (!user && !currentQueueOwner()) {
    return (
      <Screen>
        <View className="row"><Text className="label">ReScene</Text><Button className="button ghost compact" onClick={() => openFocus("appearance")}>外观</Button></View>
        <Text className="title">{mode === "login" ? "登录" : "注册"}</Text>
        <View className="field">
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
            <Button className="button" loading={busy} disabled={busy} onClick={() => void login()}>{busy ? "正在登录…" : "邮箱登录"}</Button>
          ) : (
            <Button className="button" loading={busy} disabled={busy} onClick={() => void register()}>{busy ? "正在注册…" : "注册"}</Button>
          )}
          <Button className="button ghost" onClick={() => switchMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "注册账号" : "已有账号，登录"}</Button>
          {hasToken() ? <Button className="button ghost" onClick={() => void recover()}>重试恢复登录</Button> : null}
          {error ? <Text className="error">{error} · {serverLabel()}</Text> : null}
        </View>
        {hasToken() ? <Text className="muted">{QUEUE_PAUSED}</Text> : null}
        {notice ? <Text>{notice}</Text> : null}
      </Screen>
    );
  }

  return (
    <Screen>
      <View className="selection-tools">
        <Text className="label">ReScene</Text>
        <Button className="button ghost compact" onClick={() => openFocus("notifications")}>通知（{unread}）</Button>
        <Button className="button ghost compact" onClick={() => openFocus("settings")}>设置</Button>
      </View>
      <Text className="title">项目列表</Text>
      {!user ? <Button className="button ghost" onClick={() => void recover()}>重试恢复登录</Button> : null}
      <Button className="button" onClick={() => openFocus("new-project")}>新建项目</Button>
      <Button className="button ghost compact" onClick={() => openFocus("claim-invite")}>领取邀请</Button>
      <View className="field">
        <Text className="label">搜索项目</Text>
        <Input className="input" value={search} onInput={(event) => { setSearch(event.detail.value); setProjectPage(0); }} />
      </View>
      {library.items.map((project) => <ProjectTile key={project.id} project={project} onError={() => setError("无法打开页面，请重试。")} />)}
      {library.pages > 1 ? <View className="page-controls">
        <Button className="button ghost compact" disabled={library.index === 0} onClick={() => setProjectPage(library.index - 1)}>上一页</Button>
        <Text className="muted">第 {library.index + 1} / {library.pages} 页</Text>
        <Button className="button ghost compact" disabled={library.index + 1 === library.pages} onClick={() => setProjectPage(library.index + 1)}>下一页</Button>
      </View> : null}
      {library.count === 0 ? <Text className="muted">{search.trim() ? "没有匹配的项目。" : "还没有项目。创建第一个项目开始上传素材。"}</Text> : null}
      {legacyQueue ? <Text className="muted">{LEGACY_QUEUE_NOTICE}</Text> : null}
      {error ? <Text className="error">{error}</Text> : null}
      {notice ? <Text>{notice}</Text> : null}
    </Screen>
  );
}
