import { explainError } from "@rescene/api-client";
import { ANNOUNCEMENT_LEVEL_LABELS } from "@rescene/schemas";
import type { Announcement, AnnouncementLevel } from "@rescene/schemas";
import { newIdempotencyKey } from "@rescene/uploader";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { spacing } from "../theme";
import { useAppearance } from "../appearance";
import { Button, Card, ErrorText, Field, ScaledText as Text, Segmented, useTextStyles } from "../ui";

import { AdminConfirmSheet } from "./AdminConfirmSheet";
import { AdminPage } from "./AdminPage";

const PAGE_SIZE = 20;
const LEVELS: { value: AnnouncementLevel; label: string }[] = [
  { value: "info", label: ANNOUNCEMENT_LEVEL_LABELS.info },
  { value: "warning", label: ANNOUNCEMENT_LEVEL_LABELS.warning },
  { value: "critical", label: ANNOUNCEMENT_LEVEL_LABELS.critical },
];

function Pager({
  page,
  hasMore,
  disabled,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  const textStyles = useTextStyles();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={textStyles.muted}>第 {page + 1} 页{hasMore ? "+" : ""}</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button disabled={disabled || page <= 0} label="上一页" tone="ghost" onPress={() => onChange(page - 1)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            disabled={disabled || !hasMore}
            label="下一页"
            tone="ghost"
            onPress={() => onChange(page + 1)}
          />
        </View>
      </View>
    </View>
  );
}

export function AdminAnnouncementSection() {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<AnnouncementLevel>("info");
  const draftKey = useRef<string | null>(null);
  const mutationPending = useRef(false);
  const [compose, setCompose] = useState<"edit" | "preview" | null>(null);
  const [retracting, setRetracting] = useState<Announcement | null>(null);
  const [mutationError, setMutationError] = useState("");

  const [page, setPage] = useState(0);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const owner = currentQueueOwner();
    if (!owner) {
      setLoading(false);
      setError("会话已失效，请重新登录。");
      return;
    }
    void queueClient(owner).listAnnouncements(PAGE_SIZE, page * PAGE_SIZE)
      .then((rows) => {
        if (!active || !isQueueOwnerCurrent(owner)) return;
        if (!rows.length && page > 0) { setPage(page - 1); return; }
        setAnnouncements(rows);
        setHasMore(rows.length >= PAGE_SIZE);
      })
      .catch((reason) => {
        if (active && isQueueOwnerCurrent(owner)) setError(explainError(reason, "加载公告失败"));
      })
      .finally(() => {
        if (active && isQueueOwnerCurrent(owner)) setLoading(false);
      });
    return () => { active = false; };
  }, [page, revision]);

  async function publish() {
    const nextTitle = title.trim();
    const nextBody = body.trim();
    if (!nextTitle || !nextBody || mutationPending.current) return;
    const owner = currentQueueOwner();
    if (!owner) return;
    mutationPending.current = true;
    setWorking(true);
    draftKey.current ??= newIdempotencyKey();
    setMutationError("");
    setNotice("");
    try {
      await queueClient(owner).createAnnouncement({ title: nextTitle, body: nextBody, level }, draftKey.current);
      if (!isQueueOwnerCurrent(owner)) return;
      setTitle("");
      setBody("");
      setLevel("info");
      draftKey.current = null;
      setCompose(null);
      setRevision((value) => value + 1);
      setPage(0);
      setNotice("公告已发布。");
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setMutationError(explainError(reason, "发布公告失败"));
    } finally {
      mutationPending.current = false;
      if (isQueueOwnerCurrent(owner)) setWorking(false);
    }
  }

  async function retract(item: Announcement) {
    if (mutationPending.current) return;
    const owner = currentQueueOwner();
    if (!owner) return;
    mutationPending.current = true;
    setWorking(true);
    setMutationError("");
    setNotice("");
    try {
      await queueClient(owner).deleteAnnouncement(item.id);
      if (isQueueOwnerCurrent(owner)) {
        setRevision((value) => value + 1);
        setRetracting(null);
        setNotice(`公告「${item.title}」已撤回。站内副本已移除，已提交邮件不可追回。`);
      }
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) setMutationError(explainError(reason, "撤回公告失败"));
    } finally {
      mutationPending.current = false;
      if (isQueueOwnerCurrent(owner)) setWorking(false);
    }
  }

  const owner = currentQueueOwner();
  const locked = !owner || !isQueueOwnerCurrent(owner);

  function closeSecondary() {
    setMutationError("");
    if (retracting) setRetracting(null);
    else setCompose(compose === "preview" ? "edit" : null);
  }

  return (
    <View style={{ gap: spacing.md }}>
      <Button label="发布公告" disabled={locked || working} onPress={() => { setMutationError(""); setCompose("edit"); }} />
      {error ? <><ErrorText>{error}</ErrorText><Button label="重试" tone="ghost" onPress={() => setRevision((value) => value + 1)} /></> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={textStyles.muted}>{notice}</Text> : null}
      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>公告管理</Text>
        {loading && announcements.length === 0 ? <Text style={textStyles.muted}>正在加载公告…</Text> : null}
        {!loading && !error && announcements.length === 0 ? <Text style={textStyles.muted}>暂无公告。</Text> : null}
        {announcements.map((item) => (
          <View key={item.id} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border, gap: 4 }}>
            <Text style={textStyles.body}>{item.title}</Text>
            <Text style={textStyles.muted}>{ANNOUNCEMENT_LEVEL_LABELS[item.level]} · {new Date(item.created_at).toLocaleString()}</Text>
            {item.recipient_count != null ? <Text style={textStyles.muted}>站内：{item.read_count ?? 0}/{item.recipient_count} 已读</Text> : null}
            {item.mail_pending != null ? <Text style={textStyles.muted}>邮件：待处理 {item.mail_pending} · 已接受 {item.mail_accepted ?? 0} · 失败 {item.mail_failed ?? 0} · 未确认 {item.mail_unknown ?? 0}</Text> : null}
            <Text style={textStyles.body}>{item.body}</Text>
            <Button disabled={locked || working || loading} label="撤回公告" tone="ghost" onPress={() => { setMutationError(""); setRetracting(item); }} />
          </View>
        ))}
        {announcements.length > 0 ? <Pager page={page} hasMore={hasMore} disabled={locked || working || loading} onChange={setPage} /> : null}
      </Card>

      {retracting || compose ? (
        <AdminPage title={retracting ? "撤回公告" : compose === "preview" ? "预览公告" : "发布公告"} busy={working} onBack={closeSecondary}>
          {mutationError ? <ErrorText>{mutationError}</ErrorText> : null}
          {retracting ? (
            <AdminConfirmSheet title={retracting.title} consequences={["站内副本将移除，已经发送的邮件无法追回。"]} actionLabel="确认撤回" busy={working} destructive disabled={locked} onCancel={closeSecondary} onConfirm={() => void retract(retracting)} />
          ) : compose === "preview" ? (
            <Card>
              <Text style={textStyles.heading}>{title.trim()}</Text>
              <Text style={textStyles.muted}>{ANNOUNCEMENT_LEVEL_LABELS[level]}</Text>
              <Text style={textStyles.body}>{body.trim()}</Text>
              <Text style={textStyles.muted}>所有启用账户会收到站内通知；仅重要公告另发邮件给已验证且已订阅的账户。</Text>
              <Button disabled={locked || working} label={working ? "发布中…" : "确认发布"} onPress={() => void publish()} />
              <Button disabled={working} label="返回编辑" tone="ghost" onPress={closeSecondary} />
            </Card>
          ) : (
            <Card>
              <Field label="标题" value={title} onChangeText={(text) => { if (text.trim() !== title.trim()) draftKey.current = null; setTitle(text); }} />
              <Field label="正文" value={body} onChangeText={(text) => { if (text.trim() !== body.trim()) draftKey.current = null; setBody(text); }} multiline />
              <Segmented value={level} onChange={(value) => { if (value !== level) draftKey.current = null; setLevel(value); }} options={LEVELS} />
              <Button disabled={locked || !title.trim() || !body.trim()} label="预览公告" onPress={() => setCompose("preview")} />
            </Card>
          )}
        </AdminPage>
      ) : null}
    </View>
  );
}
