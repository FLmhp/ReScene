import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { legalDocuments, type LegalDocumentId, type NotificationPreferences } from "@rescene/schemas";
import { Button, Input, Switch, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  changeSessionPassword, client, currentQueueOwner, isQueueOwnerCurrent, queueClient, signOutSession,
} from "../../api";
import { AvatarProfile } from "../../avatar-profile";
import { openHome, setLogoutNotice } from "../../navigation";
import { AppearancePage, Screen, WorkspaceEntry } from "../../screen";

type Section = "account" | "password" | "notifications" | "appearance" | "legal";

const SECTIONS: readonly { id: Exclude<Section, "password">; title: string; summary: string; scope: "所有设备" | "仅此设备" | null }[] = [
  { id: "account", title: "账户与安全", summary: "头像、用户名、邮箱、密码与退出登录", scope: "所有设备" },
  { id: "notifications", title: "通知偏好", summary: "验证收件邮箱，订阅重要公告和任务结果邮件", scope: "所有设备" },
  { id: "appearance", title: "外观", summary: "明暗、配色、字体大小与面板效果", scope: "仅此设备" },
  { id: "legal", title: "协议与许可", summary: "用户协议、隐私说明与开源许可", scope: null },
];
const TITLES: Record<Section, string> = {
  account: "账户与安全",
  password: "修改密码",
  notifications: "通知偏好",
  appearance: "外观",
  legal: "协议与许可",
};

function parseSection(value: string | undefined): Section | null {
  return value === "account" || value === "password" || value === "notifications" || value === "appearance" || value === "legal" ? value : null;
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) {
    if (isOfflineError(reason)) return "网络不可用，请联网后重试。";
    return explainError(reason, reason.detail || fallback);
  }
  return reason instanceof Error ? reason.message : fallback;
}

function openSection(section: Section) {
  void Taro.navigateTo({ url: `/pages/settings/index?section=${section}` })
    .catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }));
}

function leaveSection() {
  const fallback = () => void Taro.redirectTo({ url: "/pages/settings/index" }).catch(() => undefined);
  const pages = Taro.getCurrentPages();
  if (pages.length > 1) void Taro.navigateBack().catch(fallback);
  else fallback();
}

export default function SettingsPage() {
  const section = parseSection(useRouter()?.params.section);
  useEffect(() => {
    void Taro.setNavigationBarTitle({ title: section ? TITLES[section] : "设置" }).catch(() => undefined);
  }, [section]);
  return <WorkspaceEntry>
    <Screen>
      {section ? <SectionShell section={section}><SectionBody section={section} /></SectionShell> : <SettingsDirectory />}
    </Screen>
  </WorkspaceEntry>;
}

function SectionShell({ section, children }: { section: Section; children: ReactNode }) {
  return <>
    <View className="settings-section-head">
      <Button className="button ghost compact" onClick={leaveSection}>返回</Button>
    </View>
    <Text className="title">{TITLES[section]}</Text>
    {children}
  </>;
}

function SectionBody({ section }: { section: Section }) {
  if (section === "account") return <AccountSection />;
  if (section === "password") return <PasswordSection />;
  if (section === "notifications") return <NotificationSection />;
  if (section === "appearance") return <AppearanceSection />;
  return <LegalSection />;
}

function SettingsDirectory() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const shown = useRef(true);
  const load = useCallback(async () => {
    const owner = currentQueueOwner();
    if (!owner) {
      if (shown.current) { setLoading(false); setError("登录会话已过期，请重新登录。"); }
      return;
    }
    setLoading(true);
    setError("");
    try {
      const me = await queueClient(owner).getMe();
      if (!shown.current || !isQueueOwnerCurrent(owner) || me.id !== owner.id) return;
      setAdmin(me.is_admin);
    } catch (reason) {
      if (shown.current && isQueueOwnerCurrent(owner)) setError(errorText(reason, "加载账户信息失败。"));
    } finally {
      if (shown.current && isQueueOwnerCurrent(owner)) setLoading(false);
    }
  }, []);
  useEffect(() => () => { shown.current = false; }, []);
  useEffect(() => { void load(); }, [load]);
  useDidShow(() => {
    if (!shown.current) { shown.current = true; void load(); }
  });
  useDidHide(() => { shown.current = false; });

  return <>
    <Text className="title">设置</Text>
    <Text className="muted">账户资料和邮件订阅会同步到所有设备；外观只保存在此设备。</Text>
    {SECTIONS.map((item) => <Button key={item.id} className="button ghost settings-entry" onClick={() => openSection(item.id)}>
      <View className="settings-entry-head">
        <Text className="settings-entry-title">{item.title}</Text>
        {item.scope ? <Text className="settings-scope">{item.scope}</Text> : null}
      </View>
      <Text className="muted">{item.summary}</Text>
    </Button>)}
    {loading ? <Text className="muted">正在加载账户信息…</Text> : null}
    {error ? <View className="card">
      <Text className="error">{error}</Text>
      <Button className="button ghost" onClick={() => void load()}>重试</Button>
    </View> : null}
    {admin ? <View className="card settings-admin">
      <Text className="label">管理控制台</Text>
      <Text className="muted">用户管理、公告管理与审计日志。仅平台管理员可见。</Text>
      <Button className="button ghost" onClick={() => void Taro.navigateTo({ url: "/pages/admin/index" }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }))}>进入管理控制台</Button>
    </View> : null}
  </>;
}

