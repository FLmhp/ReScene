import { Screen, WorkspaceEntry } from "../../screen";
import { explainError, ResceneApiError } from "@rescene/api-client";
import type {
  AdminUser,
  AdminUserDetail,
  AdminUserPage,
  Announcement,
  AnnouncementLevel,
  AuditPage,
} from "@rescene/schemas";
import { Button, Input, Switch, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useEffect, useState } from "react";

import { client } from "../../api";

const PAGE_SIZE = 20;
const LEVEL_LABEL: Record<AnnouncementLevel, string> = { info: "信息", warning: "提醒", critical: "紧急" };
const MEMBERSHIP_ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "查看者" };

type Tab = "users" | "announcements" | "logs";
type StatusFilter = "all" | "active" | "inactive";
type LogFilters = { actor: string; action: string };

function message(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 401) return "登录已过期，请重新登录。";
    if (reason.status === 403) return "没有权限执行此操作。";
    if (reason.status === 404) return "目标不存在，可能已被删除。";
    if (reason.status === 409) return reason.detail || "当前状态不允许此操作。";
    if (reason.status === 422) return reason.detail || "输入无效，请检查后重试。";
    return explainError(reason, reason.detail || fallback);
  }
  return reason instanceof Error ? reason.message : fallback;
}

export default function AdminPage() {
  return <WorkspaceEntry><AdminWorkspace /></WorkspaceEntry>;
}

