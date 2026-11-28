import { explainError, parseAuditLocalRange, ResceneApiError, type ResceneClient } from "@rescene/api-client";
import {
  ANNOUNCEMENT_LEVEL_LABELS,
  type AdminUserDetail,
  type AdminUserPage,
  type Announcement,
  type AnnouncementLevel,
  type AuditEntry,
  type AuditPage,
} from "@rescene/schemas";
import { Button, Input, Switch, Text, Textarea, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePageScroll, useResize } from "@tarojs/taro";
import { newIdempotencyKey, type QueueOwner } from "@rescene/uploader";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { currentQueueOwner, isQueueOwnerCurrent, onSessionExpired, queueClient } from "../../api";
import { Screen, WorkspaceEntry } from "../../screen";
import { AvatarThumbnail, removeAvatarTemp, writeAvatarTemp } from "../../avatar-profile";

const TABS = [["users", "用户管理"], ["announcements", "公告管理"], ["logs", "审计日志"]] as const;
const STATUS = [[undefined, "全部状态"], [true, "启用"], [false, "停用"]] as const;
const ROLES = [[undefined, "全部角色"], [true, "管理员"], [false, "普通账号"]] as const;
const LEVELS = ["info", "warning", "critical"] as const;

const PAGE_SIZE = 20;
const MEMBERSHIP_ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "查看者" };

function message(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 401) return "登录已过期，请重新登录。";
    if (reason.status === 403) return "没有权限执行此操作。";
    if (reason.status === 404) return "目标不存在，可能已被删除。";
    return explainError(reason, fallback);
  }
  return fallback;
}

function auditActor(item: AuditEntry): string {
  return item.actor_username && item.actor_email
    ? `${item.actor_username}（${item.actor_email}）`
    : item.actor_username ?? item.actor_email ?? "系统";
}

function auditProject(item: AuditEntry): string {
  return item.project_name ?? item.project_id ?? "平台";
}

function userRole(admin: boolean): string {
  return admin ? "管理员" : "普通账号";
}

function userStatus(active: boolean): string {
  return active ? "启用" : "已停用";
}

function shareAuditFile(filePath: string): Promise<void> {
  if (typeof Taro.shareFileMessage !== "function") {
    throw new Error("当前微信版本不支持分享文件，请升级后重试。");
  }
  // The WeChat adapter may forward this API without promisifying it.
  return new Promise((resolve, reject) => {
    void Taro.shareFileMessage({
      filePath, fileName: "rescene-audit.csv", success: () => resolve(), fail: reject,
    })?.catch?.(reject);
  });
}

function shareCancelled(reason: unknown): boolean {
  return reason !== null && typeof reason === "object" && "errMsg" in reason
    && typeof reason.errMsg === "string" && /cancel|取消/i.test(reason.errMsg);
}

type Tab = (typeof TABS)[number][0];
type UserFilters = { query?: string; active?: boolean; isAdmin?: boolean };
type AuditFilters = { actor?: string; action?: string; projectId?: string; since?: string; until?: string };
type ScreenView =
  | { kind: "list" }
  | { kind: "user"; id: string }
  | { kind: "create" }
  | { kind: "reset"; user: AdminUserDetail }
  | { kind: "edit" }
  | { kind: "preview"; draft: Draft }
  | { kind: "audit"; entry: AuditEntry };
type Draft = { title: string; body: string; level: AnnouncementLevel };
type Loaded =
  | { kind: "users"; value: AdminUserPage }
  | { kind: "announcements"; value: Announcement[]; hasNext: boolean }
  | { kind: "logs"; value: AuditPage }
  | { kind: "user"; value: AdminUserDetail };

const LIST: ScreenView = { kind: "list" };
const EMPTY_DRAFT: Draft = { title: "", body: "", level: "info" };
const EMPTY_AUDIT_DRAFT = { actor: "", action: "", projectId: "", since: "", until: "" };
const EMPTY_ACCOUNT = { email: "", password: "", admin: false };
const BODY_STYLE: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

