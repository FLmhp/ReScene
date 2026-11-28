import { explainError, type ResceneClient } from "@rescene/api-client";
import { MAX_AVATAR_BYTES, type User } from "@rescene/schemas";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, View } from "react-native";

import { currentQueueOwner, isQueueOwnerCurrent, queueClient } from "./api";
import { Avatar } from "./Avatar";
import { Button, Card, ErrorText, Field, ScaledText as Text, useTextStyles } from "./ui";

type Preview = { base64: string; mimeType: string };
type Action = "picker" | "username" | "save" | "remove";

export function AccountProfile({ user, onChangeUser, onChangePassword, onSignOut }: {
  user: User;
  onChangeUser: (user: User) => void;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const styles = useTextStyles();
  const [username, setUsername] = useState(user.username ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    setPreview(null);
    return () => { active.current = false; };
  }, [user.id]);
  useEffect(() => { setUsername(user.username ?? ""); }, [user.username]);

  async function run(action: Action, work: (client: ResceneClient, current: () => boolean) => Promise<void>, fallback: string) {
    const owner = currentQueueOwner();
    if (!active.current || pending.current || !owner || owner.id !== user.id) return;
    const current = () => active.current && isQueueOwnerCurrent(owner);
    pending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await work(queueClient(owner), current);
    } catch (reason) {
      if (current()) setError(explainError(reason, reason instanceof Error ? reason.message : fallback));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  function pickAvatar() {
    void run("picker", async (_client, current) => {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/jpeg", "image/png", "image/webp"], copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const file = new File(asset.uri);
      try {
        if (!current()) return;
        if (!file.exists) throw new Error("无法读取所选图片，请重试。");
        if ((asset.size ?? 0) > MAX_AVATAR_BYTES || file.size > MAX_AVATAR_BYTES) {
          throw new Error("图片超过 1 MiB，请选择更小的图片。");
        }
        const base64 = await file.base64();
        if (current()) setPreview({ base64, mimeType: asset.mimeType ?? "image/jpeg" });
      } finally {
        if (file.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
      }
    }, "读取图片失败，请重试。");
  }

  function saveUsername() {
    const nextName = username.trim();
    if (!nextName || nextName === user.username) return;
    void run("username", async (client, current) => {
      const updated = await client.updateProfile({ username: nextName });
      if (current() && updated.id === user.id) {
        onChangeUser(updated);
        setNotice("用户名已保存。");
      }
    }, "保存用户名失败，请重试。");
  }

  function changeAvatar(action: "save" | "remove") {
    const image = preview?.base64;
    if (action === "save" && !image) return;
    void run(action, async (client, current) => {
      const updated = image && action === "save" ? await client.setAvatar(image) : await client.removeAvatar();
      if (current() && updated.id === user.id) {
        setPreview(null);
        onChangeUser(updated);
        setNotice(action === "save" ? "头像已保存。" : "头像已移除。");
      }
    }, action === "save" ? "保存头像失败，请重试。" : "移除头像失败，请重试。");
  }

  return (
    <Card style={{ width: "100%", maxWidth: 560, alignSelf: "center" }}>
      {preview ? (
        <View style={{ gap: 6 }}>
          <Image
            accessibilityLabel="头像预览"
            source={{ uri: `data:${preview.mimeType};base64,${preview.base64}` }}
            resizeMode="cover"
            style={{ width: 96, height: 96, borderRadius: 12 }}
          />
          <Text style={styles.muted}>点击「保存头像」后生效。</Text>
        </View>
      ) : <Avatar user={user} size={96} />}
      <Text style={styles.muted}>请选择不超过 1 MiB 的单帧 JPEG、PNG 或 WebP 图片。</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Button label={busy === "picker" ? "正在读取…" : "选择头像"} onPress={pickAvatar} disabled={busy !== null} />
        {preview ? (
          <>
            <Button label="保存头像" onPress={() => changeAvatar("save")} disabled={busy !== null} />
            <Button label="取消预览" tone="ghost" onPress={() => setPreview(null)} disabled={busy !== null} />
          </>
        ) : user.avatar_revision ? (
          <Button label="移除头像" tone="ghost" disabled={busy !== null} onPress={() => Alert.alert(
            "移除头像", "移除后将显示用户名或邮箱的首字符。", [
              { text: "取消", style: "cancel" },
              { text: "移除头像", style: "destructive", onPress: () => changeAvatar("remove") },
            ],
          )} />
        ) : null}
      </View>
      <Field label="用户名" value={username} onChangeText={setUsername} onSubmitEditing={saveUsername} returnKeyType="done" />
      <Text style={styles.muted}>3–32 个汉字、英文字母、数字、下划线或连字符。</Text>
      <Button label="保存用户名" onPress={saveUsername} disabled={busy !== null || !username.trim() || username.trim() === user.username} />
      <Text style={styles.muted}>邮箱（只读）</Text>
      <Text style={styles.body}>{user.email}</Text>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text> : null}
      <Button label="修改密码" onPress={onChangePassword} disabled={busy !== null} />
      <Button label="退出登录" onPress={onSignOut} tone="ghost" disabled={busy !== null} />
    </Card>
  );
}
