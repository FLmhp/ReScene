import { ResceneApiError } from "@rescene/api-client";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { authenticate } from "../api";
import { Button, ErrorText, Field, ScaledText as Text, Screen, useTextStyles } from "../ui";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function LoginScreen({ onSignedIn, notice, mode, onModeChange, onAppearance, active }: {
  onSignedIn: () => void;
  notice?: string;
  mode: "login" | "register";
  onModeChange: (mode: "login" | "register") => void;
  onAppearance: () => void;
  active: boolean;
}) {
  const textStyles = useTextStyles();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    setError("");
  }, [mode]);

  async function submit() {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    if (mode === "register") {
      if (!EMAIL.test(trimmed)) return setError("请输入有效的邮箱地址。");
      if (password.length < 12) return setError("密码至少 12 位。");
      if (confirm !== password) return setError("两次输入的密码不一致。");
    }
    setBusy(true);
    setError("");
    try {
      if (await authenticate(mode, trimmed, password)) onSignedIn();
    } catch (reason) {
      if (reason instanceof ResceneApiError) {
        if (reason.status === 409) setError("该邮箱已注册，请直接登录。");
        else if (reason.status === 401 || reason.status === 403) setError("邮箱或密码不正确。");
        else setError(reason.detail || (mode === "register" ? "注册失败，请稍后重试。" : "登录失败，请稍后重试。"));
      } else {
        setError(
          mode === "register"
            ? "注册失败，请检查网络连接和设备安全存储后重试。"
            : "登录失败，请检查网络连接和设备安全存储后重试。",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!active) return null;

  return (
    <Screen
      scroll
      title={mode === "register" ? "注册" : "登录"}
      navigation={<View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingBottom: 12 }}>
        <Button label="外观" tone="ghost" onPress={onAppearance} />
      </View>}
    >
      <View style={{ width: "100%", maxWidth: 420, alignSelf: "center", gap: 16 }}>
        {notice ? (
          <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={textStyles.muted}>
            {notice}
          </Text>
        ) : null}
        <Field
          autoComplete="email"
          keyboardType="email-address"
          label="团队邮箱"
          onChangeText={setEmail}
          returnKeyType="next"
          textContentType="username"
          value={email}
        />
        <Field
          key={mode}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          label={mode === "login" ? "密码" : "密码（至少 12 位）"}
          onChangeText={setPassword}
          onSubmitEditing={() => void submit()}
          returnKeyType="go"
          secureTextEntry
          textContentType={mode === "login" ? "password" : "newPassword"}
          value={password}
        />
        {mode === "register" ? (
          <Field
            autoComplete="new-password"
            label="确认密码"
            onChangeText={setConfirm}
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
            secureTextEntry
            textContentType="newPassword"
            value={confirm}
          />
        ) : null}
        <Button
          accessibilityLabel={mode === "register" ? "创建账号" : "登录"}
          disabled={busy || !email.trim() || !password || (mode === "register" && !confirm)}
          label={busy ? (mode === "register" ? "正在创建…" : "正在登录…") : mode === "register" ? "创建账号" : "登录"}
          onPress={() => void submit()}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button label={mode === "login" ? "注册账号" : "返回登录"} tone="ghost" disabled={busy}
          onPress={() => {
            setPassword("");
            setConfirm("");
            setError("");
            onModeChange(mode === "login" ? "register" : "login");
          }} />
      </View>
    </Screen>
  );
}
