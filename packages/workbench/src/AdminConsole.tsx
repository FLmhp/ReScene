"use client";

import { explainError, type ResceneClient } from "@rescene/api-client";
import type { AdminUserDetail, AdminUserPage, Announcement, AnnouncementLevel, AuditPage } from "@rescene/schemas";
import { type FormEvent, useCallback, useEffect, useState } from "react";

export type AdminConsoleProps = { client: ResceneClient; onMessage: (text: string) => void };

type Tab = "users" | "announcements" | "logs";
type ActiveFilter = "all" | "active" | "inactive";
type AuditQuery = { actor?: string; action?: string; projectId?: string; since?: string; until?: string };

const PAGE_SIZE = 20;
const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "用户" },
  { id: "announcements", label: "公告" },
  { id: "logs", label: "操作日志" },
];
const LEVEL_LABEL: Record<AnnouncementLevel, string> = { info: "信息", warning: "警告", critical: "重要" };

export function AdminConsole({ client, onMessage }: AdminConsoleProps) {
  const [tab, setTab] = useState<Tab>("users");

  return (
    <div className="admin-console">
      <h2>管理控制台</h2>
      <div className="admin-tabs" role="tablist">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {tab === "users" ? <UsersTab client={client} onMessage={onMessage} /> : null}
      {tab === "announcements" ? <AnnouncementsTab client={client} onMessage={onMessage} /> : null}
      {tab === "logs" ? <LogsTab client={client} onMessage={onMessage} /> : null}
    </div>
  );
}

function UsersTab({ client, onMessage }: AdminConsoleProps) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [page, setPage] = useState(0);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [passwordFor, setPasswordFor] = useState("");
  const [password, setPassword] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createAdmin, setCreateAdmin] = useState(false);

  const load = useCallback(async () => {
    try {
      setDirectory(
        await client.listUsers({
          query,
          active: activeFilter === "all" ? undefined : activeFilter === "active",
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      );
    } catch (error) {
      onMessage(explainError(error, "无法加载账号列表"));
    }
  }, [activeFilter, client, onMessage, page, query]);

  useEffect(() => {
    void load();
  }, [load]);

  function run(action: () => Promise<void>) {
    void action().catch((error: unknown) => onMessage(explainError(error, "操作失败")));
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(async () => {
      await client.createUser(createEmail.trim(), createPassword, createAdmin);
      setCreateEmail("");
      setCreatePassword("");
      setCreateAdmin(false);
      onMessage("账号已创建");
      await load();
    });
  }

  const pageCount = directory ? Math.max(1, Math.ceil(directory.total / PAGE_SIZE)) : 1;

  return (
    <section className="admin-section">
      <div className="admin-filters">
        <label>搜索邮箱<input value={query} placeholder="user@example.com" onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
        <label>状态
          <select value={activeFilter} onChange={(event) => { setActiveFilter(event.target.value as ActiveFilter); setPage(0); }}>
            <option value="all">全部</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </label>
      </div>
      {!directory ? <p className="muted">正在加载账号…</p> : null}
      <div className="user-list">
        {directory?.items.map((user) => (
          <div className="user-row" key={user.id}>
            <div>
              <span>{user.email} · {user.is_admin ? "管理员" : "成员"} · {user.active ? "启用" : "已停用"}</span>
              {detailId === user.id && detail ? (
                detail.memberships.length === 0 ? <small className="muted">未加入任何项目</small> : (
                  <ul className="memberships">
                    {detail.memberships.map((membership) => (
                      <li key={membership.project_id}><small>{membership.name} · {membership.role}</small></li>
                    ))}
                  </ul>
                )
              ) : null}
            </div>
            <div className="user-actions">
              <button type="button" onClick={() => run(async () => { await client.updateUser(user.id, { active: !user.active }); await load(); })}>{user.active ? "停用" : "启用"}</button>
              <button type="button" onClick={() => { setPasswordFor(passwordFor === user.id ? "" : user.id); setPassword(""); }}>重置密码</button>
              <button type="button" onClick={() => run(async () => { if (detailId === user.id) { setDetailId(""); setDetail(null); return; } setDetail(await client.getUser(user.id)); setDetailId(user.id); })}>{detailId === user.id ? "收起详情" : "详情"}</button>
            </div>
            {passwordFor === user.id ? (
              <div className="admin-inline">
                <input aria-label={`${user.email} 的新密码`} type="password" minLength={12} placeholder="新密码（至少 12 位）" value={password} onChange={(event) => setPassword(event.target.value)} />
                <button type="button" disabled={password.length < 12} onClick={() => run(async () => { await client.resetUserPassword(user.id, password); setPassword(""); setPasswordFor(""); onMessage("密码已重置"); })}>确认重置</button>
                <button type="button" onClick={() => { setPasswordFor(""); setPassword(""); }}>取消</button>
              </div>
            ) : null}
          </div>
        ))}
        {directory && directory.items.length === 0 ? <p className="muted">没有匹配的账号。</p> : null}
      </div>
      <div className="pager">
        <button type="button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button>
        <span className="quota">第 {page + 1} / {pageCount} 页 · 共 {directory?.total ?? 0} 个账号</span>
        <button type="button" disabled={!directory || (page + 1) * PAGE_SIZE >= directory.total} onClick={() => setPage((current) => current + 1)}>下一页</button>
      </div>
      <details>
        <summary>创建账号</summary>
        <form onSubmit={submitCreate}>
          <label>邮箱<input type="email" required value={createEmail} onChange={(event) => setCreateEmail(event.target.value)} /></label>
          <label>初始密码（至少 12 位）<input type="password" required minLength={12} value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} /></label>
          <label><input type="checkbox" checked={createAdmin} onChange={(event) => setCreateAdmin(event.target.checked)} />管理员</label>
          <button type="submit">创建账号</button>
        </form>
      </details>
    </section>
  );
}