function AccountSection() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    if (busy) return;
    setBusy(true);
    const revoked = await signOutSession();
    setLogoutNotice(revoked ? "已退出登录。" : "本机已退出，但服务器无法确认会话已撤销。请检查网络并联系管理员撤销会话。");
    await openHome().catch(() => undefined);
  }
  return <>
    <Text className="muted">账户资料会同步到所有设备。</Text>
    <AvatarProfile client={client} />
    <View className="card">
      <Text className="label">安全</Text>
      <Text className="muted">修改密码会更新当前会话，并让其他设备退出登录。邮箱为只读，用于登录和验证码。</Text>
      <Button className="button ghost" onClick={() => openSection("password")}>修改密码</Button>
      <Button className="button ghost" disabled={busy} loading={busy} onClick={() => void logout()}>退出登录</Button>
    </View>
  </>;
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shown = useRef(true);
  useEffect(() => () => { shown.current = false; }, []);
  async function submit() {
    if (busy) return;
    if (next.length < 12) { setError("新密码至少 12 位。"); return; }
    if (next !== confirm) { setError("两次输入的新密码不一致。"); return; }
    const owner = currentQueueOwner();
    if (!owner) { setError("登录会话已过期，请重新登录。"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const changed = await changeSessionPassword(current, next);
      if (!shown.current) return;
      if (!changed) { setError("登录状态已变化，请重新登录后再试。"); return; }
      if (!isQueueOwnerCurrent(owner)) { setError("登录状态已变化，请重新登录。"); return; }
      setCurrent("");
      setNext("");
      setConfirm("");
      setNotice("密码已更新，其他设备已退出登录。");
    } catch (reason) {
      if (shown.current && isQueueOwnerCurrent(owner)) setError(errorText(reason, "更新密码失败。"));
    } finally {
      if (shown.current) setBusy(false);
    }
  }
  return <View className="card">
    <Text className="muted">密码更改会同步到所有设备。</Text>
    <Text className="label">当前密码</Text>
    <Input className="input" password value={current} onInput={(event) => setCurrent(event.detail.value)} />
    <Text className="label">新密码（至少 12 位）</Text>
    <Input className="input" password value={next} onInput={(event) => setNext(event.detail.value)} />
    <Text className="label">确认新密码</Text>
    <Input className="input" password value={confirm} onInput={(event) => setConfirm(event.detail.value)} />
    <Button className="button" disabled={busy || !current || !next || !confirm} loading={busy} onClick={() => void submit()}>更新密码</Button>
    {error ? <Text className="error">{error}</Text> : null}
    {notice ? <Text className="success-state">{notice}</Text> : null}
  </View>;
}

