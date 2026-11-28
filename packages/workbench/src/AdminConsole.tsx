"use client";

import { ResceneApiError, explainError, parseAuditLocalRange, type ResceneClient } from "@rescene/api-client";
import {
  ANNOUNCEMENT_LEVEL_LABELS,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserPage,
  type Announcement,
  type AnnouncementLevel,
  type AuditEntry,
  type AuditPage,
  type User,
} from "@rescene/schemas";
import { newIdempotencyKey } from "@rescene/uploader";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { AvatarThumbnail } from "./Avatar";

export type AdminConsoleProps = { client: ResceneClient; onMessage: (text: string) => void };

type Tab = "users" | "announcements" | "logs";
type ActiveFilter = "all" | "active" | "inactive";
type RoleFilter = "all" | "admin" | "member";

const PAGE_SIZE = 20;
const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "用户管理" },
  { id: "announcements", label: "公告管理" },
  { id: "logs", label: "审计日志" },
];
const LEVEL_LABEL = ANNOUNCEMENT_LEVEL_LABELS;

type AvatarUser = { id: string; username: string | null; email: string; avatar_revision: string | null };

function UserAvatar({ client, user, onMessage }: { client: ResceneClient; user: AvatarUser; onMessage: (text: string) => void }) {
  const [image, setImage] = useState<{ userId: string; revision: string; src: string } | null>(null);
  const src = image?.userId === user.id && image.revision === user.avatar_revision ? image.src : null;
  useEffect(() => {
    if (!user.avatar_revision) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void client
      .getAvatar(user.id)
      .then((avatar) => {
        if (!cancelled && avatar.revision === user.avatar_revision) {
          setImage({ userId: user.id, revision: avatar.revision, src: `data:image/jpeg;base64,${avatar.image_base64}` });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ResceneApiError && error.status === 404) {
          setImage(null);
          return;
        }
        onMessage(explainError(error, "无法加载头像"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, user.id, user.avatar_revision, onMessage]);
  return <AvatarThumbnail user={user} src={src} size={64} />;
}

type ConfirmRequest = {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  password?: { label: string; minLength: number };
  onConfirm: (password: string) => Promise<void>;
};

function ConfirmDialog({
  request,
  busy,
  onCancel,
  onSubmit,
}: {
  request: ConfirmRequest | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit?: (action: () => Promise<void>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [password, setPassword] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, [request]);

  if (!request) return null;
  const disabled = busy || (request.password ? password.length < request.password.minLength : false);
  const submit = () => {
    if (disabled) return;
    if (onSubmit) onSubmit(() => request.onConfirm(password));
    else void request.onConfirm(password);
  };
  return (
    <dialog ref={dialogRef} className="admin-modal" aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault();
      if (!busy) onCancel();
    }}>
      <div className="admin-modal-card">
        <h3 id={titleId}>{request.title}</h3>
        <div className="admin-modal-body">{request.body}</div>
        {request.password ? (
          <label>
            {request.password.label}
            <input
              type="password"
              minLength={request.password.minLength}
              value={password}
              placeholder="输入新密码"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        ) : null}
        <div className="admin-modal-actions">
          <button type="button" className={request.danger ? "danger" : undefined} disabled={disabled} onClick={submit}>
            {busy ? "处理中…" : request.action}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function AdminConsole({ client, onMessage }: AdminConsoleProps) {
  const [tab, setTab] = useState<Tab>("users");
  const [self, setSelf] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .getMe()
      .then((user) => {
        if (!cancelled) setSelf(user);
      })
      .catch((error: unknown) => {
        if (!cancelled) onMessage(explainError(error, "无法加载当前账户"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, onMessage]);

  return (
    <div className="admin-console">
      <div className="admin-layout">
        <div className="admin-sidebar">
          <h2 className="admin-sidebar-title">管理控制台</h2>
          <div className="admin-tabs admin-categories" role="tablist" aria-label="管理栏目">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="admin-content">
          <section className={`admin-panel${tab === "users" ? " active" : ""}`} aria-hidden={tab !== "users"}>
            <UsersTab client={client} onMessage={onMessage} self={self} />
          </section>
          <section className={`admin-panel${tab === "announcements" ? " active" : ""}`} aria-hidden={tab !== "announcements"}>
            <AnnouncementsTab client={client} onMessage={onMessage} />
          </section>
          <section className={`admin-panel${tab === "logs" ? " active" : ""}`} aria-hidden={tab !== "logs"}>
            <LogsTab client={client} onMessage={onMessage} />
          </section>
        </div>
      </div>
    </div>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

function UsersTab({ client, onMessage, self }: AdminConsoleProps & { self: User | null }) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [page, setPage] = useState(0);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [directoryError, setDirectoryError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [detailUser, setDetailUser] = useState<AdminUserDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createAdmin, setCreateAdmin] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  useEffect(() => {
    if (queryInput.trim() === query) return;
    const timer = setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, queryInput]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setDirectoryError("");
    try {
      const next = await client.listUsers({
        query,
        active: activeFilter === "all" ? undefined : activeFilter === "active",
        isAdmin: roleFilter === "all" ? undefined : roleFilter === "admin",
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (id !== request.current) return;
      setDirectory(next);
      setDirectoryError("");
    } catch (error) {
      if (id === request.current) {
        setDirectoryError(explainError(error, "无法加载账号列表"));
        onMessage(explainError(error, "无法加载账号列表"));
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [activeFilter, roleFilter, client, onMessage, page, query]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!directory || directory.total === 0) return;
    if (page * PAGE_SIZE >= directory.total) {
      setPage(Math.max(0, Math.ceil(directory.total / PAGE_SIZE) - 1));
    }
  }, [directory, page]);

  async function openDetail(userId: string) {
    setView("detail");
    setDetailUser(null);
    setDetailBusy(true);
    try {
      const user = await client.getUser(userId);
      setDetailUser(user);
    } catch (error: unknown) {
      onMessage(explainError(error, "无法加载账号详情"));
      setView("list");
    } finally {
      setDetailBusy(false);
    }
  }

  function runMutation(action: () => Promise<void>) {
    setConfirmBusy(true);
    void action()
      .then(async () => {
        setConfirm(null);
        await load();
      })
      .catch((error: unknown) => onMessage(explainError(error, "操作失败")))
      .finally(() => setConfirmBusy(false));
  }

  function canActOn(user: AdminUser): boolean {
    return self !== null && user.id !== self.id;
  }

  function confirmToggleActive(user: AdminUser) {
    const display = user.username ?? user.email;
    if (!canActOn(user)) {
      onMessage("不能对自己执行此项操作");
      return;
    }
    setConfirm({
      title: `${user.active ? "停用" : "启用"}账户`,
      body: (
        <>
          <p>
            {user.active ? "停用" : "启用"} <strong>{display}</strong>（{user.email}）。
          </p>
          {user.active ? <p>停用后该账户将无法登录，直到被重新启用。</p> : <p>启用后该账户可以正常登录。</p>}
        </>
      ),
      action: user.active ? "确认停用" : "确认启用",
      danger: user.active,
      onConfirm: async () => {
        const updated = await client.updateUser(user.id, { active: !user.active });
        setDetailUser((current) => current?.id === updated.id ? { ...current, ...updated } : current);
        onMessage(user.active ? "账户已停用" : "账户已启用");
      },
    });
  }

  function confirmToggleAdmin(user: AdminUser) {
    const display = user.username ?? user.email;
    const granting = !user.is_admin;
    if (!canActOn(user)) {
      onMessage("不能对自己执行此项操作");
      return;
    }
    setConfirm({
      title: `${granting ? "授予" : "撤销"}管理员权限`,
      body: (
        <>
          <p>
            {granting ? "授予" : "撤销"} <strong>{display}</strong>（{user.email}）的平台管理员权限。
          </p>
          {!granting ? <p>撤销后该账户不再能进入管理控制台。</p> : <p>授予后该账户可以管理用户、公告和审计日志。</p>}
        </>
      ),
      action: granting ? "确认授予" : "确认撤销",
      danger: !granting,
      onConfirm: async () => {
        const updated = await client.updateUser(user.id, { is_admin: !user.is_admin });
        setDetailUser((current) => current?.id === updated.id ? { ...current, ...updated } : current);
        onMessage(granting ? "管理员权限已授予" : "管理员权限已撤销");
      },
    });
  }

  function confirmResetPassword(user: AdminUser) {
    const display = user.username ?? user.email;
    if (!canActOn(user)) {
      onMessage("不能为自己重置密码");
      return;
    }
    setConfirm({
      title: "重置密码",
      body: (
        <p>
          确认重置 <strong>{display}</strong>（{user.email}）的密码？该操作会强制登出其所有会话。
        </p>
      ),
      action: "确认重置",
      danger: true,
      password: { label: "新密码（至少 12 位）", minLength: 12 },
      onConfirm: async (password) => {
        await client.resetUserPassword(user.id, password);
        onMessage("密码已重置");
      },
    });
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmBusy(true);
    try {
      await client.createUser(createEmail.trim(), createPassword, createAdmin);
      onMessage("账号已创建");
      setCreateEmail("");
      setCreatePassword("");
      setCreateAdmin(false);
      setView("list");
      await load();
    } catch (error: unknown) {
      onMessage(explainError(error, "创建失败"));
    } finally {
      setConfirmBusy(false);
    }
  }

  const stale = loading || queryInput.trim() !== query;
  const initialLoad = loading && directory == null;
  const pageCount = directory ? Math.max(1, Math.ceil(directory.total / PAGE_SIZE)) : 1;

  if (view === "detail") {
    return (
      <section className="admin-section" aria-busy={detailBusy}>
        <header className="admin-content-header">
          <button type="button" onClick={() => setView("list")}>
            ← 返回用户列表
          </button>
          <h2>账号详情</h2>
        </header>
        {detailBusy || !detailUser ? (
          <p className="muted">正在加载账号详情…</p>
        ) : (
          <>
            <div className="user-detail-card">
              <div className="user-detail-header">
                <UserAvatar client={client} user={detailUser} onMessage={onMessage} />
                <div>
                  <strong>{detailUser.username ?? detailUser.email}</strong>
                  <small className="muted">
                    {detailUser.email} · {detailUser.is_admin ? "管理员" : "成员"} · {detailUser.active ? "启用" : "已停用"}
                  </small>
                </div>
              </div>
              <div className="user-detail-actions">
                <button type="button" disabled={!canActOn(detailUser)} onClick={() => confirmToggleActive(detailUser)}>
                  {detailUser.active ? "停用" : "启用"}
                </button>
                <button type="button" disabled={!canActOn(detailUser)} onClick={() => confirmToggleAdmin(detailUser)}>
                  {detailUser.is_admin ? "撤销管理员" : "授予管理员"}
                </button>
                <button type="button" disabled={!canActOn(detailUser)} onClick={() => confirmResetPassword(detailUser)}>
                  重置密码
                </button>
              </div>
              {detailUser.memberships.length === 0 ? (
                <small className="muted">未加入任何项目</small>
              ) : (
                <ul className="memberships">
                  {detailUser.memberships.map((membership) => (
                    <li key={membership.project_id}>
                      <small>
                        {membership.name} · {membership.role}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {confirm && <ConfirmDialog request={confirm} busy={confirmBusy} onSubmit={runMutation} onCancel={() => setConfirm(null)} />}
          </>
        )}
      </section>
    );
  }

  if (view === "create") {
    return (
      <section className="admin-section">
        <header className="admin-content-header">
          <button type="button" onClick={() => setView("list")}>
            ← 返回用户列表
          </button>
          <h2>创建账号</h2>
        </header>
        <form onSubmit={submitCreate}>
          <label>
            邮箱
            <input type="email" required value={createEmail} onChange={(event) => setCreateEmail(event.target.value)} />
          </label>
          <label>
            初始密码（至少 12 位）
            <input
              type="password"
              required
              minLength={12}
              value={createPassword}
              onChange={(event) => setCreatePassword(event.target.value)}
            />
          </label>
          <label>
            <input type="checkbox" checked={createAdmin} onChange={(event) => setCreateAdmin(event.target.checked)} />
            管理员
          </label>
          <button type="submit" disabled={confirmBusy}>
            创建账号
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="admin-section" aria-busy={stale}>
      <header className="admin-content-header">
        <h2>用户管理</h2>
        <button type="button" className="primary" onClick={() => setView("create")}>
          创建账号
        </button>
      </header>
      <div className="admin-filters">
        <label>
          搜索用户名或邮箱
          <input
            value={queryInput}
            placeholder="user@example.com"
            onChange={(event) => {
              setQueryInput(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          状态
          <select
            value={activeFilter}
            onChange={(event) => {
              setActiveFilter(event.target.value as ActiveFilter);
              setPage(0);
            }}
          >
            <option value="all">全部</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </label>
        <label>
          角色
          <select
            value={roleFilter}
            onChange={(event) => {
              setRoleFilter(event.target.value as RoleFilter);
              setPage(0);
            }}
          >
            <option value="all">全部</option>
            <option value="admin">管理员</option>
            <option value="member">成员</option>
          </select>
        </label>
      </div>
      {initialLoad ? <p className="muted" role="status">正在加载账号…</p> : null}
      {directoryError && directory == null && !initialLoad ? (
        <p role="alert" className="error">
          {directoryError}{" "}
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </p>
      ) : null}
      <div className="user-list">
        {directory?.items.map((user) => {
          const disabled = stale || !canActOn(user);
          return (
            <div className="user-row" key={user.id}>
              <div className="user-row-identity">
                <AvatarThumbnail user={user} size={40} />
                <div>
                  <strong>{user.username ?? user.email}</strong>
                  <small className="muted">
                    {user.username ? `${user.email} · ` : ""}
                    {user.is_admin ? "管理员" : "成员"} · {user.active ? "启用" : "已停用"}
                  </small>
                </div>
              </div>
              <div className="user-actions">
                <button type="button" disabled={disabled} onClick={() => confirmToggleActive(user)}>
                  {user.active ? "停用" : "启用"}
                </button>
                <button type="button" disabled={disabled} onClick={() => confirmResetPassword(user)}>
                  重置密码
                </button>
                <button type="button" disabled={stale} onClick={() => openDetail(user.id)}>
                  详情
                </button>
              </div>
            </div>
          );
        })}
        {directory && directory.items.length === 0 && !initialLoad ? <p className="muted">没有匹配的账号。</p> : null}
      </div>
      {directory ? (
        <div className="pager">
          <button type="button" disabled={stale || page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
            上一页
          </button>
          <span className="quota">
            第 {page + 1} / {pageCount} 页 · 共 {directory.total} 个账号
          </span>
          <button
            type="button"
            disabled={stale || (page + 1) * PAGE_SIZE >= directory.total}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}
      {confirm && <ConfirmDialog request={confirm} busy={confirmBusy} onSubmit={runMutation} onCancel={() => setConfirm(null)} />}
    </section>
  );
}

function AnnouncementsTab({ client, onMessage }: AdminConsoleProps) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "editor" | "preview">("list");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");
  const [retryKey, setRetryKey] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [retracting, setRetracting] = useState(false);
  const [confirming, setConfirming] = useState<Announcement | null>(null);

  const isDirty = useRef(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const rows = await client.listAnnouncements(PAGE_SIZE, page * PAGE_SIZE);
      setItems(rows);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (error: unknown) {
      const text = explainError(error, "无法加载公告");
      setError(text);
      onMessage(text);
    } finally {
      setBusy(false);
    }
  }, [client, onMessage, page]);

  useEffect(() => {
    if (view !== "list") return;
    void load();
  }, [load, view, page]);

  useEffect(() => {
    if (view !== "editor") return;
    if (!retryKey) {
      setRetryKey(newIdempotencyKey());
      isDirty.current = true;
    }
  }, [view, retryKey]);

  function resetEditor() {
    setTitle("");
    setBody("");
    setLevel("info");
    setRetryKey("");
    isDirty.current = false;
  }

  function enterCreate() {
    resetEditor();
    setView("editor");
  }

  function enterEdit(item: Announcement) {
    resetEditor();
    setTitle(item.title);
    setBody(item.body);
    setLevel(item.level);
    setView("editor");
  }

  function enterPreview() {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      onMessage("请填写公告标题和正文");
      return;
    }
    setTitle(trimmedTitle);
    setBody(trimmedBody);
    setView("preview");
  }

  async function submit() {
    if (!title.trim() || !body.trim()) {
      onMessage("请填写公告标题和正文");
      return;
    }
    setSubmitting(true);
    try {
      const key = retryKey || newIdempotencyKey();
      await client.createAnnouncement({ title: title.trim(), body: body.trim(), level }, key);
      onMessage("公告已发布");
      resetEditor();
      setView("list");
      setPage(0);
      await load();
    } catch (error: unknown) {
      // Allow retry with the same key on a transient error, but assign a new key after any edit.
      if (!retryKey) setRetryKey(newIdempotencyKey());
      onMessage(explainError(error, "发布失败"));
    } finally {
      setSubmitting(false);
    }
  }

  function onFieldChange() {
    if (!isDirty.current) return;
    setRetryKey(newIdempotencyKey());
  }

  async function retract(item: Announcement) {
    setRetracting(true);
    try {
      await client.deleteAnnouncement(item.id);
      onMessage("公告已撤回");
      await load();
    } catch (error: unknown) {
      onMessage(explainError(error, "撤回失败"));
    } finally {
      setRetracting(false);
      setConfirming(null);
    }
  }

  if (view === "editor") {
    return (
      <section className="admin-section">
        <header className="admin-content-header">
          <button type="button" onClick={() => setView("list")}>
            ← 返回公告列表
          </button>
          <h2>{retryKey ? "编辑公告" : "发布公告"}</h2>
        </header>
        <form
          className="announcement-form"
          onSubmit={(event) => {
            event.preventDefault();
            enterPreview();
          }}
        >
          <label>
            标题
            <input
              required
              maxLength={200}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                onFieldChange();
              }}
            />
          </label>
          <label>
            正文
            <textarea
              rows={4}
              required
              maxLength={4000}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                onFieldChange();
              }}
            />
          </label>
          <label>
            级别
            <select
              value={level}
              onChange={(event) => {
                setLevel(event.target.value as AnnouncementLevel);
                onFieldChange();
              }}
            >
              <option value="info">信息</option>
              <option value="warning">警告</option>
              <option value="critical">重要</option>
            </select>
          </label>
          <button type="submit" disabled={submitting}>
            预览并发布
          </button>
        </form>
      </section>
    );
  }

  if (view === "preview") {
    return (
      <section className="admin-section">
        <header className="admin-content-header">
          <button type="button" onClick={() => setView("editor")}>
            ← 返回编辑
          </button>
          <h2>发布预览</h2>
        </header>
        <article className="announcement-preview">
          <strong>{title}</strong>
          <p>{body}</p>
          <p>级别：{LEVEL_LABEL[level] || level}</p>
          <p>目标：当前启用的全部账户。</p>
          {level === "critical" ? <p>重要公告还将邮件通知已订阅且已验证邮箱的用户。</p> : null}
        </article>
        <button type="button" className="primary" disabled={submitting} onClick={() => void submit()}>
          {submitting ? "发布中…" : "确认发布"}
        </button>
      </section>
    );
  }

  return (
    <section className="admin-section">
      <header className="admin-content-header">
        <h2>公告管理</h2>
        <button type="button" className="primary" onClick={enterCreate}>
          发布公告
        </button>
      </header>
      {busy && items.length === 0 ? <p className="muted" role="status">正在加载公告…</p> : null}
      {error && items.length === 0 && !busy ? (
        <p role="alert" className="error">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </p>
      ) : null}
      <div className="user-list">
        {items.map((item) => (
          <div className="user-row announcement-row" key={item.id}>
            <div>
              <strong>{item.title}</strong>
              <small className="muted">
                {LEVEL_LABEL[item.level]} · {new Date(item.created_at).toLocaleString()}
              </small>
              <p className="announcement-counts">
                站内 {item.recipient_count ?? "-"} / 已读 {item.read_count ?? "-"} · 邮件 待发送 {item.mail_pending ?? "-"} / 已接受{" "}
                {item.mail_accepted ?? "-"} / 失败 {item.mail_failed ?? "-"} / 未知 {item.mail_unknown ?? "-"}
              </p>
              {item.body ? <p className="notify-body">{item.body}</p> : null}
            </div>
            <div className="user-actions">
              <button type="button" disabled={busy || submitting} onClick={() => enterEdit(item)}>
                编辑
              </button>
              <button type="button" disabled={busy || submitting || retracting} onClick={() => setConfirming(item)}>
                撤回公告
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && !busy ? <p className="muted">还没有发布过公告。</p> : null}
      </div>
      {items.length > 0 ? (
        <div className="pager">
          <button type="button" disabled={busy || page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
            上一页
          </button>
          <span className="quota">第 {page + 1} 页</span>
          <button type="button" disabled={busy || !hasMore} onClick={() => setPage((current) => current + 1)}>
            下一页
          </button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          request={{
            title: "撤回公告",
            body: (
              <p>
                撤回公告「<strong>{confirming.title}</strong>」？站内副本将移除，已发出的邮件不可追回。
              </p>
            ),
            action: "确认撤回",
            danger: true,
            onConfirm: async () => retract(confirming),
          }}
          busy={retracting}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}

function LogsTab({ client, onMessage }: AdminConsoleProps) {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [projectId, setProjectId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [applied, setApplied] = useState<AuditFilters>({});
  const [page, setPage] = useState(0);
  const [pageData, setPageData] = useState<AuditPage | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);

  // We need the auditFilters type from api-client. Import inline type here to satisfy TS.
  type AuditFilters = { actor?: string; action?: string; projectId?: string; since?: string; until?: string };

  useEffect(() => {
    let cancelled = false;
    client
      .auditActionList()
      .then((list) => {
        if (!cancelled) setActions(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) onMessage(explainError(error, "无法加载操作类型"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, onMessage]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    client
      .listAudit({ ...applied, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!cancelled) {
          setPageData(result);
          setExpandedId(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const text = explainError(error, "无法加载操作日志");
          setError(text);
          onMessage(text);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, client, onMessage, page]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const range = parseAuditLocalRange(since, until);
      setPage(0);
      setDetailEntry(null);
      setApplied({
        actor: actor.trim() || undefined,
        action: action || undefined,
        projectId: projectId.trim() || undefined,
        since: range.since,
        until: range.until,
      });
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "时间范围无效");
    }
  }

  async function download() {
    let url: string | null = null;
    try {
      const blob = await client.auditCsv(applied);
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit.csv";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error: unknown) {
      onMessage(explainError(error, "导出失败"));
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  const pageCount = pageData ? Math.max(1, Math.ceil(pageData.total / PAGE_SIZE)) : 1;

  function actorLabel(entry: AuditEntry): string {
    return entry.actor_username ?? entry.actor_email ?? "系统";
  }

  function AuditDetail({ entry, onBack }: { entry: AuditEntry; onBack: () => void }) {
    return (
      <div className="audit-detail-panel">
        <button type="button" className="back-link" onClick={onBack}>
          ← 返回审计列表
        </button>
        <h3>日志详情</h3>
        <p>
          <strong>时间</strong> {new Date(entry.created_at).toLocaleString()}
        </p>
        <p>
          <strong>操作者</strong> {actorLabel(entry)}
        </p>
        <p>
          <strong>动作</strong> {entry.action}
        </p>
        <p>
          <strong>目标类型</strong> {entry.target_type}
        </p>
        <p>
          <strong>目标 ID</strong> <code>{entry.target_id}</code>
        </p>
        {entry.project_name ? (
          <p>
            <strong>项目</strong> {entry.project_name}
          </p>
        ) : null}
        <pre>
          <code>{JSON.stringify(entry.metadata, null, 2)}</code>
        </pre>
      </div>
    );
  }

  const showList = detailEntry == null;

  return (
    <section className="admin-section">
      {showList ? (
        <>
          <header className="admin-content-header">
            <h2>审计日志</h2>
          </header>
          <form className="admin-filters" onSubmit={search}>
            <label>
              操作者
              <input value={actor} placeholder="用户名或邮箱" onChange={(event) => setActor(event.target.value)} />
            </label>
            <label>
              动作
              <select value={action} onChange={(event) => setAction(event.target.value)}>
                <option value="">全部动作</option>
                {actions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              项目 ID
              <input value={projectId} onChange={(event) => setProjectId(event.target.value)} />
            </label>
            <label>
              起始时间
              <input type="datetime-local" value={since} onChange={(event) => setSince(event.target.value)} />
            </label>
            <label>
              结束时间
              <input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
            </label>
            <button type="submit">查询</button>
            <button type="button" onClick={() => void download()}>
              下载 CSV
            </button>
          </form>
          {loading && pageData == null ? <p className="muted" role="status">正在加载操作日志…</p> : null}
          {error && pageData == null && !loading ? (
            <p role="alert" className="error">
              {error}{" "}
              <button type="button" onClick={() => void search({ preventDefault: () => {} } as unknown as FormEvent<HTMLFormElement>)}>
                重试
              </button>
            </p>
          ) : null}
          {pageData && pageData.items.length > 0 ? (
            <>
              <ol className="log-list audit-list">
                {pageData.items.map((entry) => (
                  <li key={entry.id} className={expandedId === entry.id ? "expanded" : undefined}>
                    <button type="button" className="log-line" onClick={() => setDetailEntry(entry)}>
                      <span>
                        {new Date(entry.created_at).toLocaleString()} · {actorLabel(entry)} · {entry.action}
                        {entry.target_type ? ` · ${entry.target_type}` : ""}
                        {entry.project_name ? ` · ${entry.project_name}` : ""}
                      </span>
                    </button>
                    {expandedId === entry.id ? (
                      <div className="audit-detail-inline">
                        <p>
                          目标 ID：<code>{entry.target_id}</code>
                        </p>
                        <pre>
                          <code>{JSON.stringify(entry.metadata, null, 2)}</code>
                        </pre>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
              <div className="pager">
                <button type="button" disabled={loading || page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
                  上一页
                </button>
                <span className="quota">
                  第 {page + 1} / {pageCount} 页 · 共 {pageData.total} 条
                </span>
                <button
                  type="button"
                  disabled={loading || (page + 1) * PAGE_SIZE >= pageData.total}
                  onClick={() => setPage((current) => current + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          ) : (
            <p className="muted">{pageData && pageData.items.length === 0 ? "没有匹配的操作日志。" : null}</p>
          )}
        </>
      ) : (
        <AuditDetail entry={detailEntry} onBack={() => setDetailEntry(null)} />
      )}
    </section>
  );
}

