import { explainError } from "@rescene/api-client";
import { legalDocuments, type LegalDocumentId, type NotificationPreferences, type User } from "@rescene/schemas";
import { LEGACY_QUEUE_NOTICE } from "@rescene/uploader";
import { useEffect, useRef, useState } from "react";
import { Switch, View } from "react-native";

import { AccountProfile } from "../AccountProfile";
import { apiBaseUrl, changeSessionPassword, currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { useAppearance } from "../appearance";
import { hasLegacyQueue } from "../queue";
import { Button, Card, ErrorText, Field, ScaledText as Text, Screen, useTextStyles } from "../ui";

const FORM_WIDTH = { maxWidth: 560, width: "100%" as const, alignSelf: "center" as const };
const CODE = /^\d{6}$/;
const RESEND_SECONDS = 60;

export type SettingsCategory = "account" | "notifications" | "appearance" | "legal";

const GROUPS: readonly {
  page: SettingsCategory;
  title: string;
  scope: string | null;
  description: string;
  action: string;
}[] = [
  {
    page: "account",
    title: "账户与安全",
    scope: "所有设备",
    description: "头像、用户名、只读邮箱、密码和退出登录。",
    action: "管理账户与安全",
  },
  {
    page: "notifications",
    title: "通知偏好",
    scope: "所有设备",
    description: "验证收件邮箱，并分别开启重要公告和任务结果的邮件订阅。",
    action: "设置通知偏好",
  },
  {
    page: "appearance",
    title: "外观",
    scope: "仅此设备",
    description: "明暗、配色、自定义主色、字体大小和面板效果。",
    action: "调整外观",
  },
  {
    page: "legal",
    title: "协议与许可",
    scope: null,
    description: "用户协议、隐私说明和开源许可。前两项为审核稿，尚未生效。",
    action: "阅读协议与许可",
  },
];

const SUBSCRIPTIONS: readonly {
  key: "email_critical_announcements" | "email_job_results";
  label: string;
  hint: string;
}[] = [
  {
    key: "email_critical_announcements",
    label: "重要公告",
    hint: "仅接收重要级别的公告邮件。验证收件邮箱后可开启。",
  },
  {
    key: "email_job_results",
    label: "任务结果",
    hint: "任务成功或最终失败时发送邮件，重试中的任务不发。验证收件邮箱后可开启。",
  },
];

function useCurrentUser() {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const owner = currentQueueOwner();
    if (!owner) {
      setUser(null);
      setLoading(false);
      return () => { active = false; };
    }
    const current = () => active && isQueueOwnerCurrent(owner);
    setLoading(true);
    setError("");
    const api = (() => {
      try { return queueClient(owner); }
      catch { return null; }
    })();
    if (!api) {
      setLoading(false);
      return () => { active = false; };
    }
    void api.getMe().then((next) => {
      if (current()) setUser(next);
    }).catch((reason) => {
      if (current()) setError(explainError(reason, "加载账户信息失败"));
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { active = false; };
  }, [revision]);

  return { user, setUser, error, loading, reload: () => setRevision((value) => value + 1) };
}

export function SettingsScreen({ backLabel = "返回", onBack, onOpen, onAdmin }: {
  backLabel?: string;
  onBack: () => void;
  onOpen: (page: SettingsCategory) => void;
  onAdmin: () => void;
}) {
  const textStyles = useTextStyles();
  const { user, error, reload } = useCurrentUser();
  const [legacyQueue, setLegacyQueue] = useState(false);

  useEffect(() => {
    let active = true;
    void hasLegacyQueue().then((value) => {
      if (active) setLegacyQueue(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  return <Screen backLabel={backLabel} onBack={onBack} scroll title="设置">
    {GROUPS.map((group) => <Card key={group.page}>
      <Text accessibilityRole="header" style={textStyles.heading}>{group.title}</Text>
      {group.scope ? <Text style={textStyles.muted}>{group.scope}</Text> : null}
      <Text style={textStyles.body}>{group.description}</Text>
      <Button label={group.action} onPress={() => onOpen(group.page)} />
    </Card>)}
    {legacyQueue ? <Text style={textStyles.muted}>{LEGACY_QUEUE_NOTICE}</Text> : null}
    {error ? <Card>
      <ErrorText>{error}</ErrorText>
      <Button label="重新加载账户信息" tone="ghost" onPress={reload} />
    </Card> : null}
    {user?.is_admin ? <Card>
      <Text accessibilityRole="header" style={textStyles.heading}>管理控制台</Text>
      <Text style={textStyles.muted}>用户、公告和审计日志。</Text>
      <Button label="管理控制台" onPress={onAdmin} />
    </Card> : null}
    <Card>
      <Text style={textStyles.muted}>服务器地址（只读）</Text>
      <Text selectable style={textStyles.body}>{apiBaseUrl}</Text>
    </Card>
  </Screen>;
}

export function AccountSettingsScreen({ backLabel = "返回设置", onBack, onChangePassword, onSignOut }: {
  backLabel?: string;
  onBack: () => void;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const textStyles = useTextStyles();
  const { user, setUser, error, loading, reload } = useCurrentUser();

  return <Screen backLabel={backLabel} onBack={onBack} scroll title="账户与安全">
    <Text style={textStyles.muted}>所有设备 · 账户资料会在所有设备同步。</Text>
    {loading ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>正在加载账户…</Text> : null}
    {error ? <Card>
      <ErrorText>{error}</ErrorText>
      <Button label="重新加载" tone="ghost" onPress={reload} />
    </Card> : null}
    {!loading && !error && !user ? <Text style={textStyles.muted}>账户信息不可用，请返回后重试。</Text> : null}
    {user ? <AccountProfile
      key={user.id}
      user={user}
      onChangeUser={setUser}
      onChangePassword={onChangePassword}
      onSignOut={onSignOut}
    /> : null}
  </Screen>;
}

export function PasswordSettingsScreen({ backLabel = "返回账户与安全", onBack }: {
  backLabel?: string;
  onBack: () => void;
}) {
  const textStyles = useTextStyles();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    const owner = currentQueueOwner();
    if (!owner || !currentPassword || newPassword.length < 12 || pending.current) return;
    const current = () => mounted.current && isQueueOwnerCurrent(owner);
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!await changeSessionPassword(currentPassword, newPassword)) {
        if (current()) setError("密码已更新，但无法保存设备登录信息。请检查系统安全存储后重新登录。");
        return;
      }
      if (!current()) return;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("密码已更新，其他设备已退出登录。");
    } catch (reason) {
      if (current()) setError(explainError(reason, "更新密码失败。"));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  return <Screen backLabel={backLabel} onBack={onBack} scroll title="修改密码">
    <Card style={FORM_WIDTH}>
      <Field label="当前密码" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry autoComplete="current-password" />
      <Field label="新密码（至少 12 位）" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" />
      <Field label="确认新密码" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" returnKeyType="done" onSubmitEditing={() => void changePassword()} />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
      <Button disabled={busy || !currentPassword || newPassword.length < 12 || !confirmPassword} label={busy ? "正在更新…" : "更新密码"} onPress={() => void changePassword()} />
    </Card>
  </Screen>;
}

export function NotificationSettingsScreen({ backLabel = "返回设置", onBack }: {
  backLabel?: string;
  onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    let active = true;
    const owner = currentQueueOwner();
    if (!owner) {
      setLoading(false);
      return () => { active = false; };
    }
    const current = () => active && isQueueOwnerCurrent(owner);
    setLoading(true);
    setLoadError("");
    setError("");
    setNotice("");
    setPreferences(null);
    const api = (() => {
      try { return queueClient(owner); }
      catch { return null; }
    })();
    if (!api) {
      setLoading(false);
      return () => { active = false; };
    }
    void Promise.all([
      api.getNotificationPreferences(),
      api.getMe().catch(() => null),
    ]).then(([next, user]) => {
      if (!current()) return;
      setPreferences(next);
      setEmail(user?.email ?? null);
    }).catch((reason) => {
      if (current()) setLoadError(explainError(reason, "加载通知偏好失败"));
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { active = false; };
  }, [revision]);

  async function toggle(key: "email_critical_announcements" | "email_job_results", value: boolean) {
    const owner = currentQueueOwner();
    if (!owner || !preferences || pending.current) return;
    const current = () => mounted.current && isQueueOwnerCurrent(owner);
    const patch = key === "email_critical_announcements"
      ? { email_critical_announcements: value }
      : { email_job_results: value };
    pending.current = true;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const next = await queueClient(owner).updateNotificationPreferences(patch);
      if (!current()) return;
      setPreferences(next);
      setNotice(value ? "已开启邮件订阅。" : "已关闭邮件订阅。");
    } catch (reason) {
      if (current()) setError(explainError(reason, "保存通知偏好失败"));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  async function requestVerification() {
    const owner = currentQueueOwner();
    if (!owner || pending.current) return;
    const current = () => mounted.current && isQueueOwnerCurrent(owner);
    pending.current = true;
    setBusy("request");
    setError("");
    setNotice("");
    try {
      await queueClient(owner).requestNotificationEmailVerification();
      if (!current()) return;
      setCooldown(RESEND_SECONDS);
      setNotice(`验证码已发送到 ${email ?? "账户邮箱"}。`);
    } catch (reason) {
      if (current()) setError(explainError(reason, "发送验证邮件失败"));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  async function confirmVerification() {
    const trimmed = code.trim();
    if (!CODE.test(trimmed)) {
      setError("请输入 6 位验证码。");
      return;
    }
    const owner = currentQueueOwner();
    if (!owner || pending.current) return;
    const current = () => mounted.current && isQueueOwnerCurrent(owner);
    pending.current = true;
    setBusy("confirm");
    setError("");
    setNotice("");
    try {
      const next = await queueClient(owner).confirmNotificationEmailVerification(trimmed);
      if (!current()) return;
      setPreferences(next);
      setCode("");
      setNotice("邮箱已验证，可以开启邮件订阅。");
    } catch (reason) {
      if (current()) setError(explainError(reason, "验证收件邮箱失败"));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  return <Screen backLabel={backLabel} onBack={onBack} scroll title="通知偏好">
    <Text style={textStyles.muted}>所有设备 · 邮箱验证和邮件订阅会同步到所有设备。</Text>
    {loading ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>正在加载通知偏好…</Text> : null}
    {loadError ? <Card>
      <ErrorText>{loadError}</ErrorText>
      <Button label="重新加载" tone="ghost" onPress={() => setRevision((value) => value + 1)} />
    </Card> : null}
    {error ? <ErrorText>{error}</ErrorText> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
    {preferences ? <>
      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>收件邮箱</Text>
        <Text style={textStyles.body}>{email ?? "账户邮箱"}</Text>
        <Text style={{ color: preferences.email_verified ? theme.success : theme.muted, fontSize: 16 }}>
          {preferences.email_verified ? "邮箱已验证" : "邮箱未验证"}
        </Text>
      </Card>
      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>验证收件邮箱</Text>
        {preferences.email_verified ? <Text style={textStyles.body}>当前邮箱已验证。验证码只用于通知订阅验证。</Text> : <>
          <Text style={textStyles.muted}>验证码会发送到该邮箱。验证后才能开启邮件订阅；关闭订阅无需验证。</Text>
          <Button disabled={busy !== null || cooldown > 0} label={cooldown > 0 ? `${cooldown} 秒后可重新发送` : "发送验证码"} tone="ghost" onPress={() => void requestVerification()} />
          <Field label="6 位验证码" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="done" onSubmitEditing={() => void confirmVerification()} />
          <Button disabled={busy !== null || !CODE.test(code.trim())} label={busy === "confirm" ? "正在验证…" : "确认验证"} onPress={() => void confirmVerification()} />
        </>}
      </Card>
      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>邮件订阅</Text>
        <Text style={textStyles.muted}>默认不发邮件。关闭订阅不影响站内通知、验证码或已投递邮件。</Text>
        {SUBSCRIPTIONS.map((item) => {
          const value = preferences[item.key];
          const locked = !preferences.email_verified && !value;
          return <View key={item.key} style={{ alignItems: "center", flexDirection: "row", gap: 12, minHeight: 52 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={textStyles.body}>{item.label}</Text>
              <Text style={textStyles.muted}>{item.hint}</Text>
            </View>
            <Switch
              accessibilityHint={locked ? "请先验证收件邮箱" : undefined}
              accessibilityLabel={`${item.label}邮件订阅`}
              disabled={busy !== null || locked}
              ios_backgroundColor={theme.border}
              onValueChange={(next) => void toggle(item.key, next)}
              thumbColor={theme.onAccent}
              trackColor={{ false: theme.border, true: theme.accentStrong }}
              value={value}
            />
          </View>;
        })}
        {busy ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>正在保存…</Text> : null}
      </Card>
    </> : null}
  </Screen>;
}

export function LegalScreen({ backLabel = "返回设置", onBack, onOpen }: {
  backLabel?: string;
  onBack: () => void;
  onOpen: (id: LegalDocumentId) => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();

  return <Screen backLabel={backLabel} onBack={onBack} scroll title="协议与许可">
    <Text style={textStyles.muted}>以下内容随应用离线提供。用户协议与隐私说明为审核稿，尚未生效。</Text>
    {legalDocuments.map((legalDocument) => <Card key={legalDocument.id}>
      <Text accessibilityRole="header" style={textStyles.heading}>{legalDocument.title}</Text>
      {legalDocument.status ? <Text style={{ color: theme.danger, fontSize: 16, fontWeight: "600" }}>{legalDocument.status}</Text> : null}
      <Text style={textStyles.muted}>{legalDocument.paragraphs.length} 段</Text>
      <Button label={`阅读${legalDocument.title}`} tone="ghost" onPress={() => onOpen(legalDocument.id)} />
    </Card>)}
  </Screen>;
}

export function LegalDocumentScreen({ documentId, backLabel = "返回协议与许可", onBack }: {
  documentId: LegalDocumentId;
  backLabel?: string;
  onBack: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const legalDocument = legalDocuments.find((item) => item.id === documentId);

  if (!legalDocument) {
    return <Screen backLabel={backLabel} onBack={onBack} scroll title="协议与许可">
      <ErrorText>找不到该文档。</ErrorText>
    </Screen>;
  }

  return <Screen backLabel={backLabel} onBack={onBack} scroll title={legalDocument.title}>
    {legalDocument.status ? <Card>
      <Text accessibilityRole="header" style={{ color: theme.danger, fontSize: 18, fontWeight: "600" }}>{legalDocument.status}</Text>
    </Card> : null}
    <View style={{ gap: 16, maxWidth: 720, width: "100%", alignSelf: "center" }}>
      {legalDocument.paragraphs.map((paragraph, index) => <Text key={index} selectable style={textStyles.body}>{paragraph}</Text>)}
    </View>
  </Screen>;
}