function NotificationSection() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"verify-request" | "verify-confirm" | "critical" | "results" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shown = useRef(true);
  const request = useRef(0);
  const load = useCallback(async () => {
    const owner = currentQueueOwner();
    if (!owner) {
      if (shown.current) { setLoading(false); setError("登录会话已过期，请重新登录。"); }
      return;
    }
    const id = ++request.current;
    const current = () => shown.current && isQueueOwnerCurrent(owner) && request.current === id;
    setLoading(true);
    setError("");
    try {
      const api = queueClient(owner);
      const [me, next] = await Promise.all([api.getMe(), api.getNotificationPreferences()]);
      if (!current() || me.id !== owner.id) return;
      setEmail(me.email);
      setPreferences(next);
    } catch (reason) {
      if (current()) setError(errorText(reason, "加载通知偏好失败。"));
    } finally {
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => { shown.current = false; request.current += 1; }; }, [load]);
  useDidHide(() => { shown.current = false; request.current += 1; });
  useDidShow(() => {
    if (!shown.current) { shown.current = true; void load(); }
  });

  async function requestCode() {
    if (busy) return;
    const owner = currentQueueOwner();
    if (!owner) { setError("登录会话已过期，请重新登录。"); return; }
    setBusy("verify-request");
    setError("");
    setNotice("");
    try {
      await queueClient(owner).requestNotificationEmailVerification();
      if (shown.current && isQueueOwnerCurrent(owner)) setNotice("验证码已发送到账户邮箱，请查收后输入。");
    } catch (reason) {
      if (shown.current && isQueueOwnerCurrent(owner)) setError(errorText(reason, "发送验证码失败。"));
    } finally {
      if (shown.current) setBusy(null);
    }
  }

  async function confirmCode() {
    if (busy) return;
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) { setError("请输入 6 位验证码。"); return; }
    const owner = currentQueueOwner();
    if (!owner) { setError("登录会话已过期，请重新登录。"); return; }
    setBusy("verify-confirm");
    setError("");
    setNotice("");
    try {
      const next = await queueClient(owner).confirmNotificationEmailVerification(value);
      if (!shown.current || !isQueueOwnerCurrent(owner)) return;
      setPreferences(next);
      setCode("");
      setNotice("收件邮箱已验证，可以开启邮件订阅。");
    } catch (reason) {
      if (shown.current && isQueueOwnerCurrent(owner)) setError(errorText(reason, "验证码验证失败。"));
    } finally {
      if (shown.current) setBusy(null);
    }
  }

  async function toggle(key: "email_critical_announcements" | "email_job_results", value: boolean) {
    if (busy || !preferences) return;
    const owner = currentQueueOwner();
    if (!owner) { setError("登录会话已过期，请重新登录。"); return; }
    setBusy(key === "email_critical_announcements" ? "critical" : "results");
    setError("");
    setNotice("");
    try {
      const patch = key === "email_critical_announcements"
        ? { email_critical_announcements: value }
        : { email_job_results: value };
      const next = await queueClient(owner).updateNotificationPreferences(patch);
      if (!shown.current || !isQueueOwnerCurrent(owner)) return;
      setPreferences(next);
      setNotice(value ? "已开启邮件订阅。" : "已关闭邮件订阅。");
    } catch (reason) {
      if (shown.current && isQueueOwnerCurrent(owner)) {
        setError(reason instanceof ResceneApiError && reason.code === "notifications.email_unverified"
          ? "请先验证收件邮箱，再开启邮件通知。"
          : errorText(reason, "更新通知偏好失败。"));
      }
    } finally {
      if (shown.current) setBusy(null);
    }
  }

  if (loading && !preferences) return <Text className="muted">正在加载通知偏好…</Text>;
  if (!preferences) return <View className="card">
    <Text className="error">{error || "无法加载通知偏好。"}</Text>
    <Button className="button ghost" onClick={() => void load()}>重试</Button>
  </View>;
  const verified = preferences.email_verified;
  return <>
    <Text className="muted">邮件订阅随账户同步到所有设备。默认关闭；验证码登录邮件不受订阅开关影响。</Text>
    <View className="card">
      <Text className="label">收件邮箱</Text>
      <Text className="muted">{email || "—"}</Text>
      <Text className={verified ? "success-state" : "muted"}>{verified ? "已验证" : "尚未验证"}</Text>
      {!verified ? <>
        <Text className="muted">开启任一订阅前需要验证当前账户邮箱。验证码会发送到该邮箱。</Text>
        <Button className="button ghost" loading={busy === "verify-request"} disabled={Boolean(busy)} onClick={() => void requestCode()}>发送验证码</Button>
        <Input className="input" type="number" maxlength={6} placeholder="6 位验证码" value={code} onInput={(event) => setCode(event.detail.value)} />
        <Button className="button" loading={busy === "verify-confirm"} disabled={Boolean(busy) || code.trim().length !== 6} onClick={() => void confirmCode()}>确认验证</Button>
      </> : null}
      {error ? <Text className="error">{error}</Text> : null}
      {notice ? <Text className="success-state">{notice}</Text> : null}
    </View>
    <View className="card">
      <Text className="label">邮件订阅</Text>
      <View className="row">
        <Text className="label">重要公告</Text>
        <Switch checked={preferences.email_critical_announcements} disabled={Boolean(busy)} onChange={(event) => void toggle("email_critical_announcements", event.detail.value)} />
      </View>
      <View className="row">
        <Text className="label">任务成功／失败</Text>
        <Switch checked={preferences.email_job_results} disabled={Boolean(busy)} onChange={(event) => void toggle("email_job_results", event.detail.value)} />
      </View>
      <Text className="muted">关闭订阅无需验证邮箱。已发送或已提交给邮件服务的邮件无法撤回。</Text>
    </View>
  </>;
}

function AppearanceSection() {
  return <>
    <Text className="muted">以下外观设置仅保存到此设备，不影响其他设备。</Text>
    <AppearancePage />
  </>;
}

function LegalSection() {
  const [active, setActive] = useState<LegalDocumentId | null>(null);
  const doc = legalDocuments.find((item) => item.id === active) ?? null;
  if (doc) return <>
    <View className="settings-section-head">
      <Button className="button ghost compact" onClick={() => setActive(null)}>返回协议与许可</Button>
    </View>
    <Text className="title">{doc.title}</Text>
    {doc.status ? <Text className="legal-status">{doc.status}</Text> : null}
    <View className="card legal-document">
      {doc.paragraphs.map((paragraph, index) => <Text className="legal-paragraph" key={index}>{paragraph}</Text>)}
    </View>
  </>;
  return <>
    <Text className="muted">协议与许可内容随应用提供，可离线阅读。用户协议和隐私说明为审核稿，尚未生效。</Text>
    {legalDocuments.map((item) => <Button key={item.id} className="button ghost settings-entry" onClick={() => setActive(item.id)}>
      <View className="settings-entry-head">
        <Text className="settings-entry-title">{item.title}</Text>
        {item.status ? <Text className="legal-status">{item.status}</Text> : <Text className="settings-scope">开源许可</Text>}
      </View>
      <Text className="muted">{item.id === "licenses" ? "仓库 MIT 许可与 Inter 字体许可全文" : "阅读完整正文"}</Text>
    </Button>)}
  </>;
}
