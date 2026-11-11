import { explainError } from "@rescene/api-client";
import type {
  AdminUserDetail,
  AdminUserPage,
  Announcement,
  AnnouncementLevel,
  AuditEntry,
  AuditPage,
} from "@rescene/schemas";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { client } from "../api";
import { spacing, theme } from "../theme";
import { Button, Card, ErrorText, Field, Screen, Segmented, textStyles } from "../ui";

type AdminTab = "users" | "announcements" | "logs";
type StatusFilter = "all" | "active" | "inactive";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

const TABS: { value: AdminTab; label: string }[] = [
  { value: "users", label: "用户" },
  { value: "announcements", label: "公告" },
  { value: "logs", label: "日志" },
];
const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "启用" },
  { value: "inactive", label: "停用" },
];
const LEVELS: { value: AnnouncementLevel; label: string }[] = [
  { value: "info", label: "通知" },
  { value: "warning", label: "警告" },
  { value: "critical", label: "紧急" },
];
const LEVEL_LABEL: Record<AnnouncementLevel, string> = { info: "通知", warning: "警告", critical: "紧急" };

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

export function AdminScreen({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<AdminTab>("users");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 用户
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [userPage, setUserPage] = useState(0);
  const [directory, setDirectory] = useState<AdminUserPage | null>(null);
  const [userRevision, setUserRevision] = useState(0);
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);

  // 公告
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementRevision, setAnnouncementRevision] = useState(0);

  // 日志
  const [actor, setActor] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditPage, setAuditPage] = useState(0);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [auditRevision, setAuditRevision] = useState(0);

  useEffect(() => {
    setError("");
    setNotice("");
  }, [tab]);

  useEffect(() => {
    if (tab !== "users") return;
    let active = true;
    const timer = setTimeout(() => {
      void client
        .listUsers({
          query: query.trim(),
          active: statusFilter === "all" ? undefined : statusFilter === "active",
          offset: userPage * PAGE_SIZE,
          limit: PAGE_SIZE,
        })
        .then((page) => {
          if (!active) return;
          setDirectory(page);
          setError("");
        })
        .catch((reason: unknown) => {
          if (active) setError(explainError(reason, "加载用户失败"));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tab, query, statusFilter, userPage, userRevision]);

  useEffect(() => {
    if (tab !== "announcements") return;
    let active = true;
    void client
      .listAnnouncements()
      .then((rows) => {
        if (!active) return;
        setAnnouncements(rows);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active) setError(explainError(reason, "加载公告失败"));
      });
    return () => {
      active = false;
    };
  }, [tab, announcementRevision]);

  useEffect(() => {
    if (tab !== "logs") return;
    let active = true;
    const timer = setTimeout(() => {
      void client
        .listAudit({ actor: actor.trim(), action: auditAction.trim(), offset: auditPage * PAGE_SIZE, limit: PAGE_SIZE })
        .then((page) => {
          if (!active) return;
          setAudit(page);
          setError("");
        })
        .catch((reason: unknown) => {
          if (active) setError(explainError(reason, "加载操作日志失败"));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tab, actor, auditAction, auditPage, auditRevision]);

  async function run(action: () => Promise<void>, fallback = "操作失败") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(explainError(reason, fallback));
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(userId: string) {
    if (detailFor === userId) {
      setDetailFor(null);
      setDetail(null);
      return;
    }
    setDetailFor(userId);
    setDetail(null);
    setError("");
    setBusy(true);
    try {
      setDetail(await client.getUser(userId));
    } catch (reason) {
      setError(explainError(reason, "加载用户详情失败"));
      setDetailFor(null);
    } finally {
      setBusy(false);
    }
  }

  const users = directory?.items ?? [];
  const auditRows: AuditEntry[] = audit?.items ?? [];

  return (
    <Screen scroll title="管理">
      <Segmented value={tab} onChange={setTab} options={TABS} />
      {error ? (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      ) : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}

      {tab === "users" ? (
        <>
          <Card>
            <Field label="搜索用户" value={query} onChangeText={(value) => { setQuery(value); setUserPage(0); }} placeholder="按邮箱筛选" />
            <Segmented
              value={statusFilter}
              onChange={(value) => { setStatusFilter(value); setUserPage(0); }}
              options={STATUSES}
            />
            <Text style={textStyles.muted}>共 {directory?.total ?? 0} 个账户</Text>
          </Card>
          <Card>
            <Text style={textStyles.body}>用户列表</Text>
            {directory && users.length === 0 ? <Text style={textStyles.muted}>没有匹配的账户。</Text> : null}
            {!directory ? <Text style={textStyles.muted}>加载中…</Text> : null}
            {users.map((user) => (
              <View
                key={user.id}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border, gap: 6 }}
              >
                <Text style={textStyles.body}>{user.email}</Text>
                <Text style={textStyles.muted}>
                  {user.is_admin ? "管理员" : "成员"} · {user.active ? "启用" : "已停用"} · 创建于 {new Date(user.created_at).toLocaleDateString()}
                </Text>
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      disabled={busy}
                      label={user.active ? "停用" : "启用"}
                      tone="ghost"
                      onPress={() =>
                        void run(async () => {
                          await client.updateUser(user.id, { active: !user.active });
                          setUserRevision((value) => value + 1);
                          setNotice(user.active ? "账户已停用。" : "账户已启用。");
                        }, "更新账户失败")
                      }
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={passwordFor === user.id ? "取消" : "重置密码"}
                      tone="ghost"
                      onPress={() => {
                        setPasswordFor(passwordFor === user.id ? null : user.id);
                        setPassword("");
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={detailFor === user.id ? "收起" : "详情"}
                      tone="ghost"
                      onPress={() => void openDetail(user.id)}
                    />
                  </View>
                </View>
                {passwordFor === user.id ? (
                  <View style={{ gap: spacing.xs }}>
                    <Field
                      label={`${user.email} 的新密码（至少 12 位）`}
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      autoComplete="new-password"
                    />
                    <Button
                      disabled={busy || password.length < 12}
                      label="确认重置"
                      onPress={() =>
                        void run(async () => {
                          await client.resetUserPassword(user.id, password);
                          setPasswordFor(null);
                          setPassword("");
                          setNotice("密码已重置，该用户需使用新密码登录。");
                        }, "重置密码失败")
                      }
                    />
                  </View>
                ) : null}
                {detailFor === user.id ? (
                  detail ? (
                    <View style={{ gap: 4 }}>
                      <Text style={textStyles.muted}>成员项目（{detail.memberships.length}）</Text>
                      {detail.memberships.length === 0 ? (
                        <Text style={textStyles.muted}>暂无所属项目。</Text>
                      ) : (
                        detail.memberships.map((membership) => (
                          <Text key={membership.project_id} style={textStyles.muted}>
                            {membership.name} · {membership.role}
                          </Text>
                        ))
                      )}
                    </View>
                  ) : (
                    <Text style={textStyles.muted}>正在加载详情…</Text>
                  )
                ) : null}
              </View>
            ))}
            {directory ? (
              <Pager
                page={userPage}
                total={directory.total}
                disabled={busy}
                onChange={setUserPage}
              />
            ) : null}
          </Card>
          <Card>
            <Text style={textStyles.body}>创建账户</Text>
            <Field label="邮箱" value={newEmail} onChangeText={setNewEmail} keyboardType="email-address" autoComplete="email" placeholder="member@example.com" />
            <Field label="初始密码（至少 12 位）" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" />
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: newAdmin }} onPress={() => setNewAdmin(!newAdmin)}>
              <Text style={textStyles.body}>{newAdmin ? "☑" : "☐"} 管理员权限</Text>
            </Pressable>
            <Button
              disabled={busy || !newEmail.trim() || newPassword.length < 12}
              label="创建账户"
              onPress={() =>
                void run(async () => {
                  await client.createUser(newEmail.trim(), newPassword, newAdmin);
                  setNewEmail("");
                  setNewPassword("");
                  setNewAdmin(false);
                  setUserRevision((value) => value + 1);
                  setNotice("账户已创建。");
                }, "创建账户失败")
              }
            />
          </Card>
        </>
      ) : null}

      {tab === "announcements" ? (
        <>
          <Card>
            <Text style={textStyles.body}>发布公告</Text>
            <Field label="标题" value={title} onChangeText={setTitle} placeholder="公告标题" />
            <Field label="正文" value={body} onChangeText={setBody} multiline placeholder="向所有活跃用户发布的说明" />
            <Segmented value={level} onChange={setLevel} options={LEVELS} />
            <Button
              disabled={busy || !title.trim() || !body.trim()}
              label="发布公告"
              onPress={() =>
                void run(async () => {
                  await client.createAnnouncement({ title: title.trim(), body: body.trim(), level });
                  setTitle("");
                  setBody("");
                  setAnnouncementRevision((value) => value + 1);
                  setNotice("公告已发布，所有活跃用户会收到通知。");
                }, "发布公告失败")
              }
            />
          </Card>
          <Card>
            <Text style={textStyles.body}>已发布（{announcements.length}）</Text>
            {announcements.length === 0 ? <Text style={textStyles.muted}>暂无公告。</Text> : null}
            {announcements.map((item) => (
              <View
                key={item.id}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border, gap: 4 }}
              >
                <Text style={textStyles.body}>{item.title}</Text>
                <Text style={textStyles.muted}>{LEVEL_LABEL[item.level]} · {new Date(item.created_at).toLocaleString()}</Text>
                <Text numberOfLines={3} style={textStyles.muted}>{item.body}</Text>
                <Button
                  disabled={busy}
                  label="撤回公告"
                  tone="ghost"
                  onPress={() =>
                    Alert.alert("撤回公告", `确定撤回「${item.title}」？相关通知将一并删除。`, [
                      { text: "取消", style: "cancel" },
                      {
                        text: "撤回",
                        style: "destructive",
                        onPress: () =>
                          void run(async () => {
                            await client.deleteAnnouncement(item.id);
                            setAnnouncementRevision((value) => value + 1);
                            setNotice("公告已撤回。");
                          }, "撤回公告失败"),
                      },
                    ])
                  }
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {tab === "logs" ? (
        <>
          <Card>
            <Field label="操作者" value={actor} onChangeText={(value) => { setActor(value); setAuditPage(0); }} placeholder="按邮箱筛选" />
            <Field label="动作" value={auditAction} onChangeText={(value) => { setAuditAction(value); setAuditPage(0); }} placeholder="如 user. 前缀或 project.rename" />
            <Button label="刷新" disabled={busy} tone="ghost" onPress={() => setAuditRevision((value) => value + 1)} />
          </Card>
          <Card>
            <Text style={textStyles.body}>操作日志（{audit?.total ?? 0}）</Text>
            {audit && auditRows.length === 0 ? <Text style={textStyles.muted}>没有匹配的记录。</Text> : null}
            {!audit ? <Text style={textStyles.muted}>加载中…</Text> : null}
            {auditRows.map((entry) => (
              <View
                key={entry.id}
                style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border, gap: 2 }}
              >
                <Text style={textStyles.body}>{entry.action}</Text>
                <Text style={textStyles.muted}>
                  {new Date(entry.created_at).toLocaleString()} · {entry.actor_email ?? "系统"}
                  {entry.project_name ? ` · ${entry.project_name}` : ""}
                </Text>
                <Text style={textStyles.muted}>{entry.target_type} · {entry.target_id}</Text>
              </View>
            ))}
            {audit ? (
              <Pager page={auditPage} total={audit.total} disabled={busy} onChange={setAuditPage} />
            ) : null}
          </Card>
        </>
      ) : null}

      <Button label="返回" tone="ghost" onPress={onBack} />
    </Screen>
  );
}
