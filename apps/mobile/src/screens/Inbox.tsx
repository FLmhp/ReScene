import { explainError } from "@rescene/api-client";
import {
  ANNOUNCEMENT_LEVEL_LABELS,
  NOTIFICATION_KIND_LABELS,
} from "@rescene/schemas";
import type { AppNotification, NotificationKind, ProjectSummary } from "@rescene/schemas";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { useAppearance } from "../appearance";
import { Button, ErrorText, ScaledText as Text, Segmented, useTextStyles } from "../ui";

const PAGE_SIZE = 20;

const READ_FILTERS = [
  { value: "all" as const, label: "全部" },
  { value: "unread" as const, label: "未读" },
] as const;

type ReadFilter = (typeof READ_FILTERS)[number]["value"];

const KIND_FILTERS = [
  { value: "all" as const, label: "所有类型" },
  { value: "announcement" as const, label: NOTIFICATION_KIND_LABELS.announcement },
  { value: "job.succeeded" as const, label: NOTIFICATION_KIND_LABELS["job.succeeded"] },
  { value: "job.failed" as const, label: NOTIFICATION_KIND_LABELS["job.failed"] },
] as const;

type KindFilter = (typeof KIND_FILTERS)[number]["value"];

export function Inbox({
  projects,
  onJob,
  onOpen,
  onUnreadChange,
}: {
  projects: ProjectSummary[];
  onJob?: (jobId: string) => void;
  onOpen: (project: { id: string; name: string }) => void;
  onUnreadChange?: (count: number) => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();

  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [detail, setDetail] = useState<AppNotification | null>(null);

  const generationRef = useRef(0);
  const visible = useRef(true);
  const markingLock = useRef(false);

  const ownerSnapshot = currentQueueOwner();
  const ownerKey = ownerSnapshot ? `${ownerSnapshot.id}:${ownerSnapshot.generation}` : null;
  const kind: NotificationKind | undefined = kindFilter === "all" ? undefined : kindFilter;

  const load = useCallback(async (offset = 0) => {
    const owner = currentQueueOwner();
    if (!owner || !visible.current) return;
    const generation = ++generationRef.current;
    const current = () => visible.current && isQueueOwnerCurrent(owner) && generationRef.current === generation;
    setLoading(true);
    setError("");
    try {
      const api = queueClient(owner);
      const [list, count] = await Promise.all([
        api.listNotifications(readFilter === "unread", PAGE_SIZE, offset, kind),
        api.notificationCount().catch(() => undefined),
      ]);
      if (!current()) return;
      setItems((previous) => offset ? [...previous, ...list.filter((item) => !previous.some((row) => row.id === item.id))] : list);
      setNextOffset(list.length === PAGE_SIZE ? offset + PAGE_SIZE : null);
      if (count !== undefined) {
        setUnread(count);
        onUnreadChange?.(count);
      }
    } catch (reason) {
      if (current()) setError(explainError(reason, "加载通知失败"));
    } finally {
      if (current()) setLoading(false);
    }
  }, [readFilter, kind, onUnreadChange]);
  const latestLoad = useRef(load);
  latestLoad.current = load;

  useEffect(() => {
    setItems([]);
    setDetail(null);
    setUnread(0);
    setNextOffset(null);
    setMarking(false);
    if (!ownerKey) onUnreadChange?.(0);
  }, [ownerKey, onUnreadChange]);
  useEffect(() => { void load(); }, [load, ownerKey]);
  useEffect(() => {
    visible.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        visible.current = true;
        void latestLoad.current();
      } else if (state === "background") {
        visible.current = false;
        generationRef.current += 1;
      }
    });
    return () => {
      visible.current = false;
      generationRef.current += 1;
      subscription.remove();
    };
  }, []);

  function selectFilters(read: ReadFilter, nextKind: KindFilter) {
    if (read === readFilter && nextKind === kindFilter) return;
    generationRef.current += 1;
    setItems([]);
    setError("");
    setLoading(true);
    setNextOffset(null);
    setReadFilter(read);
    setKindFilter(nextKind);
  }

  async function mark(id?: string) {
    const owner = currentQueueOwner();
    if (!owner || !visible.current || markingLock.current) return;
    markingLock.current = true;
    setMarking(true);
    setError("");
    try {
      await queueClient(owner).markNotificationsRead(id ? [id] : undefined);
      if (!visible.current || !isQueueOwnerCurrent(owner)) return;
      setDetail((item) => item && (!id || item.id === id) ? { ...item, read_at: new Date().toISOString() } : item);
      await latestLoad.current();
    } catch (reason) {
      if (visible.current && isQueueOwnerCurrent(owner)) setError(explainError(reason, "标记已读失败"));
    } finally {
      markingLock.current = false;
      if (isQueueOwnerCurrent(owner)) setMarking(false);
    }
  }

  function openDetail(item: AppNotification) {
    if (!ownerSnapshot || !isQueueOwnerCurrent(ownerSnapshot) || !visible.current) return;
    setError("");
    setDetail(item);
  }

  function goJob() {
    if (!detail?.job_id || !ownerSnapshot || !isQueueOwnerCurrent(ownerSnapshot) || !visible.current) return;
    onJob?.(detail.job_id);
  }

  function goProject() {
    if (!detail?.project_id || !ownerSnapshot || !isQueueOwnerCurrent(ownerSnapshot) || !visible.current) return;
    const known = projects.find((project) => project.id === detail.project_id);
    onOpen({ id: detail.project_id, name: known?.name ?? "" });
  }

  if (detail) {
    const levelLabel = detail.announcement_level
      ? ` · ${ANNOUNCEMENT_LEVEL_LABELS[detail.announcement_level]}`
      : "";
    return (
      <View style={{ gap: 12 }}>
        <Button label="返回通知列表" tone="ghost" onPress={() => { setError(""); setDetail(null); }} />
        <View
          style={{
            padding: 16,
            borderRadius: 12,
            backgroundColor: theme.panel,
            borderWidth: 1,
            borderColor: detail.read_at ? theme.borderSoft : theme.accent,
            gap: 10,
          }}
        >
          <Text style={textStyles.body}>
            {detail.read_at ? "" : "未读 · "}
            {NOTIFICATION_KIND_LABELS[detail.kind as NotificationKind] ?? detail.kind}
            {levelLabel}
          </Text>
          <Text style={textStyles.heading}>{detail.title}</Text>
          {detail.body ? <Text style={textStyles.body}>{detail.body}</Text> : null}
          <Text style={[textStyles.muted, textStyles.numeric]}>
            {new Date(detail.created_at).toLocaleString()}
          </Text>
        </View>

        {error ? <ErrorText>{error}</ErrorText> : null}
        {!detail.read_at ? <Button label="标记已读" disabled={marking} onPress={() => void mark(detail.id)} /> : null}

        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {detail.job_id && onJob ? <Button label="查看任务" onPress={goJob} /> : null}
          {detail.project_id ? <Button label="打开项目" tone="ghost" onPress={goProject} /> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Segmented<ReadFilter>
          value={readFilter}
          onChange={(value) => selectFilters(value, kindFilter)}
          options={READ_FILTERS}
        />
        <Segmented<KindFilter>
          value={kindFilter}
          onChange={(value) => selectFilters(readFilter, value)}
          options={KIND_FILTERS}
        />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Text style={textStyles.muted}>{unread > 0 ? `${unread} 条未读` : "暂无未读通知"}</Text>
        <Button
          label="标记所有可见未读"
          tone="ghost"
          disabled={loading || marking || unread === 0}
          onPress={() => void mark()}
        />
      </View>

      {loading && items.length > 0 ? (
        <Text accessibilityLiveRegion="polite" style={textStyles.muted}>
          正在刷新…
        </Text>
      ) : null}

      {error ? (
        <View style={{ gap: 8 }}>
          <ErrorText>{error}</ErrorText>
          <Button label="重试" tone="ghost" onPress={() => void load()} />
        </View>
      ) : null}

      {!error && !loading && items.length === 0 ? <Text style={textStyles.muted}>暂无通知。</Text> : null}

      {items.map((item) => {
        const unreadBadge = !item.read_at ? "未读 · " : "";
        const levelLabel = item.announcement_level
          ? ` · ${ANNOUNCEMENT_LEVEL_LABELS[item.announcement_level]}`
          : "";
        return (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${unreadBadge}${
              NOTIFICATION_KIND_LABELS[item.kind as NotificationKind] ?? item.kind
            } · ${item.title}`}
            onPress={() => openDetail(item)}
            style={{
              padding: 12,
              borderRadius: 12,
              backgroundColor: theme.panel,
              borderWidth: 1,
              borderColor: item.read_at ? theme.borderSoft : theme.accent,
              gap: 6,
              minHeight: 44,
            }}
          >
            <Text style={textStyles.body}>
              {unreadBadge}
              {NOTIFICATION_KIND_LABELS[item.kind as NotificationKind] ?? item.kind}
              {levelLabel}
            </Text>
            <Text style={textStyles.heading}>{item.title}</Text>
            {item.body ? (
              <Text numberOfLines={2} style={textStyles.muted}>
                {item.body}
              </Text>
            ) : null}
            <Text style={[textStyles.muted, textStyles.numeric]}>
              {new Date(item.created_at).toLocaleString()}
            </Text>
          </Pressable>
        );
      })}

      {loading && items.length === 0 ? (
        <Text accessibilityLiveRegion="polite" style={textStyles.muted}>
          正在加载通知…
        </Text>
      ) : null}

      {!loading && !marking && !error && nextOffset !== null ? (
        <Button label="加载更多" tone="ghost" onPress={() => void load(nextOffset)} />
      ) : null}
    </View>
  );
}
