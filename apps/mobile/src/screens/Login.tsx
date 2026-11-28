import { ResceneApiError } from "@rescene/api-client";
import { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";

import { authenticate, authenticateWithCode, resetPasswordWithCode, sendEmailCode } from "../api";
import { useAppearance } from "../appearance";
import { Button, ErrorText, Field, ScaledText as Text, Screen, useTextStyles } from "../ui";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE = /^\d{6}$/;
const RESEND_SECONDS = 60;

export type AuthMode = "login" | "code" | "reset" | "register";

const TITLES: Record<AuthMode, string> = {
  login: "登录",
  code: "验证码登录",
  reset: "重置密码",
  register: "注册",
};

function authFailure(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) {
    if (reason.code === "auth.invalid_code" || reason.status === 401) return "验证码无效或已过期，请重新获取。";
    if (reason.code === "auth.rate_limited" || reason.status === 429) return "操作过于频繁，请稍后再试。";
    return reason.detail || fallback;
  }
  return fallback;
}

function TextAction({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { theme } = useAppearance();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}
    >
      <Text style={{ color: disabled ? theme.muted : theme.accent, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function LoginScreen({ onSignedIn, notice, mode, onModeChange }: {
  onSignedIn: () => void;
  notice?: string;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    setPassword("");
    setCode("");
    setConfirm("");
    setError("");
    setHint("");
    setCooldown(0);
  }, [mode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function changeMode(next: AuthMode) {
    setPassword("");
    setCode("");
    setConfirm("");
    setError("");
    setHint("");
    setCooldown(0);
    onModeChange(next);
  }

  async function sendCode() {
    if (busy || sending || cooldown > 0) return;
    const trimmed = email.trim();
    if (!EMAIL.test(trimmed)) return setError("请输入有效的邮箱地址。");
    setSending(true);
    setError("");
    setHint("");
    try {
      await sendEmailCode(trimmed, mode === "reset" ? "reset" : "login");
      setCooldown(RESEND_SECONDS);
      setHint("验证码已发送，请检查邮箱");
    } catch (reason) {
      setError(authFailure(reason, "验证码发送失败，请稍后重试。"));
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    if (busy || sending) return;
    const trimmed = (mode === "login" ? identifier : email).trim();
    if (mode === "login") {
      if (!trimmed) return setError("请输入邮箱或用户名。");
      if (!password) return setError("请输入密码。");
    } else if (!EMAIL.test(trimmed)) {
      return setError("请输入有效的邮箱地址。");
    }
    if ((mode === "code" || mode === "reset") && !CODE.test(code)) return setError("请输入 6 位验证码。");
    if (mode === "register" || mode === "reset") {
      if (password.length < 12) return setError("密码至少 12 位。");
      if (confirm !== password) return setError("两次输入的密码不一致。");
    }
    setBusy(true);
    setError("");
    setHint("");
    try {
      let signedIn: boolean;
      if (mode === "code") {
        signedIn = await authenticateWithCode(trimmed, code);
      } else if (mode === "reset") {
        signedIn = await resetPasswordWithCode(trimmed, code, password);
      } else {
        signedIn = await authenticate(mode, trimmed, password);
      }
      if (signedIn) onSignedIn();
    } catch (reason) {
      if (mode === "login" || mode === "register") {
        if (reason instanceof ResceneApiError) {
          if (reason.code === "auth.rate_limited" || reason.status === 429) setError("操作过于频繁，请稍后再试。");
          else if (mode === "register" && reason.status === 409) setError("该邮箱已注册，请直接登录。");
          else if (mode === "login" && (reason.status === 401 || reason.status === 403)) setError("邮箱、用户名或密码不正确。");
          else setError(reason.detail || `${TITLES[mode]}失败，请稍后重试。`);
        } else {
          setError(`${TITLES[mode]}失败，请检查网络连接和设备安全存储后重试。`);
        }
      } else {
        setError(authFailure(reason, mode === "reset" ? "重置失败，请稍后重试。" : "登录失败，请稍后重试。"));
      }
    } finally {
      setBusy(false);
    }
  }

  const busyLabel = mode === "register" ? "正在创建…" : mode === "reset" ? "正在重置…" : "正在登录…";
  const submitLabel = mode === "register" ? "创建账号" : mode === "reset" ? "重置并登录" : "登录";
  const canSubmit = !busy && !sending &&
    (mode === "login"
      ? Boolean(identifier.trim()) && Boolean(password)
      : mode === "code"
        ? Boolean(email.trim()) && code.length === 6
        : Boolean(email.trim()) && Boolean(password) && Boolean(confirm));
  const canSend = !busy && !sending && cooldown === 0 && Boolean(email.trim());

  return (
    <Screen
      scroll
      title={TITLES[mode]}
    >
      <View style={{ width: "100%", maxWidth: 420, alignSelf: "center", gap: 16 }}>
        <View style={{ alignItems: "center", gap: 10, paddingTop: 4, paddingBottom: 4 }}>
          <Image
            accessible={false}
            resizeMode="cover"
            source={require("../../assets/icon.png")}
            style={{ width: 64, height: 64, borderRadius: 20 }}
          />
          <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 26, lineHeight: 32, fontWeight: "700" }}>
            ReScene
          </Text>
        </View>
        {notice ? (
          <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={textStyles.muted}>
            {notice}
          </Text>
        ) : null}
        {mode === "login" ? (
          <Field
            autoComplete="username"
            label="邮箱或用户名"
            onChangeText={setIdentifier}
            returnKeyType="next"
            textContentType="username"
            value={identifier}
          />
        ) : (
          <Field
            autoComplete="email"
            keyboardType="email-address"
            label="团队邮箱"
            onChangeText={setEmail}
            returnKeyType="next"
            textContentType="username"
            value={email}
          />
        )}
        {mode === "code" || mode === "reset" ? (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Field
                autoComplete="one-time-code"
                keyboardType="number-pad"
                label="验证码"
                onChangeText={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))}
                onSubmitEditing={mode === "code" ? () => void submit() : undefined}
                returnKeyType={mode === "code" ? "go" : "next"}
                textContentType="oneTimeCode"
                value={code}
              />
            </View>
            <View style={{ width: 124 }}>
              <Button
                disabled={!canSend}
                label={cooldown > 0 ? `${cooldown} 秒` : "发送验证码"}
                onPress={() => void sendCode()}
              />
            </View>
          </View>
        ) : null}
        {mode === "login" || mode === "register" || mode === "reset" ? (
          <Field
            key={mode}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            label={mode === "login" ? "密码" : mode === "register" ? "密码（至少 12 位）" : "新密码（至少 12 位）"}
            onChangeText={setPassword}
            onSubmitEditing={mode === "login" ? () => void submit() : undefined}
            returnKeyType={mode === "login" ? "go" : "next"}
            secureTextEntry
            textContentType={mode === "login" ? "password" : "newPassword"}
            value={password}
          />
        ) : null}
        {mode === "register" || mode === "reset" ? (
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
          accessibilityLabel={submitLabel}
          disabled={!canSubmit}
          label={busy ? busyLabel : submitLabel}
          onPress={() => void submit()}
        />
        {hint ? (
          <Text accessibilityLiveRegion="polite" style={{ color: theme.accent, fontSize: 15, lineHeight: 21 }}>
            {hint}
          </Text>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        {mode === "login" ? (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 12 }}>
              <TextAction disabled={busy || sending} label="使用邮箱验证码登录" onPress={() => changeMode("code")} />
              <TextAction disabled={busy || sending} label="忘记密码" onPress={() => changeMode("reset")} />
            </View>
            <TextAction disabled={busy || sending} label="注册账号" onPress={() => changeMode("register")} />
          </>
        ) : mode === "code" ? (
          <TextAction disabled={busy || sending} label="使用密码登录" onPress={() => changeMode("login")} />
        ) : mode === "reset" ? (
          <TextAction disabled={busy || sending} label="返回登录" onPress={() => changeMode("login")} />
        ) : (
          <TextAction disabled={busy || sending} label="返回登录" onPress={() => changeMode("login")} />
        )}
      </View>
    </Screen>
  );
}