function AdminWorkspace() {
  const [tab, setTab] = useState<Tab>("users");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 用户
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [userPage, setUserPage] = useState(0);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);

  // 公告
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");
  const [publishing, setPublishing] = useState(false);

  // 日志
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [logFilters, setLogFilters] = useState<LogFilters>({ actor: "", action: "" });
  const [auditPage, setAuditPage] = useState<AuditPage | null>(null);
  const [logPage, setLogPage] = useState(0);

  const loadUsers = useCallback(async () => {
    setError("");
    try {
      setDirectory(await client.listUsers({
        query: appliedQuery || undefined,
        active: statusFilter === "all" ? undefined : statusFilter === "active",
        offset: userPage * PAGE_SIZE,
        limit: PAGE_SIZE,
      }));
    } catch (reason) {
      setError(message(reason, "加载账号列表失败。"));
    }
  }, [appliedQuery, statusFilter, userPage]);

  useEffect(() => {
    if (tab === "users") void loadUsers();
  }, [tab, loadUsers]);

  const loadAnnouncements = useCallback(async () => {
    setError("");
    try { setAnnouncements(await client.listAnnouncements()); }
    catch (reason) { setError(message(reason, "加载公告失败。")); }
  }, []);

  useEffect(() => {
    if (tab === "announcements") void loadAnnouncements();
  }, [tab, loadAnnouncements]);

  const loadAudit = useCallback(async () => {
    setError("");
    try {
      setAuditPage(await client.listAudit({
        actor: logFilters.actor || undefined,
        action: logFilters.action || undefined,
        offset: logPage * PAGE_SIZE,
        limit: PAGE_SIZE,
      }));
    } catch (reason) {
      setError(message(reason, "加载操作日志失败。"));
    }
  }, [logFilters, logPage]);

  useEffect(() => {
    if (tab === "logs") void loadAudit();
  }, [tab, loadAudit]);

  function switchTab(next: Tab) {
    setTab(next);
    setError("");
    setNotice("");
  }

  function searchUsers() {
    const next = query.trim();
    if (next === appliedQuery) {
      if (userPage === 0) void loadUsers();
      else setUserPage(0);
      return;
    }
    setAppliedQuery(next);
    setUserPage(0);
  }

  function filterUsers(next: StatusFilter) {
    if (next === statusFilter && userPage === 0) {
      void loadUsers();
      return;
    }
    setStatusFilter(next);
    setUserPage(0);
  }

  async function toggleActive(target: AdminUser) {
    if (busyUser) return;
    setBusyUser(target.id);
    setError("");
    setNotice("");
    try {
      await client.updateUser(target.id, { active: !target.active });
      setNotice(target.active ? `已停用 ${target.email}。` : `已启用 ${target.email}。`);
      await loadUsers();
    } catch (reason) {
      setError(message(reason, "更新账号状态失败。"));
    } finally {
      setBusyUser(null);
    }
  }

  async function resetPassword(target: AdminUser) {
    if (password.length < 12) { setError("新密码至少 12 位。"); return; }
    if (busyUser) return;
    setBusyUser(target.id);
    setError("");
    setNotice("");
    try {
      await client.resetUserPassword(target.id, password);
      setPassword("");
      setPasswordFor(null);
      setNotice(`${target.email} 的密码已重置。`);
    } catch (reason) {
      setError(message(reason, "重置密码失败。"));
    } finally {
      setBusyUser(null);
    }
  }

  async function openDetail(target: AdminUser) {
    if (busyUser) return;
    setBusyUser(target.id);
    setError("");
    setDetail(null);
    setPasswordFor(null);
    setPassword("");
    try { setDetail(await client.getUser(target.id)); }
    catch (reason) { setError(message(reason, "加载账号详情失败。")); }
    finally { setBusyUser(null); }
  }

  async function createUser() {
    if (creating) return;
    const address = newEmail.trim();
    if (!address.includes("@")) { setError("请输入有效邮箱。"); return; }
    if (newPassword.length < 12) { setError("新账号密码至少 12 位。"); return; }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      await client.createUser(address, newPassword, newAdmin);
      setNewEmail("");
      setNewPassword("");
      setNewAdmin(false);
      setNotice("账号已创建，可以使用邮箱登录。");
      await loadUsers();
    } catch (reason) {
      if (reason instanceof ResceneApiError && reason.status === 409) setError("该邮箱已存在账号，请直接登录或更换邮箱。");
      else setError(message(reason, "创建账号失败。"));
    } finally {
      setCreating(false);
    }
  }

  async function publish() {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) { setError("请填写公告标题和正文。"); return; }
    if (publishing) return;
    setPublishing(true);
    setError("");
    setNotice("");
    try {
      await client.createAnnouncement({ title: trimmedTitle, body: trimmedBody, level });
      setTitle("");
      setBody("");
      setNotice("公告已发布，全部启用账号会收到通知。");
      await loadAnnouncements();
    } catch (reason) {
      setError(message(reason, "发布公告失败。"));
    } finally {
      setPublishing(false);
    }
  }

  async function removeAnnouncement(item: Announcement) {
    const result = await Taro.showModal({
      title: "撤回公告",
      content: `确定撤回「${item.title}」？已发出的通知会一并删除。`,
    });
    if (!result.confirm) return;
    setError("");
    try {
      await client.deleteAnnouncement(item.id);
      setNotice("公告已撤回。");
      await loadAnnouncements();
    } catch (reason) {
      setError(message(reason, "撤回公告失败。"));
    }
  }

  function searchLogs() {
    const next = { actor: actor.trim(), action: action.trim() };
    if (next.actor === logFilters.actor && next.action === logFilters.action) {
      if (logPage === 0) void loadAudit();
      else setLogPage(0);
      return;
    }
    setLogFilters(next);
    setLogPage(0);
  }

  const userTotal = directory?.total ?? 0;
  const hasPreviousUserPage = userPage > 0;
  const hasNextUserPage = (userPage + 1) * PAGE_SIZE < userTotal;
  const logTotal = auditPage?.total ?? 0;
  const hasPreviousLogPage = logPage > 0;
  const hasNextLogPage = (logPage + 1) * PAGE_SIZE < logTotal;

  return (
    <Screen>
      <Text className="muted">账号、公告与全站操作日志；仅管理员可见。</Text>
      <View className="segmented">
        <Button className={tab === "users" ? "button tab active" : "button tab"} aria-pressed={tab === "users"} onClick={() => switchTab("users")}>用户</Button>
        <Button className={tab === "announcements" ? "button tab active" : "button tab"} aria-pressed={tab === "announcements"} onClick={() => switchTab("announcements")}>公告</Button>
        <Button className={tab === "logs" ? "button tab active" : "button tab"} aria-pressed={tab === "logs"} onClick={() => switchTab("logs")}>日志</Button>
      </View>

      {tab === "users" ? (
        <>
          <View className="card">
            <Text className="label">搜索账号</Text>
            <Input className="input" placeholder="name@example.com" value={query} onInput={(event) => setQuery(event.detail.value)} />
            <Button className="button ghost" onClick={searchUsers}>搜索</Button>
            <View className="segmented">
              <Button className={statusFilter === "all" ? "button tab active" : "button tab"} aria-pressed={statusFilter === "all"} onClick={() => filterUsers("all")}>全部</Button>
              <Button className={statusFilter === "active" ? "button tab active" : "button tab"} aria-pressed={statusFilter === "active"} onClick={() => filterUsers("active")}>启用</Button>
              <Button className={statusFilter === "inactive" ? "button tab active" : "button tab"} aria-pressed={statusFilter === "inactive"} onClick={() => filterUsers("inactive")}>停用</Button>
            </View>
            <Text className="muted">共 {userTotal} 个账号 · 第 {userPage + 1} 页</Text>
          </View>

          {(directory?.items ?? []).map((item) => (
            <View className="card" key={item.id}>
              <Text>{item.email}</Text>
              <Text className="muted">
                {item.is_admin ? "管理员" : "普通账号"} · {item.active ? "启用" : "已停用"} · 创建于 {item.created_at}
              </Text>
              <Button className="button ghost" loading={busyUser === item.id} disabled={busyUser === item.id} onClick={() => void toggleActive(item)}>
                {item.active ? "停用" : "启用"}
              </Button>
              <Button className="button ghost" onClick={() => { setDetail(null); setPasswordFor(passwordFor === item.id ? null : item.id); setPassword(""); }}>重置密码</Button>
              {passwordFor === item.id ? (
                <View>
                  <Input className="input" password placeholder="新的初始密码（至少 12 位）" value={password} onInput={(event) => setPassword(event.detail.value)} />
                  <Button className="button" loading={busyUser === item.id} disabled={busyUser === item.id} onClick={() => void resetPassword(item)}>确认重置</Button>
                  <Button className="button ghost" onClick={() => { setPasswordFor(null); setPassword(""); }}>取消</Button>
                </View>
              ) : null}
              <Button className="button ghost" onClick={() => void openDetail(item)}>查看详情</Button>
            </View>
          ))}
          {directory && directory.items.length === 0 ? <Text className="muted">没有匹配的账号。</Text> : null}
          <View className="row">
            <Button className="button ghost" disabled={!hasPreviousUserPage} onClick={() => setUserPage((current) => Math.max(0, current - 1))}>上一页</Button>
            <Button className="button ghost" disabled={!hasNextUserPage} onClick={() => setUserPage((current) => current + 1)}>下一页</Button>
          </View>

          {detail ? (
            <View className="card">
              <Text className="label">{detail.email} 的项目</Text>
              <Text className="muted">{detail.is_admin ? "管理员" : "普通账号"} · {detail.active ? "启用" : "已停用"}</Text>
              {detail.memberships.length === 0 ? <Text className="muted">尚未加入任何项目。</Text> : null}
              {detail.memberships.map((membership) => (
                <View className="row" key={membership.project_id}>
                  <Text>{membership.name}</Text>
                  <Text className="muted">{MEMBERSHIP_ROLE_LABEL[membership.role] ?? membership.role}</Text>
                </View>
              ))}
              <Button className="button ghost" onClick={() => setDetail(null)}>关闭详情</Button>
            </View>
          ) : null}

          {!detail && !passwordFor ? <View className="card">
            <Text className="label">创建账号</Text>
            <Text className="label">新账号邮箱</Text>
            <Input className="input" placeholder="name@example.com" value={newEmail} onInput={(event) => setNewEmail(event.detail.value)} />
            <Text className="label">初始密码（至少 12 位）</Text>
            <Input className="input" placeholder="至少 12 位" password value={newPassword} onInput={(event) => setNewPassword(event.detail.value)} />
            <View className="row"><Text>管理员</Text><Switch checked={newAdmin} onChange={(event) => setNewAdmin(event.detail.value)} /></View>
            <Button className="button" loading={creating} disabled={creating || !newEmail.trim() || !newPassword} onClick={() => void createUser()}>创建账号</Button>
          </View> : null}
        </>
      ) : null}

      {tab === "announcements" ? (
        <>
          <View className="card">
            <Text className="label">发布公告</Text>
            <Text className="label">标题</Text>
            <Input className="input" maxlength={200} value={title} onInput={(event) => setTitle(event.detail.value)} />
            <Text className="label">正文</Text>
            <Textarea className="textarea" maxlength={4000} value={body} onInput={(event) => setBody(event.detail.value)} />
            <Text className="label">级别</Text>
            <View className="segmented">
              {(["info", "warning", "critical"] as const).map((value) => (
                <Button className={level === value ? "button tab active" : "button tab"} aria-pressed={level === value} key={value} onClick={() => setLevel(value)}>{LEVEL_LABEL[value]}</Button>
              ))}
            </View>
            <Button className="button" loading={publishing} disabled={publishing || !title.trim() || !body.trim()} onClick={() => void publish()}>发布</Button>
            <Text className="muted">发布后会给所有启用账号各写一条通知。</Text>
          </View>
          {announcements.length === 0 ? <Text className="muted">暂无公告。</Text> : null}
          {announcements.map((item) => (
            <View className="card" key={item.id}>
              <Text className="label">{item.title}</Text>
              <Text className="muted">{LEVEL_LABEL[item.level]} · {item.created_at}</Text>
              <Text>{item.body}</Text>
              <Button className="button ghost" onClick={() => void removeAnnouncement(item)}>撤回</Button>
            </View>
          ))}
        </>
      ) : null}

      {tab === "logs" ? (
        <>
          <View className="card">
            <Text className="label">筛选操作日志</Text>
            <Text className="label">操作者邮箱</Text>
            <Input className="input" placeholder="name@example.com" value={actor} onInput={(event) => setActor(event.detail.value)} />
            <Text className="label">动作（如 user.，前缀匹配）</Text>
            <Input className="input" placeholder="user." value={action} onInput={(event) => setAction(event.detail.value)} />
            <Button className="button ghost" onClick={searchLogs}>查询</Button>
            <Text className="muted">共 {logTotal} 条 · 第 {logPage + 1} 页</Text>
          </View>
          {(auditPage?.items ?? []).map((item) => (
            <View className="card" key={item.id}>
              <Text>{item.actor_email ?? "系统"} · {item.action}</Text>
              <Text className="muted">
                {item.project_name ?? "平台"} · {item.target_type}/{item.target_id}
              </Text>
              <Text className="muted">{item.created_at}</Text>
            </View>
          ))}
          {auditPage && auditPage.items.length === 0 ? <Text className="muted">没有匹配的日志。</Text> : null}
          <View className="row">
            <Button className="button ghost" disabled={!hasPreviousLogPage} onClick={() => setLogPage((current) => Math.max(0, current - 1))}>上一页</Button>
            <Button className="button ghost" disabled={!hasNextLogPage} onClick={() => setLogPage((current) => current + 1)}>下一页</Button>
          </View>
        </>
      ) : null}

      {error ? <Text className="error">{error}</Text> : null}
      {notice ? <Text>{notice}</Text> : null}
    </Screen>
  );
}
