import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { newIdempotencyKey, QUEUE_PAUSED } from "@rescene/uploader";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useRef, useState } from "react";
import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../../api";
import { openHome } from "../../navigation";
import { enqueue } from "../../queue";
import { NotificationInbox } from "./inbox";

function errorText(reason: unknown, fallback: string) { return reason instanceof ResceneApiError ? explainError(reason, reason.detail || fallback) : reason instanceof Error ? reason.message : fallback; }

export function LibraryFocus({ view }: { view: string }) {
  const [error, setError] = useState("");
  const [name, setName] = useState(""); const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  const lock = useRef(false); const attempt = useRef<{ name: string; key: string } | null>(null);
  const notify = (message: string, clearSearch: boolean) => { try { Taro.getCurrentInstance().page?.getOpenerEventChannel?.()?.emit("library-change", { notice: message, clearSearch }); } catch { /* The list refreshes on show even without the channel. */ } void Taro.navigateBack().catch(() => openHome()); };
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
  return <>
    {view === "new-project" ? <View className="card"><Text className="label">项目名称</Text><Input className="input" maxlength={200} value={name} onInput={(e) => setName(e.detail.value)} /><Button className="button" disabled={busy || !name.trim()} loading={busy} onClick={() => void create()}>创建项目</Button></View> : null}
    {view === "claim-invite" ? <View className="card"><Text className="label">领取码</Text><Input className="input" maxlength={128} value={code} onInput={(e) => setCode(e.detail.value)} /><Button className="button" disabled={busy || !code.trim()} loading={busy} onClick={() => void claim()}>领取邀请</Button></View> : null}
    {view === "notifications" ? <NotificationInbox /> : null}
    {error ? <View className="card"><Text className="error">{error}</Text></View> : null}
  </>;
}
