import { explainError, parseAuditLocalRange, type AuditFilters } from "@rescene/api-client";
import type { AuditEntry, AuditPage } from "@rescene/schemas";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { spacing } from "../theme";
import { useAppearance } from "../appearance";
import { Button, Card, ErrorText, Field, ScaledText as Text, useTextStyles } from "../ui";

import { AdminCsvExport } from "./AdminCsvExport";
import { AdminPage } from "./AdminPage";

const PAGE_SIZE = 20;

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
  const textStyles = useTextStyles();
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

export function AdminAuditSection() {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();

  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [projectId, setProjectId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [page, setPage] = useState(0);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [detail, setDetail] = useState<AuditEntry | null>(null);
  const [filters, setFilters] = useState<AuditFilters>({});

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
    void queueClient(owner).listAudit({ ...filters, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!active || !isQueueOwnerCurrent(owner)) return;
        setAudit(result);
        const last = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1);
        if (page > last) setPage(last);
      })
      .catch((reason) => {
        if (active && isQueueOwnerCurrent(owner)) setError(explainError(reason, "加载审计日志失败"));
      })
      .finally(() => {
        if (active && isQueueOwnerCurrent(owner)) setLoading(false);
      });
    return () => { active = false; };
  }, [filters, page, revision]);

  function applyFilters() {
    try {
      const range = parseAuditLocalRange(since, until);
      setRangeError("");
      setFilters({ actor: actor.trim(), action: action.trim(), projectId: projectId.trim(), ...range });
      setPage(0);
    } catch (reason) {
      setRangeError(reason instanceof Error ? reason.message : "时间格式不正确");
    }
  }

  function actorDisplay(entry: AuditEntry): string {
    if (entry.actor_username && entry.actor_email) return `${entry.actor_username}（${entry.actor_email}）`;
    return entry.actor_username ?? entry.actor_email ?? "系统";
  }

  const rows = audit?.items ?? [];
  const owner = currentQueueOwner();
  const locked = !owner || !isQueueOwnerCurrent(owner);

  return (
    <View style={{ gap: spacing.md }}>
      {error ? <><ErrorText>{error}</ErrorText><Button label="重试" tone="ghost" onPress={() => setRevision((value) => value + 1)} /></> : null}
      {rangeError ? <ErrorText>{rangeError}</ErrorText> : null}

      <Card>
        <Field
          label="操作者"
          value={actor}
          onChangeText={setActor}
          placeholder="按用户名或邮箱筛选"
        />
        <Field
          label="动作"
          value={action}
          onChangeText={setAction}
          placeholder="如 user. 前缀或 project.rename"
        />
        <Field
          label="项目 ID"
          value={projectId}
          onChangeText={setProjectId}
          placeholder="可选"
        />
        <Field
          label="开始时间（本地）"
          value={since}
          onChangeText={setSince}
          placeholder="YYYY-MM-DD HH:mm"
        />
        <Field
          label="结束时间（本地）"
          value={until}
          onChangeText={setUntil}
          placeholder="YYYY-MM-DD HH:mm"
        />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="筛选" disabled={locked} onPress={applyFilters} />
          </View>
          <View style={{ flex: 1 }}>
            <AdminCsvExport params={filters} disabled={locked || loading || !!error || !audit} />
          </View>
        </View>
      </Card>

      <Card>
        <Text accessibilityRole="header" style={textStyles.heading}>{audit ? `审计日志（${audit.total}）` : "审计日志"}</Text>
        {loading ? <Text style={textStyles.muted}>正在加载日志…</Text> : null}
        {!loading && audit && rows.length === 0 ? <Text style={textStyles.muted}>没有匹配的记录。</Text> : null}
        {rows.map((entry) => (
          <Pressable
            accessibilityRole="button"
            key={entry.id}
            disabled={loading || !!error}
            onPress={() => setDetail(entry)}
            style={{ minHeight: 44, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border, gap: 2 }}
          >
            <Text style={textStyles.body}>{entry.action}</Text>
            <Text style={textStyles.muted}>
              {new Date(entry.created_at).toLocaleString()} · {actorDisplay(entry)}
              {entry.project_name ? ` · ${entry.project_name}` : ""}
            </Text>
            <Text style={textStyles.muted}>{entry.target_type} · {entry.target_id}</Text>
          </Pressable>
        ))}
        {audit ? (
          <Pager page={page} total={audit.total} disabled={locked || loading || !!error} onChange={setPage} />
        ) : null}
      </Card>
      {detail ? (
        <AdminPage title="审计详情" onBack={() => setDetail(null)}>
          <Card>
            <Text style={textStyles.heading}>{detail.action}</Text>
            <Text style={textStyles.muted}>{new Date(detail.created_at).toLocaleString()} · {actorDisplay(detail)}</Text>
            <Text style={textStyles.body}>项目：{detail.project_name ?? detail.project_id ?? "平台"}</Text>
            <Text style={textStyles.body} selectable>目标 ID：{detail.target_id}</Text>
            <Text style={textStyles.muted} selectable>{Object.keys(detail.metadata).length ? JSON.stringify(detail.metadata, null, 2) : "无附加元数据。"}</Text>
          </Card>
        </AdminPage>
      ) : null}
    </View>
  );
}
