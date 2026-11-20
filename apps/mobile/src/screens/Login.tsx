import { ResceneApiError } from "@rescene/api-client";
import { useState } from "react";
import { Text } from "react-native";

import { authenticate } from "../api";
import { Button, Card, ErrorText, Field, Screen, Segmented, useTextStyles } from "../ui";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function LoginScreen({ onSignedIn, notice }: { onSignedIn: () => void; notice?: string }) {
  const textStyles = useTextStyles();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <Screen scroll title={mode === "register" ? "创建 ReScene 账号" : "登录团队工作台"}>
      <Card>
        {notice ? (
          <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={textStyles.muted}>
            {notice}
          </Text>
        ) : null}
        <Segmented
          value={mode}
          onChange={(next) => {
            setMode(next);
            setError("");
          }}
          options={[
            { value: "login", label: "登录" },
            { value: "register", label: "注册" },
          ]}
        />
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
          disabled={busy || !email.trim() || !password || (mode === "register" && !confirm)}
          label={busy ? (mode === "register" ? "创建中…" : "登录中…") : mode === "register" ? "创建账号" : "登录"}
          onPress={() => void submit()}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
      </Card>
      <Text style={textStyles.muted}>首次使用请先注册；密码至少 12 位，仅支持邮箱密码登录。</Text>
    </Screen>
  );
}
