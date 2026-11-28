import { explainError, type AuditFilters } from "@rescene/api-client";
import { Directory } from "expo-file-system";
import { useRef, useState } from "react";
import { View } from "react-native";

import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "../api";
import { Button, ErrorText, ScaledText as Text, useTextStyles } from "../ui";

export function AdminCsvExport({ params, disabled }: {
  params: AuditFilters;
  disabled?: boolean;
}) {
  const textStyles = useTextStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const pending = useRef(false);
  async function save() {
    if (pending.current) return;
    const owner = currentQueueOwner();
    if (!owner || !isQueueOwnerCurrent(owner)) {
      setError("会话已失效，请重新登录。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const text = await queueClient(owner).auditCsvText(params);
      if (!isQueueOwnerCurrent(owner)) return;
      const directory = await Directory.pickDirectoryAsync();
      if (!directory || !isQueueOwnerCurrent(owner)) return;
      const name = `rescene-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      const file = directory.createFile(name, "text/csv");
      try {
        file.write(text);
      } catch (reason) {
        try { file.delete(); } catch { /* Keep the write failure visible. */ }
        throw reason;
      }
      setNotice(`已保存为 ${file.name}`);
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) {
        const message = reason instanceof Error ? reason.message : "";
        if (/cancel|canceled|cancelled|已取消/i.test(message)) {
          // No success message for cancellation.
        } else {
          setError(explainError(reason, "保存 CSV 失败"));
        }
      }
    } finally {
      pending.current = false;
      if (isQueueOwnerCurrent(owner)) setBusy(false);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <Button
        label={busy ? "正在保存…" : "保存 CSV"}
        disabled={disabled || busy}
        tone="ghost"
        onPress={() => void save()}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <Text style={textStyles.muted}>{notice}</Text> : null}
    </View>
  );
}
