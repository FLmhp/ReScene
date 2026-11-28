"use client";

import { explainError, type ResceneClient } from "@rescene/api-client";
import type { NotificationPreferences, NotificationPreferencesPatch, User } from "@rescene/schemas";
import { type FormEvent, useEffect, useRef, useState } from "react";

export type NotificationPreferencesProps = {
  client: ResceneClient;
  user: User;
};

type PreferenceKey = keyof Omit<NotificationPreferences, "email_verified">;

const PREFERENCE_OPTIONS: { key: PreferenceKey; label: string; detail: string }[] = [
  {
    key: "email_critical_announcements",
    label: "重要公告",
    detail: "总管理员发布的重要公告会额外发送邮件。",
  },
  {
    key: "email_job_results",
    label: "任务结果",
    detail: "任务最终成功或失败时发送邮件；中间重试不发送。",
  },
];

/** The shared notification subscription editor for Web and desktop settings. */
export function NotificationPreferencesPanel({ client, user }: NotificationPreferencesProps) {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState<PreferenceKey | "">("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const loadRequest = useRef(0);

  async function load() {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await client.getNotificationPreferences();
      if (request === loadRequest.current) setPreferences(next);
    } catch (error) {
      if (request === loadRequest.current) setLoadError(explainError(error, "无法加载通知偏好"));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
    // The editor belongs to one signed-in account; reload only when that account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, user.id]);

  async function toggle(key: PreferenceKey, value: boolean) {
    if (!preferences || saving) return;
    if (value && !preferences.email_verified) {
      setActionError("请先验证收件邮箱，再开启邮件订阅。");
      setNotice("");
      return;
    }
    const patch: NotificationPreferencesPatch = key === "email_critical_announcements"
      ? { email_critical_announcements: value }
      : { email_job_results: value };
    setSaving(key);
    setActionError("");
    setNotice("");
    try {
      const next = await client.updateNotificationPreferences(patch);
      setPreferences(next);
      setNotice(value ? "已开启邮件订阅。" : "已关闭邮件订阅。");
    } catch (error) {
      setActionError(explainError(error, "保存通知偏好失败"));
    } finally {
      setSaving("");
    }
  }

  async function requestVerification() {
    if (verifying) return;
    setVerifying(true);
    setActionError("");
    setNotice("");
    try {
      await client.requestNotificationEmailVerification();
      setCodeSent(true);
      setNotice("验证码已发送，请检查邮箱。");
    } catch (error) {
      setActionError(explainError(error, "验证邮件暂不可用，请稍后重试。"));
    } finally {
      setVerifying(false);
    }
  }

  async function confirmVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifying) return;
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setActionError("请输入 6 位验证码。");
      return;
    }
    setVerifying(true);
    setActionError("");
    setNotice("");
    try {
      const next = await client.confirmNotificationEmailVerification(value);
      setPreferences(next);
      setCode("");
      setCodeSent(false);
      setNotice("收件邮箱已验证。");
    } catch (error) {
      setActionError(explainError(error, "验证码无效或已过期，请重新获取。"));
    } finally {
      setVerifying(false);
    }
  }

  if (loading && !preferences) return <p className="muted" role="status">正在加载通知偏好…</p>;
  if (loadError && !preferences) {
    return (
      <div className="settings-load-error" role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={() => void load()}>重试</button>
      </div>
    );
  }
  if (!preferences) return null;

  return (
    <div className="notification-preferences">
      <section className="notification-email" aria-labelledby="notification-email-title">
        <h2 id="notification-email-title">收件邮箱</h2>
        <p>{user.email}</p>
        <p className="muted">
          {preferences.email_verified
            ? "已验证。验证码与订阅邮件会发送到此邮箱。"
            : "尚未验证。开启任一邮件订阅前，请先验证此邮箱。"}
        </p>
        {!preferences.email_verified && (
          <div className="notification-verify">
            <p className="muted">验证码邮件不受订阅开关影响。</p>
            <button type="button" disabled={verifying} onClick={() => void requestVerification()}>
              {verifying ? "发送中…" : codeSent ? "重新发送验证码" : "验证收件邮箱"}
            </button>
            {codeSent && (
              <form onSubmit={confirmVerification}>
                <label>
                  验证码
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                </label>
                <button type="submit" disabled={verifying || code.length !== 6}>
                  {verifying ? "验证中…" : "确认验证"}
                </button>
              </form>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="notification-subscriptions-title">
        <h2 id="notification-subscriptions-title">邮件订阅</h2>
        <p className="muted">默认不发送。关闭订阅不会影响站内通知，也不会撤回已投递的邮件。</p>
        <div className="preference-list">
          {PREFERENCE_OPTIONS.map((option) => (
            <label className="preference-toggle" key={option.key}>
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              <input
                type="checkbox"
                checked={preferences[option.key]}
                disabled={saving !== "" || verifying}
                onChange={(event) => void toggle(option.key, event.target.checked)}
              />
            </label>
          ))}
        </div>
      </section>

      {actionError && <p className="error" role="alert">{actionError}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      <p className="muted">邮件投递状态只表示 SMTP 接受情况，不代表站内消息已读。</p>
    </div>
  );
}
