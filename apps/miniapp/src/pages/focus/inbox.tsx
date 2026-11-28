import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import { ANNOUNCEMENT_LEVEL_LABELS, NOTIFICATION_KIND_LABELS, type AppNotification, type NotificationKind } from "@rescene/schemas";
import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../../api";

function errorText(reason: unknown, fallback: string) {
  if (reason instanceof ResceneApiError) return explainError(reason, reason.detail || fallback);
  if (reason instanceof Error) return reason.message;
  return fallback;
}

const LIMIT = 20;
const KINDS: [NotificationKind | "", string][] = [
  ["", "所有类型"],
  ["announcement", "公告"],
  ["job.succeeded", "任务成功"],
  ["job.failed", "任务失败"],
];

function metaText(item: AppNotification): string {
  if (item.kind === "announcement" && item.announcement_level) {
    return `公告 · ${ANNOUNCEMENT_LEVEL_LABELS[item.announcement_level]}`;
  }
  return NOTIFICATION_KIND_LABELS[item.kind as NotificationKind] ?? item.kind;
}

export function NotificationInbox() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState<NotificationKind | "">("");
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [detail, setDetail] = useState<AppNotification | null>(null);
  const requestId = useRef(0);
  const hidden = useRef(false);
  const markingLock = useRef(false);

  const refresh = useCallback(async (offset = 0) => {
    const owner = currentQueueOwner();
    if (!owner || hidden.current) return;
    const id = ++requestId.current;
    const current = () => !hidden.current && isQueueOwnerCurrent(owner) && requestId.current === id;
    setLoading(true);
    setError("");
    try {
      const api = queueClient(owner);
      const [rows, count] = await Promise.all([
        api.listNotifications(unreadOnly, LIMIT, offset, kind || undefined),
        api.notificationCount().catch(() => undefined),
      ]);
      if (!current()) return;
      setItems((previous) => offset ? [...previous, ...rows.filter((item) => !previous.some((row) => row.id === item.id))] : rows);
      setNextOffset(rows.length === LIMIT ? offset + LIMIT : null);
      if (count !== undefined) setUnread(count);
    } catch (reason) {
      if (current()) setError(errorText(reason, isOfflineError(reason) ? "网络不可用，请联网后重试。" : "加载通知失败，请重试。"));
    } finally {
      if (current()) setLoading(false);
    }
  }, [unreadOnly, kind]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { requestId.current += 1; }, []);
  useDidShow(() => {
    if (!hidden.current) return;
    hidden.current = false;
    void latestRefresh.current();
  });
  useDidHide(() => {
    hidden.current = true;
    requestId.current += 1;
  });

  function selectFilters(unread: boolean, nextKind: NotificationKind | "") {
    if (unread === unreadOnly && nextKind === kind) return;
    requestId.current += 1;
    setItems([]);
    setError("");
    setLoading(true);
    setNextOffset(null);
    setUnreadOnly(unread);
    setKind(nextKind);
  }

  async function mark(id?: string) {
    const owner = currentQueueOwner();
    if (!owner || hidden.current || markingLock.current) return;
    markingLock.current = true;
    setMarking(true);
    setError("");
    try {
      await queueClient(owner).markNotificationsRead(id ? [id] : undefined);
      if (hidden.current || !isQueueOwnerCurrent(owner)) return;
      setDetail((item) => item && (!id || item.id === id) ? { ...item, read_at: new Date().toISOString() } : item);
      await latestRefresh.current();
    } catch (reason) {
      if (!hidden.current && isQueueOwnerCurrent(owner)) setError(errorText(reason, "标记已读失败，请重试。"));
    } finally {
      markingLock.current = false;
      if (isQueueOwnerCurrent(owner)) setMarking(false);
    }
  }

  const openDetail = useCallback((item: AppNotification) => {
    if (hidden.current || !currentQueueOwner()) return;
    setError("");
    setDetail(item);
  }, []);

  const viewTask = useCallback((item: AppNotification) => {
    if (hidden.current || !currentQueueOwner()) return;
    if (item.project_id) {
      const url = `/pages/project/index?id=${encodeURIComponent(item.project_id)}${item.job_id ? `&view=tasks&job=${encodeURIComponent(item.job_id)}` : ""}`;
      void Taro.navigateTo({ url }).catch(() => Taro.showToast({ title: "无法打开页面，请重试", icon: "none" }));
    }
  }, []);

  if (detail) {
    return (
      <DetailView
        item={detail}
        marking={marking}
        error={error}
        onBack={() => { setError(""); setDetail(null); }}
        onMark={() => void mark(detail.id)}
        onViewTask={() => void viewTask(detail)}
      />
    );
  }

  return (
    <>
      <View className="row">
        <Text className="section-heading">通知{unread > 0 ? `（${unread}）` : ""}</Text>
        <Button
          className="button ghost compact"
          disabled={marking || unread === 0}
          loading={marking}
          onClick={() => void mark()}
        >
          标记所有可见未读
        </Button>
      </View>
      <View className="row" style={{ flexWrap: "wrap" }}>
        <Button className={!unreadOnly ? "button compact" : "button ghost compact"} onClick={() => selectFilters(false, kind)}>
          全部
        </Button>
        <Button className={unreadOnly ? "button compact" : "button ghost compact"} onClick={() => selectFilters(true, kind)}>
          未读
        </Button>
      </View>
      <View className="row" style={{ flexWrap: "wrap" }}>
        {KINDS.map(([k, label]) => (
          <Button
            key={k || "all"}
            className={kind === k ? "button compact" : "button ghost compact"}
            onClick={() => selectFilters(unreadOnly, k)}
          >
            {label}
          </Button>
        ))}
      </View>
      {error ? (
        <View className="card">
          <Text className="error">{error}</Text>
          <Button className="button ghost" onClick={() => void refresh()}>
            重试
          </Button>
        </View>
      ) : null}
      {items.length === 0 && !loading && !error ? <Text className="muted">暂无通知。</Text> : null}
      {items.map((item) => (
        <View className="project-tile" key={item.id} onClick={() => void openDetail(item)}>
          <View className="row">
            <Text className="label">{item.title}</Text>
            {!item.read_at ? <Text className="muted">未读</Text> : null}
          </View>
          <Text className="muted">{metaText(item)}</Text>
          <Text className="muted">{item.created_at}</Text>
        </View>
      ))}
      {nextOffset !== null && !loading && !marking ? (
        <Button className="button ghost" onClick={() => void refresh(nextOffset)}>
          加载更多
        </Button>
      ) : null}
      {loading ? <Text className="muted">加载中…</Text> : null}
    </>
  );
}

function DetailView({
  item,
  marking,
  error,
  onBack,
  onMark,
  onViewTask,
}: {
  item: AppNotification;
  marking: boolean;
  error: string;
  onBack: () => void;
  onMark: () => void;
  onViewTask: () => void;
}) {
  return (
    <View className="card">
      <Button className="button ghost compact" onClick={onBack}>
        返回列表
      </Button>
      <Text className="label">{item.title}</Text>
      <Text className="muted">{metaText(item)}</Text>
      <Text>{item.body || ""}</Text>
      <Text className="muted">{item.created_at}</Text>
      {error ? <Text className="error">{error}</Text> : null}
      {!item.read_at ? (
        <Button className="button" loading={marking} onClick={onMark}>
          标记已读
        </Button>
      ) : null}
      {item.project_id ? (
        <Button className="button ghost" onClick={onViewTask}>
          {item.job_id ? "查看任务" : "打开项目"}
        </Button>
      ) : null}
    </View>
  );
}
