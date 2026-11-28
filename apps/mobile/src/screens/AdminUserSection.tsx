import { explainError, type ResceneClient } from "@rescene/api-client";
import type { AdminUser, AdminUserDetail, AdminUserPage } from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { Avatar } from "../Avatar";
import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { spacing } from "../theme";
import { useAppearance } from "../appearance";
import { Button, Card, ErrorText, Field, ScaledText as Text, Segmented, useTextStyles } from "../ui";

import { AdminConfirmSheet } from "./AdminConfirmSheet";
import { AdminPage } from "./AdminPage";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

type StatusFilter = "all" | "active" | "inactive";
type AdminFilter = "all" | "admin" | "member";

type ConfirmAction =
  | { kind: "active"; user: AdminUser; nextActive: boolean }
  | { kind: "admin"; user: AdminUser; nextAdmin: boolean }
  | { kind: "password"; user: AdminUser };

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "启用" },
  { value: "inactive", label: "停用" },
];
const ROLES: { value: AdminFilter; label: string }[] = [
  { value: "all", label: "全部角色" },
  { value: "admin", label: "管理员" },
  { value: "member", label: "成员" },
];

function Pager({
  page,
  total,
  disabled,
  onChange,
}: {
  page: number;
  total: number;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const textStyles = useTextStyles();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={textStyles.muted}>第 {page + 1} / {pages} 页 · 共 {total} 条</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button disabled={disabled || page <= 0} label="上一页" tone="ghost" onPress={() => onChange(page - 1)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            disabled={disabled || page + 1 >= pages}
            label="下一页"
            tone="ghost"
            onPress={() => onChange(page + 1)}
          />
        </View>
      </View>
    </View>
  );
}

export function AdminUserSection() {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [adminFilter, setAdminFilter] = useState<AdminFilter>("all");
  const [page, setPage] = useState(0);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedFilter, setLoadedFilter] = useState("");
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailError, setDetailError] = useState("");

  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [password, setPassword] = useState("");

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);
  const mutationPending = useRef(false);
  const filter = JSON.stringify([query.trim(), statusFilter, adminFilter, page, revision]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError("");
    const timer = setTimeout(() => {
      const owner = currentQueueOwner();
      if (!owner || !isQueueOwnerCurrent(owner)) {
        if (active) {
          setLoading(false);
          setListError("会话已失效，请重新登录。");
        }
        return;
      }
      void queueClient(owner)
        .listUsers({
          query: query.trim(),
          active: statusFilter === "all" ? undefined : statusFilter === "active",
          isAdmin: adminFilter === "all" ? undefined : adminFilter === "admin",
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        })
        .then((result) => {
          if (!active || !isQueueOwnerCurrent(owner)) return;
          setDirectory(result);
          setLoadedFilter(filter);
          setPage((current) => Math.max(0, Math.min(current, Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1))));
          setListError("");
        })
        .catch((reason) => {
          if (!active || !isQueueOwnerCurrent(owner)) return;
          setListError(explainError(reason, "加载用户失败"));
        })
        .finally(() => {
          if (active && isQueueOwnerCurrent(owner)) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filter, query, statusFilter, adminFilter, page, revision]);

  useEffect(() => {
    if (!detailFor) return;
    let active = true;
    setDetailError("");
    const owner = currentQueueOwner();
    if (!owner) {
      setDetailError("会话已失效，请重新登录。");
      return;
    }
    void queueClient(owner).getUser(detailFor).then((result) => {
      if (active && isQueueOwnerCurrent(owner)) setDetail(result);
    }).catch((reason) => {
      if (active && isQueueOwnerCurrent(owner)) setDetailError(explainError(reason, "加载账号详情失败"));
    });
    return () => { active = false; };
  }, [detailFor, revision]);

  async function run(action: (api: ResceneClient) => Promise<void>, success: string) {
    if (mutationPending.current) return;
    const owner = currentQueueOwner();
    if (!owner) {
      setError("会话已失效，请重新登录。");
      return;
    }
    mutationPending.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action(queueClient(owner));
      if (!isQueueOwnerCurrent(owner)) return;
      setConfirm(null);
      setPassword("");
      setCreating(false);
      setNewPassword("");
      setNewEmail("");
      setNewAdmin(false);
      setRevision((value) => value + 1);
      setNotice(success);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setError(explainError(reason, "操作失败"));
    } finally {
      mutationPending.current = false;
      if (isQueueOwnerCurrent(owner)) setWorking(false);
    }
  }

  function openDetail(userId: string) {
    setDetail(null);
    setDetailError("");
    setDetailFor(userId);
  }

  function setActive(user: AdminUser, nextActive: boolean) {
    void run(async (api) => { await api.updateUser(user.id, { active: nextActive }); }, nextActive ? "账户已启用。" : "账户已停用。");
  }

  function setAdmin(user: AdminUser, nextAdmin: boolean) {
    void run(async (api) => { await api.updateUser(user.id, { is_admin: nextAdmin }); }, nextAdmin ? "已授予管理员权限。" : "已撤销管理员权限。");
  }

  function resetPassword(user: AdminUser) {
    if (password.length >= 12) void run(async (api) => { await api.resetUserPassword(user.id, password); }, "密码已重置，该用户需使用新密码登录。");
  }

  function createAccount() {
    const email = newEmail.trim();
    if (email && newPassword.length >= 12) {
      void run(async (api) => { await api.createUser(email, newPassword, newAdmin); }, "账户已创建。");
    }
  }

  function beginConfirm(action: ConfirmAction) {
    setError("");
    setPassword("");
    setConfirm(action);
  }

  const owner = currentQueueOwner();
  const locked = !owner || working || loadedFilter !== filter;
  const users = directory?.items ?? [];

  const confirmProps = confirm
    ? confirm.kind === "active"
      ? {
          title: `${confirm.nextActive ? "启用" : "停用"}账户 ${confirm.user.username ?? confirm.user.email}`,
          consequences: [
            `邮箱：${confirm.user.email}`,
            confirm.nextActive ? "停用期间不能登录；启用后恢复登录。" : "停用后该账户将无法登录，已创建的离线队列可能受阻。",
          ],
          actionLabel: confirm.nextActive ? "确认启用" : "确认停用",
          destructive: !confirm.nextActive,
          onConfirm: () => void setActive(confirm.user, confirm.nextActive),
        }
      : confirm.kind === "admin"
      ? {
          title: `${confirm.nextAdmin ? "授予" : "撤销"}管理员权限`,
          consequences: [
            `账户：${confirm.user.username ?? confirm.user.email}（${confirm.user.email}）`,
            confirm.nextAdmin
              ? "该账户将能管理用户、发布公告和查看全局审计日志。"
              : "撤销后该账户不再能进入管理控制台。",
            "必须始终保留至少一名可用管理员。",
          ],
          actionLabel: confirm.nextAdmin ? "授予权限" : "撤销权限",
          destructive: !confirm.nextAdmin,
          onConfirm: () => void setAdmin(confirm.user, confirm.nextAdmin),
        }
      : {
          title: `重置 ${confirm.user.username ?? confirm.user.email} 的密码`,
          consequences: [
            `邮箱：${confirm.user.email}`,
            "新密码将立即生效，该用户其他设备上的会话将被终止。",
            "请通过安全渠道将新密码告知该用户。",
          ],
          actionLabel: "确认重置",
          destructive: false,
          onConfirm: () => void resetPassword(confirm.user),
        }
    : null;

  function leaveSecondary() {
    setError("");
    if (confirm) {
      setPassword("");
      setConfirm(null);
    } else if (creating) {
      setCreating(false);
      setNewPassword("");
    } else {
      setDetailFor(null);
      setDetail(null);
    }
  }

  return (
    <View style={{ gap: spacing.md }}>
      <Button label="创建账号" onPress={() => { setError(""); setCreating(true); }} disabled={!owner || working} />
      {listError ? <><ErrorText>{listError}</ErrorText><Button label="重试" tone="ghost" onPress={() => setRevision((value) => value + 1)} /></> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
      <Card>
        <Field label="搜索用户名或邮箱" value={query} onChangeText={(value) => { setQuery(value); setPage(0); }} placeholder="用户名或邮箱" />
        <Segmented value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(0); }} options={STATUSES} />
        <Segmented value={adminFilter} onChange={(value) => { setAdminFilter(value); setPage(0); }} options={ROLES} />
      </Card>
      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>用户管理</Text>
        {loading && !directory ? <Text style={textStyles.muted}>正在加载用户…</Text> : null}
        {!loading && !listError && directory && users.length === 0 ? <Text style={textStyles.muted}>没有匹配的账户。</Text> : null}
        {users.map((user) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${user.username ?? user.email} · 详情`}
            key={user.id}
            disabled={locked}
            onPress={() => openDetail(user.id)}
            style={{ flexDirection: "row", alignItems: "center", minHeight: 60, gap: spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}
          >
            <Avatar user={user} size={40} showImage={false} />
            <View style={{ flex: 1 }}>
              <Text style={textStyles.body}>{user.username ?? user.email}</Text>
              {user.username ? <Text style={textStyles.muted}>{user.email}</Text> : null}
              <Text style={textStyles.muted}>{user.is_admin ? "管理员" : "成员"} · {user.active ? "启用" : "已停用"}</Text>
            </View>
            <Text style={textStyles.muted}>详情</Text>
          </Pressable>
        ))}
        {directory ? <Pager page={page} total={directory.total} disabled={locked} onChange={setPage} /> : null}
      </Card>

      {confirmProps || creating || detailFor ? (
        <AdminPage title={confirmProps ? "确认操作" : creating ? "创建账号" : "账号详情"} busy={working} onBack={leaveSecondary}>
          {error ? <ErrorText>{error}</ErrorText> : null}
          {confirmProps ? (
            <AdminConfirmSheet {...confirmProps} busy={working} disabled={!owner || (confirm?.kind === "password" && password.length < 12)} onCancel={leaveSecondary}>
              {confirm?.kind === "password" ? <Field label="新密码（至少 12 位）" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" /> : null}
            </AdminConfirmSheet>
          ) : creating ? (
            <Card>
              <Field label="邮箱" value={newEmail} onChangeText={setNewEmail} keyboardType="email-address" autoComplete="email" />
              <Field label="初始密码（至少 12 位）" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" />
              <Pressable style={{ minHeight: 44, justifyContent: "center" }} accessibilityRole="checkbox" accessibilityState={{ checked: newAdmin }} onPress={() => setNewAdmin(!newAdmin)}>
                <Text style={textStyles.body}>{newAdmin ? "☑" : "☐"} 管理员权限</Text>
              </Pressable>
              <Button disabled={!owner || working || !newEmail.trim() || newPassword.length < 12} label={working ? "创建中…" : "创建账号"} onPress={createAccount} />
            </Card>
          ) : detailError ? (
            <><ErrorText>{detailError}</ErrorText><Button label="重试" tone="ghost" onPress={() => setRevision((value) => value + 1)} /></>
          ) : detail ? (
            <Card>
              <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
                <Avatar user={detail} size={80} />
                <View style={{ flex: 1 }}>
                  <Text style={textStyles.heading}>{detail.username ?? detail.email}</Text>
                  <Text style={textStyles.muted}>{detail.email}</Text>
                  <Text style={textStyles.muted}>{detail.is_admin ? "管理员" : "成员"} · {detail.active ? "启用" : "已停用"}</Text>
                </View>
              </View>
              {!detail.memberships.length ? <Text style={textStyles.muted}>暂无所属项目。</Text> :
                detail.memberships.map((membership) => (
                  <Text key={membership.project_id} style={textStyles.body}>{membership.name} · {membership.role === "owner" ? "拥有" : "加入"}</Text>
                ))}
              <Button label={detail.active ? "停用账号" : "启用账号"} tone="ghost" disabled={locked || owner?.id === detail.id} onPress={() => beginConfirm({ kind: "active", user: detail, nextActive: !detail.active })} />
              <Button label={detail.is_admin ? "撤销管理员权限" : "授予管理员权限"} tone="ghost" disabled={locked || owner?.id === detail.id} onPress={() => beginConfirm({ kind: "admin", user: detail, nextAdmin: !detail.is_admin })} />
              <Button label="重置密码" tone="ghost" disabled={locked || owner?.id === detail.id} onPress={() => beginConfirm({ kind: "password", user: detail })} />
            </Card>
          ) : <Text style={textStyles.muted}>正在加载详情…</Text>}
        </AdminPage>
      ) : null}
    </View>
  );
}