function AnnouncementsTab({ client, onMessage }: AdminConsoleProps) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");

  const load = useCallback(async () => {
    try {
      setItems(await client.listAnnouncements());
    } catch (error) {
      onMessage(explainError(error, "无法加载公告"));
    }
  }, [client, onMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) {
      onMessage("请填写公告标题和正文");
      return;
    }
    void (async () => {
      try {
        await client.createAnnouncement({ title: title.trim(), body: body.trim(), level });
        setTitle("");
        setBody("");
        setLevel("info");
        onMessage("公告已发布");
        await load();
      } catch (error) {
        onMessage(explainError(error, "发布失败"));
      }
    })();
  }

  function remove(item: Announcement) {
    if (!window.confirm(`删除公告「${item.title}」？`)) return;
    void client.deleteAnnouncement(item.id).then(load).catch((error: unknown) => onMessage(explainError(error, "删除失败")));
  }

  return (
    <section className="admin-section">
      <form className="announcement-form" onSubmit={submit}>
        <label>标题<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>正文<textarea rows={4} required maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <label>级别
          <select value={level} onChange={(event) => setLevel(event.target.value as AnnouncementLevel)}>
            <option value="info">信息</option>
            <option value="warning">警告</option>
            <option value="critical">重要</option>
          </select>
        </label>
        <button type="submit">发布公告</button>
      </form>
      <div className="user-list">
        {items.map((item) => (
          <div className="user-row" key={item.id}>
            <div>
              <strong>{item.title}</strong>
              <small className="muted"> · {LEVEL_LABEL[item.level]} · {new Date(item.created_at).toLocaleString()}</small>
              {item.body ? <p className="notify-body">{item.body}</p> : null}
            </div>
            <div className="user-actions"><button type="button" onClick={() => remove(item)}>删除</button></div>
          </div>
        ))}
        {items.length === 0 ? <p className="muted">还没有发布过公告。</p> : null}
      </div>
    </section>
  );
}

function LogsTab({ client, onMessage }: AdminConsoleProps) {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [projectId, setProjectId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [applied, setApplied] = useState<AuditQuery>({});
  const [page, setPage] = useState(0);
  const [pageData, setPageData] = useState<AuditPage | null>(null);
  const [actions, setActions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void client.auditActionList()
      .then((list) => { if (!cancelled) setActions(list); })
      .catch((error: unknown) => { if (!cancelled) onMessage(explainError(error, "无法加载操作类型")); });
    return () => { cancelled = true; };
  }, [client, onMessage]);

  useEffect(() => {
    let cancelled = false;
    void client.listAudit({ ...applied, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => { if (!cancelled) setPageData(result); })
      .catch((error: unknown) => { if (!cancelled) onMessage(explainError(error, "无法加载操作日志")); });
    return () => { cancelled = true; };
  }, [applied, client, onMessage, page]);

  /** `datetime-local` yields a naive local string; the API compares UTC instants. */
  function isoLocal(value: string): string | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setApplied({ actor: actor.trim(), action, projectId: projectId.trim(), since: isoLocal(since), until: isoLocal(until) });
  }

  async function download() {
    try {
      const blob = await client.auditCsv(applied);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit.csv";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      onMessage(explainError(error, "导出失败"));
    }
  }

  const pageCount = pageData ? Math.max(1, Math.ceil(pageData.total / PAGE_SIZE)) : 1;

  return (
    <section className="admin-section">
      <form className="admin-filters" onSubmit={search}>
        <label>操作者<input value={actor} placeholder="user@example.com" onChange={(event) => setActor(event.target.value)} /></label>
        <label>动作
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">全部动作</option>
            {actions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
        <label>起始时间<input type="datetime-local" value={since} onChange={(event) => setSince(event.target.value)} /></label>
        <label>结束时间<input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} /></label>
        <button type="submit">查询</button>
        <button type="button" onClick={() => void download()}>下载 CSV</button>
      </form>
      {pageData && pageData.items.length > 0 ? (
        <ol className="log-list">
          {pageData.items.map((entry) => (
            <li key={entry.id}>
              <code className="log-line">
                {new Date(entry.created_at).toLocaleString()} · {entry.actor_email ?? "系统"} · {entry.action}
                {entry.target_type ? ` · ${entry.target_type}` : ""}
                {entry.project_name ? ` · ${entry.project_name}` : ""}
              </code>
            </li>
          ))}
        </ol>
      ) : <p className="muted">没有匹配的操作日志。</p>}
      <div className="pager">
        <button type="button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button>
        <span className="quota">第 {page + 1} / {pageCount} 页 · 共 {pageData?.total ?? 0} 条</span>
        <button type="button" disabled={!pageData || (page + 1) * PAGE_SIZE >= pageData.total} onClick={() => setPage((current) => current + 1)}>下一页</button>
      </div>
    </section>
  );
}
