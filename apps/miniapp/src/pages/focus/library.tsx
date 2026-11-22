import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import type { AppNotification, User } from "@rescene/schemas";
import { newIdempotencyKey, QUEUE_PAUSED } from "@rescene/uploader";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useCallback, useRef, useState } from "react";
import { changeSessionPassword, client, currentQueueOwner, isQueueOwnerCurrent, queueClient, signOutSession } from "../../api";
import { openHome, setLogoutNotice } from "../../navigation";
import { enqueue } from "../../queue";

function errorText(reason: unknown, fallback: string) { return reason instanceof ResceneApiError ? explainError(reason, reason.detail || fallback) : reason instanceof Error ? reason.message : fallback; }
function open(view: string) { void Taro.navigateTo({ url: `/pages/focus/index?view=${view}` }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" })); }

export function LibraryFocus({ view }: { view: string }) {
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [name, setName] = useState(""); const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<User | null>(null); const [items, setItems] = useState<AppNotification[]>([]);
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [confirm, setConfirm] = useState("");
  const lock = useRef(false); const attempt = useRef<{ name: string; key: string } | null>(null);
  const notify = (message: string, clearSearch: boolean) => { try { Taro.getCurrentInstance().page?.getOpenerEventChannel?.()?.emit("library-change", { notice: message, clearSearch }); } catch { /* The list refreshes on show even without the channel. */ } void Taro.navigateBack().catch(() => openHome()); };
  const load = useCallback(async () => {
    const owner = currentQueueOwner(); if (!owner) return;
    try {
      if (view === "notifications") { const rows = await queueClient(owner).listNotifications(true, 5); if (isQueueOwnerCurrent(owner)) setItems(rows); }
      else if (view === "settings" || view === "account") { const me = await queueClient(owner).getMe(); if (isQueueOwnerCurrent(owner)) setUser(me); }
      setError("");
    } catch (reason) { if (isQueueOwnerCurrent(owner)) setError(errorText(reason, "加载失败，请重试。")); }
  }, [view]);
  useDidShow(() => { void load(); });
  async function create() {
    const trimmed = name.trim(); if (!trimmed || lock.current) return;
    if (trimmed.length > 200) { setError("项目名称最多 200 个字符。"); return; }
    const owner = currentQueueOwner(); if (!owner) { setError(QUEUE_PAUSED); return; }
    const pending = attempt.current?.name === trimmed ? attempt.current : { name: trimmed, key: newIdempotencyKey() }; attempt.current = pending;
    lock.current = true; setBusy(true); setError("");
    try { await queueClient(owner).createProject(trimmed, pending.key); if (!isQueueOwnerCurrent(owner)) return; attempt.current = null; notify("项目已创建。", false); }
    catch (reason) {
      if (!isQueueOwnerCurrent(owner)) return;
      if (isOfflineError(reason)) {
        try { await enqueue(owner, { kind: "project", id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: trimmed, createdAt: Date.now(), idempotencyKey: pending.key }); if (isQueueOwnerCurrent(owner)) { attempt.current = null; notify("已离线保存，联网后自动创建。", false); } }
        catch { if (isQueueOwnerCurrent(owner)) setError("保存到本地队列失败。"); }
      } else setError(errorText(reason, "创建项目失败。"));
    } finally { lock.current = false; setBusy(false); }
  }
  async function claim() {
    const owner = currentQueueOwner(); if (!owner || !code.trim() || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await queueClient(owner).acceptInvitation(code.trim()); if (isQueueOwnerCurrent(owner)) notify("已领取邀请。", true); }
    catch (reason) { if (isQueueOwnerCurrent(owner)) setError(errorText(reason, "领取邀请失败。")); }
    finally { lock.current = false; setBusy(false); }
  }
  async function password() {
    if (lock.current) return; if (next.length < 12) { setError("新密码至少 12 位。"); return; } if (next !== confirm) { setError("两次输入的新密码不一致。"); return; }
    lock.current = true; setBusy(true); setError("");
    try { if (await changeSessionPassword(current, next)) { setCurrent(""); setNext(""); setConfirm(""); setNotice("密码已更新，其他设备已退出登录。"); } }
    catch (reason) { setError(errorText(reason, "更新密码失败。")); } finally { lock.current = false; setBusy(false); }
  }
  async function logout() { if (lock.current) return; lock.current = true; setBusy(true); const revoked = await signOutSession(); setLogoutNotice(revoked ? "已退出登录。" : "本机已退出，但服务器无法确认会话已撤销。请检查网络并联系管理员撤销会话。"); await openHome(); }
  async function mark(ids?: string[]) { try { await client.markNotificationsRead(ids); await load(); } catch (reason) { setError(errorText(reason, "标记已读失败。")); } }
  async function openItem(item: AppNotification) { await mark([item.id]); if (item.project_id) void Taro.navigateTo({ url: `/pages/project/index?id=${encodeURIComponent(item.project_id)}${item.job_id ? `&view=tasks&job=${encodeURIComponent(item.job_id)}` : ""}` }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" })); }
  return <>
    {view === "new-project" ? <View className="card"><Text className="label">项目名称</Text><Input className="input" maxlength={200} value={name} onInput={(e) => setName(e.detail.value)} /><Button className="button" disabled={busy || !name.trim()} loading={busy} onClick={() => void create()}>创建项目</Button></View> : null}
    {view === "claim-invite" ? <View className="card"><Text className="label">领取码</Text><Input className="input" maxlength={128} value={code} onInput={(e) => setCode(e.detail.value)} /><Button className="button" disabled={busy || !code.trim()} loading={busy} onClick={() => void claim()}>领取邀请</Button></View> : null}
    {view === "notifications" ? <><View className="row"><Text className="section-heading">未读通知</Text><Button className="button ghost compact" disabled={!items.length} onClick={() => void mark()}>全部已读</Button></View>{items.length ? items.map((item) => <View className="project-tile" key={item.id} onClick={() => void openItem(item)}><Text className="label">{item.title}</Text><Text className="muted">{item.created_at}</Text></View>) : <Text className="muted">暂无通知。</Text>}</> : null}
    {view === "settings" ? <View className="card"><Button className="button ghost" onClick={() => open("appearance")}>外观</Button><Button className="button ghost" onClick={() => open("account")}>账户</Button>{user?.is_admin ? <Button className="button ghost" onClick={() => void Taro.navigateTo({ url: "/pages/admin/index" }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }))}>管理控制台</Button> : null}</View> : null}
    {view === "account" ? <View className="card">{user ? <Text>{user.email}</Text> : null}<Button className="button ghost" onClick={() => open("password")}>修改密码</Button><Button className="button ghost" disabled={busy} loading={busy} onClick={() => void logout()}>退出登录</Button></View> : null}
    {view === "password" ? <View className="card"><Text className="label">当前密码</Text><Input className="input" password value={current} onInput={(e) => setCurrent(e.detail.value)} /><Text className="label">新密码（至少 12 位）</Text><Input className="input" password value={next} onInput={(e) => setNext(e.detail.value)} /><Text className="label">确认新密码</Text><Input className="input" password value={confirm} onInput={(e) => setConfirm(e.detail.value)} /><Button className="button" disabled={busy || !current || !next || !confirm} loading={busy} onClick={() => void password()}>更新密码</Button></View> : null}
    {error ? <View className="card"><Text className="error">{error}</Text>{view === "settings" || view === "account" || view === "notifications" ? <Button className="button ghost" onClick={() => void load()}>重试</Button> : null}</View> : null}{notice ? <Text>{notice}</Text> : null}
  </>;
}
