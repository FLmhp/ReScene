"use client";

import type { ResceneClient } from "@rescene/api-client";
import { legalDocuments, type LegalDocumentId, type User } from "@rescene/schemas";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { AccountProfile } from "./AccountProfile";
import { NotificationPreferencesPanel } from "./NotificationPreferences";
import { ThemeControl, type AppearanceSelection } from "./ThemeControl";

export type SettingsCategory = "account" | "notifications" | "appearance" | "legal";

const CATEGORIES: { key: SettingsCategory; label: string; scope: string }[] = [
  { key: "account", label: "账户与安全", scope: "所有设备" },
  { key: "notifications", label: "通知偏好", scope: "所有设备" },
  { key: "appearance", label: "外观", scope: "仅此设备" },
  { key: "legal", label: "协议与许可", scope: "" },
];

export type SettingsViewProps = {
  client: ResceneClient;
  user: User | null;
  platform: "web" | "desktop";
  narrow: boolean;
  category: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  onUserUpdate: (user: User) => void;
  onMessage: (message: string) => void;
  onChangePassword: (event: FormEvent<HTMLFormElement>) => void;
  onSignOut: () => void;
  onReturnToProject?: () => void;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  appearance: AppearanceSelection;
  onAppearanceChange: (next: AppearanceSelection) => void;
};

/** The signed-in settings surface shared by the Web and desktop hosts. */
export function SettingsView({
  client,
  user,
  platform,
  narrow,
  category,
  onCategoryChange,
  onUserUpdate,
  onMessage,
  onChangePassword,
  onSignOut,
  onReturnToProject,
  isAdmin,
  onOpenAdmin,
  appearance,
  onAppearanceChange,
}: SettingsViewProps) {
  // A desktop window keeps the directory visible even at its 960px minimum width.
  const stacked = platform === "web" && narrow;
  const [mobileSection, setMobileSection] = useState(false);
  const [accountPage, setAccountPage] = useState<"account" | "password">("account");
  const [legalDocument, setLegalDocument] = useState<LegalDocumentId>(legalDocuments[0]?.id ?? "terms");
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<SettingsCategory | null>(null);
  const previousAccountPage = useRef(accountPage);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    content.scrollTop = 0;
    if (typeof content.scrollIntoView === "function") content.scrollIntoView({ block: "start" });
  }, [accountPage, category, legalDocument]);

  useEffect(() => {
    setMobileSection(false);
    setAccountPage("account");
    pendingFocus.current = null;
  }, [user?.id]);

  useEffect(() => {
    if (previousAccountPage.current === accountPage) return;
    previousAccountPage.current = accountPage;
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [accountPage]);

  useEffect(() => {
    if (!stacked || !mobileSection) return;
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [category, stacked, mobileSection]);

  useEffect(() => {
    if (!stacked || mobileSection || !pendingFocus.current) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const frame = requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLButtonElement>(`[data-category="${target}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [stacked, mobileSection]);

  function selectCategory(next: SettingsCategory) {
    setAccountPage("account");
    onCategoryChange(next);
    if (stacked) setMobileSection(true);
  }

  function backToDirectory() {
    pendingFocus.current = category;
    setMobileSection(false);
  }

  const current = CATEGORIES.find((item) => item.key === category) ?? CATEGORIES[0];
  const title = accountPage === "password" ? "修改密码" : current.label;
  const scope = accountPage === "password" ? "所有设备" : current.scope;
  const showDirectory = !stacked || !mobileSection;
  const showSection = !stacked || mobileSection;
  const selectedLegal = legalDocuments.find((document) => document.id === legalDocument) ?? legalDocuments[0];

  return (
    <section className="panel settings-panel" aria-label="设置">
      <div className="settings-layout" data-platform={platform} data-stacked={stacked ? "true" : "false"}>
        {showDirectory && (
          <nav ref={navRef} className="settings-nav" aria-label="设置分类">
            {stacked && onReturnToProject && (
              <button type="button" className="settings-nav-return" onClick={onReturnToProject}>← 返回项目</button>
            )}
            {CATEGORIES.map((item) => (
              <button
                key={item.key}
                type="button"
                data-category={item.key}
                aria-current={category === item.key ? "page" : undefined}
                onClick={() => selectCategory(item.key)}
              >
                {item.label}
              </button>
            ))}
            {isAdmin && (
              <div className="settings-admin-group">
                <button type="button" data-category="admin" onClick={onOpenAdmin}>管理控制台</button>
              </div>
            )}
          </nav>
        )}

        {showSection && (
          <div className="settings-content" ref={contentRef}>
            {accountPage === "password" ? (
              <button type="button" className="settings-back" onClick={() => setAccountPage("account")}>← 返回账户</button>
            ) : stacked ? (
              <button type="button" className="settings-back" onClick={backToDirectory}>← 返回设置</button>
            ) : null}
            <header className="settings-header">
              <div className="settings-header-text">
                <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
                {scope && <p className="settings-scope">{scope}</p>}
              </div>
              {onReturnToProject && (
                <button type="button" className="settings-return-project" onClick={onReturnToProject}>返回项目</button>
              )}
            </header>

            {category === "account" ? (
              accountPage === "password" ? (
                <form className="settings-password" onSubmit={onChangePassword}>
                  <label>当前密码<input name="current" type="password" required autoComplete="current-password" /></label>
                  <label>新密码（至少 12 位）<input name="new" type="password" required minLength={12} autoComplete="new-password" /></label>
                  <label>确认新密码<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
                  <button type="submit">更新密码</button>
                </form>
              ) : (
                <div className="settings-account">
                  {user ? (
                    <>
                      <AccountProfile key={user.id} client={client} user={user} onUpdate={onUserUpdate} onMessage={onMessage} />
                      <div className="settings-actions">
                        <button type="button" onClick={() => setAccountPage("password")}>修改密码</button>
                        <button type="button" onClick={onSignOut}>退出登录</button>
                      </div>
                    </>
                  ) : (
                    <p className="muted">正在加载账户信息…</p>
                  )}
                </div>
              )
            ) : category === "notifications" ? (
              user ? <NotificationPreferencesPanel key={user.id} client={client} user={user} /> : <p className="muted">正在加载账户信息…</p>
            ) : category === "appearance" ? (
              <div className="settings-appearance"><ThemeControl {...appearance} onChange={onAppearanceChange} /></div>
            ) : selectedLegal ? (
              <div className="legal">
                <div className="legal-tabs" role="group" aria-label="协议与许可">
                  {legalDocuments.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      aria-pressed={selectedLegal.id === entry.id}
                      onClick={() => setLegalDocument(entry.id)}
                    >
                      {entry.title}
                    </button>
                  ))}
                </div>
                <article className="legal-body" tabIndex={0}>
                  <h2>{selectedLegal.title}</h2>
                  {selectedLegal.status && <p className="legal-status">{selectedLegal.status}</p>}
                  {selectedLegal.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                </article>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