export default function AdminPage() {
  const [owner, setOwner] = useState(currentQueueOwner);
  useDidShow(() => {
    const next = currentQueueOwner();
    setOwner((old) => old?.id === next?.id && old?.generation === next?.generation ? old : next);
  });
  useEffect(() => onSessionExpired(() => setOwner(null)), []);
  return <WorkspaceEntry>{owner
    ? <AdminWorkspace key={`${owner.id}:${owner.generation}`} owner={owner} />
    : <Screen><Text className="error">登录会话已过期，请重新登录。</Text></Screen>}</WorkspaceEntry>;
}

function AdminWorkspace({ owner }: { owner: QueueOwner }) {
  const [tab, setTab] = useState<Tab>("users");
  const [view, setView] = useState<ScreenView>(LIST);
  const [pages, setPages] = useState<Record<Tab, number>>({ users: 0, announcements: 0, logs: 0 });
  const page = pages[tab];
  const [query, setQuery] = useState("");
  const [userFilters, setUserFilters] = useState<UserFilters>({});
  const [auditDraft, setAuditDraft] = useState(EMPTY_AUDIT_DRAFT);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({});
  const [account, setAccount] = useState(EMPTY_ACCOUNT);
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const announcementKey = useRef<string | null>(null);
  const [result, setResult] = useState<{ request: number; data: Loaded } | null>(null);
  const [permission, setPermission] = useState<"checking" | "admin" | "denied" | "failed">("checking");
  const [permissionRetry, setPermissionRetry] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useState(true);
  const shown = useRef(true);
  const mounted = useRef(true);
  const generation = useRef(0);
  const lock = useRef<symbol | null>(null);
  const [busy, setBusy] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const avatarPath = useRef<string | null>(null);
  const [avatarError, setAvatarError] = useState("");
  const [avatarRetry, setAvatarRetry] = useState(0);
  const [wide, setWide] = useState(() => Taro.getWindowInfo().windowWidth >= 820);
  const scrollTop = useRef(0);
  const restoreTop = useRef<number | null>(null);
  usePageScroll(({ scrollTop: top }) => { scrollTop.current = top; });
  useResize(({ size }) => setWide(size.windowWidth >= 820));

  function removeAvatarFile() {
    if (avatarPath.current) removeAvatarTemp(avatarPath.current);
    avatarPath.current = null;
  }

  function invalidate() {
    generation.current += 1;
    setResult(null);
    setLoadError("");
    removeAvatarFile();
    setAvatar(null);
    setAvatarError("");
  }

  function canUsePage() {
    return mounted.current && shown.current && isQueueOwnerCurrent(owner);
  }

  function live(request: number) {
    return canUsePage() && request === generation.current;
  }

  useDidHide(() => {
    shown.current = false;
    invalidate();
    setVisible(false);
    setPermission("checking");
    setPassword("");
    setAccount((old) => ({ ...old, password: "" }));
  });
  useDidShow(() => {
    if (shown.current) return;
    shown.current = true;
    setVisible(true);
    setPermissionRetry((value) => value + 1);
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      removeAvatarFile();
    };
  }, []);

  useEffect(() => {
    if (!visible || !canUsePage()) return;
    let active = true;
    const valid = () => active && canUsePage();
    setPermission("checking");
    void (async () => {
      try {
        const me = await queueClient(owner).getMe();
        if (valid()) setPermission(me.id === owner.id && me.is_admin ? "admin" : "denied");
      } catch (reason) {
        if (valid()) setPermission(reason instanceof ResceneApiError && reason.status === 403 ? "denied" : "failed");
      }
    })();
    return () => { active = false; };
  }, [owner, visible, permissionRetry]);

  useEffect(() => {
    if (!visible || permission !== "admin" || !canUsePage() || (view.kind !== "list" && view.kind !== "user")) return;
    const request = ++generation.current;
    let active = true;
    const valid = () => active && live(request);
    const label = view.kind === "user" ? "账号详情" : TABS.find(([id]) => id === tab)?.[1];
    void (async () => {
      try {
        const api = queueClient(owner);
        const offset = page * PAGE_SIZE;
        let data: Loaded;
        if (view.kind === "user") {
          const value = await api.getUser(view.id);
          if (value.id !== view.id) throw new Error("账号详情已变化。");
          data = { kind: "user", value };
        } else if (tab === "users") {
          data = { kind: "users", value: await api.listUsers({ ...userFilters, offset, limit: PAGE_SIZE }) };
        } else if (tab === "announcements") {
          const rows = await api.listAnnouncements(PAGE_SIZE + 1, offset);
          data = { kind: "announcements", value: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
        } else {
          data = { kind: "logs", value: await api.listAudit({ ...auditFilters, offset, limit: PAGE_SIZE }) };
        }
        if (!valid()) return;
        if (data.kind === "users" || data.kind === "logs") {
          const last = Math.max(0, Math.ceil(data.value.total / PAGE_SIZE) - 1);
          if (page > last) { setPages((old) => ({ ...old, [tab]: last })); return; }
        }
        if (data.kind === "announcements" && page > 0 && !data.value.length) {
          setPages((old) => ({ ...old, announcements: page - 1 }));
          return;
        }
        setResult({ request, data });
      } catch (reason) {
        if (valid()) setLoadError(message(reason, `无法加载${label}，请重试。`));
      }
    })();
    return () => { active = false; };
  }, [owner, visible, permission, view, tab, page, userFilters, auditFilters, reload]);

  const loaded = result && live(result.request) ? result.data : null;
  const detail = loaded?.kind === "user" ? loaded.value : null;
  const detailId = detail?.id;
  const avatarRevision = detail?.avatar_revision;
  useEffect(() => {
    if (!detailId || !avatarRevision || !result || !live(result.request)) return;
    const request = result.request;
    let active = true;
    const valid = () => active && live(request);
    void (async () => {
      try {
        const next = await queueClient(owner).getAvatar(detailId);
        if (!valid()) return;
        if (avatarRevision !== next.revision) {
          setAvatarError("头像已更新，请重新加载账号详情。");
          return;
        }
        const path = writeAvatarTemp(detailId, next.revision, next.image_base64);
        if (!path) {
          setAvatarError("无法读取头像，请重试。");
          return;
        }
        avatarPath.current = path;
        setAvatar(path);
      } catch (reason) {
        if (valid()) setAvatarError(message(reason, "读取头像失败，请重试。"));
      }
    })();
    return () => { active = false; removeAvatarFile(); };
  }, [owner, detailId, avatarRevision, result, avatarRetry]);

  useEffect(() => {
    if (view.kind !== "list" || !result || restoreTop.current === null) return;
    const restore = restoreTop.current;
    Taro.nextTick(() => {
      if (!live(result.request) || restoreTop.current !== restore) return;
      restoreTop.current = null;
      void Taro.pageScrollTo({ scrollTop: restore, duration: 0 }).catch(() => undefined);
    });
  }, [result, view.kind]);

  function readyToNavigate() {
    return canUsePage() && !lock.current && permission === "admin";
  }

  function open(next: ScreenView) {
    if (view.kind === "list" && next.kind !== "list") restoreTop.current = scrollTop.current;
    invalidate();
    setProblem("");
    setView(next);
    if (next.kind !== "list") void Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => undefined);
  }

  function back() {
    if (!readyToNavigate()) return;
    setPassword("");
    setAccount((old) => ({ ...old, password: "" }));
    if (view.kind === "preview") open({ kind: "edit" });
    else if (view.kind === "reset") open({ kind: "user", id: view.user.id });
    else open(LIST);
  }

  function switchTab(next: Tab) {
    if (!readyToNavigate() || next === tab) return;
    invalidate();
    restoreTop.current = null;
    setProblem("");
    setNotice("");
    setTab(next);
  }

  function retryLoad() {
    if (!readyToNavigate()) return;
    invalidate();
    setReload((value) => value + 1);
  }

  function changePage(next: number) {
    if (!readyToNavigate() || next === page) return;
    invalidate();
    setProblem("");
    setPages((old) => ({ ...old, [tab]: next }));
  }

  function searchUsers(filters: UserFilters) {
    if (!readyToNavigate()) return;
    invalidate();
    setProblem("");
    setUserFilters(filters);
    setPages((old) => ({ ...old, users: 0 }));
  }

  function searchAudit() {
    if (!readyToNavigate()) return;
    try {
      const range = parseAuditLocalRange(auditDraft.since, auditDraft.until);
      invalidate();
      setProblem("");
      setAuditFilters({ ...range, actor: auditDraft.actor.trim(), action: auditDraft.action.trim(), projectId: auditDraft.projectId.trim() });
      setPages((old) => ({ ...old, logs: 0 }));
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : "时间范围无效。");
    }
  }

  async function perform(
    name: string,
    fallback: string,
    action: (api: ResceneClient, stillCurrent: () => boolean) => Promise<void>,
  ) {
    if (!readyToNavigate()) return;
    const operation = Symbol(name);
    const request = generation.current;
    const stillCurrent = () => live(request) && lock.current === operation;
    lock.current = operation;
    setBusy(name);
    setProblem("");
    setNotice("");
    try {
      await action(queueClient(owner), stillCurrent);
    } catch (reason) {
      if (stillCurrent()) setProblem(message(reason, fallback));
    } finally {
      if (lock.current === operation) {
        lock.current = null;
        if (mounted.current) setBusy("");
      }
    }
  }

  function updateUser(target: AdminUserDetail, field: "active" | "is_admin") {
    if (target.id === owner.id || !result || !live(result.request)) return;
    const nextValue = !target[field];
    const verb = field === "active" ? (nextValue ? "启用账号" : "停用账号") : (nextValue ? "授予管理员权限" : "撤销管理员权限");
    const consequence = field === "active"
      ? (nextValue ? "账号将恢复登录权限。" : "账号将无法登录或继续使用现有会话。")
      : (nextValue ? "该用户将能管理平台用户、公告和审计日志。" : "该用户将失去平台管理权限。");
    void perform(field, `${verb}失败，请重试。`, async (api, current) => {
      const answer = await Taro.showModal({ title: verb, content: `账号：${target.email}\n${consequence}`, confirmText: "确认" });
      if (!answer.confirm || !current()) return;
      await api.updateUser(target.id, { [field]: nextValue });
      if (!current()) return;
      setNotice(`${target.email}：${verb}成功。`);
      open(LIST);
    });
  }

  function resetUser(target: AdminUserDetail) {
    if (target.id === owner.id || !readyToNavigate()) return;
    if (password.length < 12) { setProblem("新密码至少 12 位。"); return; }
    void perform("reset", "重置密码失败，请重试。", async (api, current) => {
      const answer = await Taro.showModal({
        title: "重置密码", content: `账号：${target.email}\n旧密码和已有登录会话将失效。`, confirmText: "确认重置",
      });
      if (!answer.confirm || !current()) return;
      await api.resetUserPassword(target.id, password);
      if (!current()) return;
      setPassword("");
      setNotice(`${target.email} 的密码已重置。`);
      open({ kind: "user", id: target.id });
    });
  }

  function createUser() {
    const email = account.email.trim();
    if (!email.includes("@")) { setProblem("请输入有效邮箱。"); return; }
    if (account.password.length < 12) { setProblem("新账号密码至少 12 位。"); return; }
    void perform("create", "创建账号失败，请重试。", async (api, current) => {
      await api.createUser(email, account.password, account.admin);
      if (!current()) return;
      setAccount(EMPTY_ACCOUNT);
      setNotice("账号已创建，可以使用邮箱登录。");
      open(LIST);
    });
  }

  function editDraft(next: Draft) {
    if (next.title.trim() !== draft.title.trim() || next.body.trim() !== draft.body.trim() || next.level !== draft.level) {
      announcementKey.current = null;
    }
    setDraft(next);
  }

  function publish(input: Draft) {
    void perform("publish", "发布公告失败，请重试。", async (api, current) => {
      const key = announcementKey.current ?? (announcementKey.current = newIdempotencyKey());
      await api.createAnnouncement(input, key);
      if (!current()) return;
      setDraft(EMPTY_DRAFT);
      announcementKey.current = null;
      setNotice("公告已发布。");
      open(LIST);
    });
  }

  function retract(item: Announcement) {
    if (!result || !live(result.request) || loaded?.kind !== "announcements" || !loaded.value.includes(item)) return;
    void perform(`retract:${item.id}`, "撤回公告失败，请重试。", async (api, current) => {
      const answer = await Taro.showModal({
        title: "撤回公告", content: `撤回「${item.title}」将删除站内通知；已发出或已提交给邮件服务器的邮件无法追回。`,
        confirmText: "确认撤回",
      });
      if (!answer.confirm || !current()) return;
      await api.deleteAnnouncement(item.id);
      if (!current()) return;
      setNotice("公告已撤回。");
      invalidate();
      setReload((value) => value + 1);
    });
  }

  function saveCsv() {
    void perform("csv", "无法保存 CSV，请检查微信版本、网络或设备空间后重试。", async (api, current) => {
      const text = await api.auditCsvText(auditFilters);
      if (!current()) return;
      const fs = Taro.getFileSystemManager();
      const path = `${Taro.env.USER_DATA_PATH}/rescene-audit-${newIdempotencyKey()}.csv`;
      try {
        fs.writeFileSync(path, text, "utf8");
        if (current()) await shareAuditFile(path);
      } catch (reason) {
        if (!shareCancelled(reason)) throw reason;
      } finally {
        try { fs.unlinkSync(path); } catch { /* no file or already removed */ }
      }
    });
  }

  function leaveAdmin() {
    if (lock.current) return;
    const leave = Taro.getCurrentPages().length > 1
      ? Taro.navigateBack()
      : Taro.redirectTo({ url: "/pages/settings/index" });
    void leave.catch(() => setProblem("无法返回设置，请重试。"));
  }

  function pagination(hasNext: boolean) {
    return <View className="page-controls">
      <Button className="button ghost compact" disabled={Boolean(busy) || page === 0} onClick={() => changePage(page - 1)}>上一页</Button>
      <Text className="muted">第 {page + 1} 页</Text>
      <Button className="button ghost compact" disabled={Boolean(busy) || !hasNext} onClick={() => changePage(page + 1)}>下一页</Button>
    </View>;
  }

  const loading = <Text className="muted">正在加载…</Text>;
  const reports = <>
    {problem && <Text className="error">{problem}</Text>}
    {notice && <Text>{notice}</Text>}
  </>;
  const loadFeedback = loadError
    ? <View className="card"><Text className="error">{loadError}</Text>
      <Button className="button ghost" disabled={Boolean(busy)} onClick={retryLoad}>重试加载</Button>
    </View>
    : loading;

  if (!visible || !isQueueOwnerCurrent(owner)) return null;
  if (permission !== "admin") return <Screen>
    <Button className="button ghost" onClick={leaveAdmin}>返回设置</Button>
    {permission === "checking" ? loading : <Text className="error">
      {permission === "denied" ? "仅平台管理员可进入管理控制台。" : "无法确认管理员权限，请重试。"}
    </Text>}
    {permission === "failed" && <Button className="button ghost" onClick={() => setPermissionRetry((value) => value + 1)}>重试</Button>}
    {reports}
  </Screen>;

  if (view.kind !== "list") return <Screen>
    <Button className="button ghost" disabled={Boolean(busy)} onClick={back}>
      {view.kind === "preview" ? "返回编辑" : view.kind === "reset" ? "返回账号详情" : "返回列表"}
    </Button>
    {reports}
    {view.kind === "user" && (detail ? <View className="card">
      <View className="avatar-row">
        <AvatarThumbnail key={avatar ?? detail.id} user={detail} src={avatar} />
        <View className="avatar-meta">
          <Text className="section-heading">{detail.username ?? detail.email}</Text>
          <Text className="muted">{detail.email}</Text>
          <Text>{userRole(detail.is_admin)} · {userStatus(detail.active)}</Text>
        </View>
      </View>
      {avatarError && <View>
        <Text className="error">{avatarError}</Text>
        <Button className="button ghost" disabled={Boolean(busy)} onClick={() => { setAvatarError(""); setAvatarRetry((value) => value + 1); }}>重试头像</Button>
      </View>}
      <Text className="label">加入或拥有的项目</Text>
      {detail.memberships.length === 0 && <Text className="muted">尚未加入任何项目。</Text>}
      {detail.memberships.map((membership) => <View className="row" key={membership.project_id}>
        <Text>{membership.name}</Text><Text className="muted">{MEMBERSHIP_ROLE_LABEL[membership.role]}</Text>
      </View>)}
      <Button className="button ghost" loading={busy === "active"} disabled={Boolean(busy) || detail.id === owner.id}
        onClick={() => updateUser(detail, "active")}>{detail.active ? "停用账号" : "启用账号"}</Button>
      <Button className="button ghost" loading={busy === "is_admin"} disabled={Boolean(busy) || detail.id === owner.id}
        onClick={() => updateUser(detail, "is_admin")}>{detail.is_admin ? "撤销管理员权限" : "授予管理员权限"}</Button>
      {detail.id === owner.id ? <Text className="muted">不能停用或撤权当前账号。请在账户设置中修改自己的密码。</Text>
        : <Button className="button ghost" disabled={Boolean(busy)} onClick={() => {
          if (readyToNavigate() && result && live(result.request)) open({ kind: "reset", user: detail });
        }}>重置密码</Button>}
    </View> : loadFeedback)}
    {view.kind === "reset" && <View className="card">
      <Text className="section-heading">重置密码</Text>
      <Text>账号：{view.user.email}</Text>
      <Text className="muted">旧密码和已有登录会话将失效。</Text>
      <Input className="input" password disabled={Boolean(busy)} value={password} aria-label="新密码" placeholder="至少 12 位"
        onInput={(event) => setPassword(event.detail.value)} />
      <Button className="button" loading={busy === "reset"} disabled={Boolean(busy)} onClick={() => resetUser(view.user)}>确认重置</Button>
    </View>}
    {view.kind === "create" && <View className="card">
      <Text className="section-heading">创建账号</Text>
      <Text className="label">邮箱</Text>
      <Input className="input" disabled={Boolean(busy)} value={account.email} aria-label="邮箱" placeholder="name@example.com"
        onInput={(event) => setAccount({ ...account, email: event.detail.value })} />
      <Text className="label">初始密码（至少 12 位）</Text>
      <Input className="input" disabled={Boolean(busy)} password value={account.password} aria-label="初始密码"
        onInput={(event) => setAccount({ ...account, password: event.detail.value })} />
      <View className="row"><Text>平台管理员</Text><Switch disabled={Boolean(busy)} checked={account.admin}
        onChange={(event) => setAccount({ ...account, admin: event.detail.value })} /></View>
      <Button className="button" loading={busy === "create"} disabled={Boolean(busy)} onClick={createUser}>创建账号</Button>
    </View>}
    {view.kind === "edit" && <View className="card">
      <Text className="section-heading">编辑公告</Text>
      <Text className="label">标题</Text>
      <Input className="input" maxlength={200} value={draft.title} aria-label="公告标题"
        onInput={(event) => editDraft({ ...draft, title: event.detail.value })} />
      <Text className="label">正文</Text>
      <Textarea className="textarea" maxlength={4000} value={draft.body} aria-label="公告正文"
        onInput={(event) => editDraft({ ...draft, body: event.detail.value })} />
      <Text className="label">等级</Text>
      <View className="segmented">{LEVELS.map((level) => <Button key={level} className={`button tab${draft.level === level ? " active" : ""}`}
        aria-pressed={draft.level === level} onClick={() => editDraft({ ...draft, level })}>{ANNOUNCEMENT_LEVEL_LABELS[level]}</Button>)}</View>
      <Button className="button" disabled={!draft.title.trim() || !draft.body.trim()} onClick={() => {
        if (readyToNavigate()) open({ kind: "preview", draft: { ...draft, title: draft.title.trim(), body: draft.body.trim() } });
      }}>预览公告</Button>
    </View>}
    {view.kind === "preview" && <View className="card">
      <Text className="section-heading">发布预览</Text>
      <Text className="muted">{ANNOUNCEMENT_LEVEL_LABELS[view.draft.level]}</Text>
      <Text className="label">{view.draft.title}</Text>
      <Text style={BODY_STYLE}>{view.draft.body}</Text>
      <Text>站内通知：全部启用账号。</Text>
      <Text>{view.draft.level === "critical" ? "邮件：另发给已验证并订阅重要公告的启用账号。" : "邮件：仅重要公告会发给订阅者；本公告不发邮件。"}</Text>
      <Button className="button" loading={busy === "publish"} disabled={Boolean(busy)} onClick={() => publish(view.draft)}>确认发布</Button>
    </View>}
    {view.kind === "audit" && <View className="card">
      <Text className="section-heading">审计详情</Text>
      <Text>时间：{new Date(view.entry.created_at).toLocaleString()}</Text>
      <Text>操作者：{auditActor(view.entry)}</Text>
      <Text>动作：{view.entry.action}</Text>
      <Text>目标：{view.entry.target_type}</Text>
      <Text selectable>目标 ID：{view.entry.target_id}</Text>
      <Text>项目：{auditProject(view.entry)}</Text>
      {view.entry.project_id && view.entry.project_id !== auditProject(view.entry) && <Text selectable>项目 ID：{view.entry.project_id}</Text>}
      <Text className="label">附加数据</Text>
      <Text selectable style={BODY_STYLE}>{JSON.stringify(view.entry.metadata, null, 2)}</Text>
    </View>}
  </Screen>;

  return <Screen>
    <Button className="button ghost" disabled={Boolean(busy)} onClick={leaveAdmin}>返回设置</Button>
    <View style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: "16px", alignItems: "flex-start" }}>
      <View className="segmented" style={wide ? { flex: "0 0 170px", flexDirection: "column" } : { width: "100%" }}>
        {TABS.map(([id, label]) => <Button key={id} className={`button tab${tab === id ? " active" : ""}`}
          aria-pressed={tab === id} disabled={Boolean(busy)} onClick={() => switchTab(id)}>{label}</Button>)}
      </View>
      <View style={{ minWidth: 0, width: wide ? undefined : "100%", flex: "1", display: "flex", flexDirection: "column", gap: "12px" }}>
        <View className="project-heading">
          <Text className="section-heading">{TABS.find(([id]) => id === tab)?.[1]}</Text>
          {tab === "users" && <Button className="button compact" disabled={Boolean(busy)} onClick={() => {
            if (readyToNavigate()) open({ kind: "create" });
          }}>创建账号</Button>}
          {tab === "announcements" && <Button className="button compact" disabled={Boolean(busy)} onClick={() => {
            if (readyToNavigate()) open({ kind: "edit" });
          }}>发布公告</Button>}
          {tab === "logs" && <Button className="button ghost compact" loading={busy === "csv"}
            disabled={Boolean(busy) || loaded?.kind !== "logs"} onClick={saveCsv}>保存 CSV</Button>}
        </View>
        {reports}
        {tab === "users" && <>
          <View className="card">
            <Text className="label">用户名或邮箱</Text>
            <Input className="input" aria-label="用户名或邮箱" value={query} onInput={(event) => setQuery(event.detail.value)}
              onConfirm={() => searchUsers({ ...userFilters, query: query.trim() })} />
            <Button className="button ghost" onClick={() => searchUsers({ ...userFilters, query: query.trim() })}>搜索</Button>
            <View className="segmented">{STATUS.map(([value, label]) => <Button key={label}
              className={`button tab${userFilters.active === value ? " active" : ""}`} aria-pressed={userFilters.active === value}
              onClick={() => searchUsers({ ...userFilters, active: value })}>{label}</Button>)}</View>
            <View className="segmented">{ROLES.map(([value, label]) => <Button key={label}
              className={`button tab${userFilters.isAdmin === value ? " active" : ""}`} aria-pressed={userFilters.isAdmin === value}
              onClick={() => searchUsers({ ...userFilters, isAdmin: value })}>{label}</Button>)}</View>
          </View>
          {loaded?.kind === "users" ? <>
            <Text className="muted">{loaded.value.total ? `共 ${loaded.value.total} 个账号` : "没有匹配的账号。"}</Text>
            {loaded.value.items.map((item) => <Button key={item.id} className="button route-option" onClick={() => {
              if (readyToNavigate() && result && live(result.request)) open({ kind: "user", id: item.id });
            }}>
              <View className="avatar-row">
                <AvatarThumbnail user={item} size="small" />
                <View className="avatar-meta"><Text className="label">{item.username ?? item.email}</Text>
                  <Text className="muted">{item.email}</Text><Text>{userRole(item.is_admin)} · {userStatus(item.active)}</Text>
                </View>
              </View>
            </Button>)}
            {pagination((page + 1) * PAGE_SIZE < loaded.value.total)}
          </> : loadFeedback}
        </>}
        {tab === "announcements" && (loaded?.kind === "announcements" ? <>
          {!loaded.value.length && <Text className="muted">暂无公告。</Text>}
          {loaded.value.map((item) => <View key={item.id} className="card">
            <Text className="label">{item.title}</Text>
            <Text className="muted">{ANNOUNCEMENT_LEVEL_LABELS[item.level]} · {new Date(item.created_at).toLocaleString()}</Text>
            <Text style={BODY_STYLE}>{item.body}</Text>
            <View className="row"><Text>站内接收 {item.recipient_count ?? "—"}</Text><Text>站内已读 {item.read_count ?? "—"}</Text></View>
            <Text className="muted">邮件：待处理 {item.mail_pending ?? "—"} · 服务器已接受 {item.mail_accepted ?? "—"} · 失败 {item.mail_failed ?? "—"} · 状态不明 {item.mail_unknown ?? "—"}</Text>
            <Button className="button ghost" loading={busy === `retract:${item.id}`} disabled={Boolean(busy)}
              onClick={() => retract(item)}>撤回公告</Button>
          </View>)}
          {pagination(loaded.hasNext)}
        </> : loadFeedback)}
        {tab === "logs" && <>
          <View className="card">
            {([
              ["actor", "操作者（邮箱或用户名）", "邮箱或用户名"],
              ["action", "动作（前缀匹配）", "user."],
              ["projectId", "项目 ID", "项目 ID"],
              ["since", "开始时间（本地）", "YYYY-MM-DD HH:mm"],
              ["until", "结束时间（本地）", "YYYY-MM-DD HH:mm"],
            ] as const).map(([field, label, placeholder]) => <View key={field}>
              <Text className="label">{label}</Text>
              <Input className="input" aria-label={label} placeholder={placeholder} disabled={Boolean(busy)}
                value={auditDraft[field]} onInput={(event) => setAuditDraft({ ...auditDraft, [field]: event.detail.value })} />
            </View>)}
            <Button className="button ghost" disabled={Boolean(busy)} onClick={searchAudit}>查询</Button>
            <Text className="muted">CSV 使用上次查询已应用的筛选，最多 10,000 条。</Text>
          </View>
          {loaded?.kind === "logs" ? <>
            <Text className="muted">{loaded.value.total ? `共 ${loaded.value.total} 条` : "没有匹配的审计日志。"}</Text>
            {loaded.value.items.map((item) => <Button className="button route-option" key={item.id} disabled={Boolean(busy)} onClick={() => {
              if (readyToNavigate() && result && live(result.request)) open({ kind: "audit", entry: item });
            }}>
              <Text>{item.action} · {auditActor(item)}</Text>
              <Text className="muted">{new Date(item.created_at).toLocaleString()}</Text>
              <Text className="muted">目标：{item.target_type}/{item.target_id} · 项目：{auditProject(item)}</Text>
            </Button>)}
            {pagination((page + 1) * PAGE_SIZE < loaded.value.total)}
          </> : loadFeedback}
        </>}
      </View>
    </View>
  </Screen>;
}
