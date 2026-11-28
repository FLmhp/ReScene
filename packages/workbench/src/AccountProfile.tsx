"use client";

import { ResceneApiError, explainError, type ResceneClient } from "@rescene/api-client";
import { MAX_AVATAR_BYTES, accountInitial, type User } from "@rescene/schemas";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { AvatarThumbnail } from "./Avatar";

export type AccountProfileProps = {
  client: ResceneClient;
  user: User;
  onUpdate: (user: User) => void;
  onMessage?: (text: string) => void;
};

const MAX_AVATAR_PIXELS = 16_000_000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/;

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function validateUsername(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 3 || normalized.length > 32) return "用户名需为 3–32 个字符。";
  if (normalized.includes("@")) return "用户名不能包含 @。";
  if (!USERNAME_PATTERN.test(normalized)) return "只能使用字母、数字、_、- 或常用汉字。";
  if (!/[a-zA-Z0-9\u4e00-\u9fff]/.test(normalized)) return "至少需要包含一个字母、数字或汉字。";
  return null;
}

export function AccountProfile({ client, user, onUpdate, onMessage }: AccountProfileProps) {
  const [username, setUsername] = useState(user.username ?? "");
  const [usernameError, setUsernameError] = useState("");
  const [usernameBusy, setUsernameBusy] = useState(false);

  const [avatarImage, setAvatarImage] = useState<{ userId: string; revision: string; src: string } | null>(null);
  const avatarSrc = avatarImage?.userId === user.id && avatarImage.revision === user.avatar_revision ? avatarImage.src : null;
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [pendingBase64, setPendingBase64] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);

  const avatarRequest = useRef(0);
  const pickerRequest = useRef(0);
  const userRef = useRef(user);
  const mountedRef = useRef(true);
  userRef.current = user;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset forms when the signed-in account changes.
  useEffect(() => {
    setUsername(user.username ?? "");
    setUsernameError("");
    setPendingAvatar(null);
    setPendingBase64(null);
    setAvatarError("");
  }, [user.id, user.username]);

  // Load the private avatar thumbnail only when the server reports a revision.
  useEffect(() => {
    if (!user.avatar_revision) {
      setAvatarImage(null);
      return;
    }
    let cancelled = false;
    const request = ++avatarRequest.current;
    void client
      .getAvatar(user.id)
      .then((avatar) => {
        if (cancelled || request !== avatarRequest.current || avatar.revision !== user.avatar_revision) return;
        setAvatarImage({ userId: user.id, revision: avatar.revision, src: `data:image/jpeg;base64,${avatar.image_base64}` });
      })
      .catch((error: unknown) => {
        if (cancelled || request !== avatarRequest.current) return;
        if (error instanceof ResceneApiError && error.status === 404) {
          setAvatarImage(null);
          return;
        }
        // Other read failures are transient; leave the initial in place.
      });
    return () => {
      cancelled = true;
    };
  }, [client, user.id, user.avatar_revision]);

  async function submitUsername(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (usernameBusy) return;
    const normalized = username.normalize("NFKC").trim();
    if (normalized === (user.username ?? "")) {
      setUsernameError("");
      return;
    }
    const error = validateUsername(normalized);
    if (error) {
      setUsernameError(error);
      return;
    }
    setUsernameBusy(true);
    setUsernameError("");
    try {
      const updated = await client.updateProfile({ username: normalized });
      if (!mountedRef.current || updated.id !== userRef.current.id) return;
      onUpdate(updated);
      onMessage?.("用户名已保存");
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      if (error instanceof ResceneApiError && error.status === 409) {
        setUsernameError("该用户名已被使用。");
      } else {
        setUsernameError(explainError(error, "保存用户名失败"));
      }
    } finally {
      if (mountedRef.current) setUsernameBusy(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++pickerRequest.current;
    const current = () => mountedRef.current && userRef.current.id === user.id && pickerRequest.current === request;
    setAvatarError("");
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError("图片超过 1 MiB，请选择更小的文件。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!current()) return;
      const dataUrl = String(reader.result);
      const image = new Image();
      image.onload = () => {
        if (!current()) return;
        if (image.naturalWidth * image.naturalHeight > MAX_AVATAR_PIXELS) {
          setAvatarError("图片像素过多，请选择更小的图片。");
          return;
        }
        setPendingBase64(dataUrlToBase64(dataUrl));
        setPendingAvatar(dataUrl);
      };
      image.onerror = () => { if (current()) setAvatarError("无法识别该图片，请换一张。"); };
      image.src = dataUrl;
    };
    reader.onerror = () => { if (current()) setAvatarError("读取文件失败。"); };
    reader.readAsDataURL(file);
  }

  async function saveAvatar() {
    if (!pendingBase64 || avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError("");
    try {
      const updated = await client.setAvatar(pendingBase64);
      if (!mountedRef.current || updated.id !== userRef.current.id) return;
      setPendingAvatar(null);
      setPendingBase64(null);
      onUpdate(updated);
      onMessage?.("头像已保存");
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setAvatarError(explainError(error, "保存头像失败"));
    } finally {
      if (mountedRef.current) setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    if (avatarBusy || !user.avatar_revision) return;
    if (!window.confirm("确定移除当前头像？移除后将显示姓名首字。")) return;
    setAvatarBusy(true);
    setAvatarError("");
    try {
      const updated = await client.removeAvatar();
      if (!mountedRef.current || updated.id !== userRef.current.id) return;
      setPendingAvatar(null);
      setPendingBase64(null);
      onUpdate(updated);
      onMessage?.("头像已移除");
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setAvatarError(explainError(error, "移除头像失败"));
    } finally {
      if (mountedRef.current) setAvatarBusy(false);
    }
  }

  function cancelAvatar() {
    pickerRequest.current += 1;
    setPendingAvatar(null);
    setPendingBase64(null);
    setAvatarError("");
  }

  const displaySrc = pendingAvatar ?? avatarSrc;
  const previewLabel = pendingAvatar ? "头像预览" : avatarSrc ? "当前头像" : "默认头像";
  const canRemove = !pendingAvatar && Boolean(user.avatar_revision);
  const usernameUnchanged = username.normalize("NFKC").trim() === (user.username ?? "");

  return (
    <div className="account-profile">
      {avatarError ? (
        <p className="error" role="alert">
          {avatarError}
        </p>
      ) : null}
      <div className="avatar-section">
        <AvatarThumbnail user={user} src={displaySrc} size={96} alt={previewLabel} />
        <div className="avatar-actions">
          <label className="primary avatar-upload">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              disabled={avatarBusy}
              aria-label="选择头像图片"
            />
            {user.avatar_revision || pendingAvatar ? "更换头像" : "选择头像"}
          </label>
          <small className="muted">支持 JPEG、PNG、WebP，最大 1 MiB。</small>
          {pendingAvatar ? (
            <div className="avatar-pending-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void saveAvatar()}
                disabled={avatarBusy}
              >
                {avatarBusy ? "保存中…" : "保存头像"}
              </button>
              <button type="button" onClick={cancelAvatar} disabled={avatarBusy}>
                取消
              </button>
            </div>
          ) : canRemove ? (
            <button type="button" onClick={() => void removeAvatar()} disabled={avatarBusy}>
              {avatarBusy ? "处理中…" : "移除头像"}
            </button>
          ) : null}
        </div>
      </div>

      <form className="username-form" onSubmit={submitUsername}>
        <label>
          用户名
          <input
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setUsernameError("");
            }}
            disabled={usernameBusy}
            placeholder="设置用户名"
            maxLength={40}
            aria-invalid={usernameError ? "true" : undefined}
            aria-describedby={usernameError ? "username-error" : undefined}
          />
        </label>
        {usernameError ? (
          <p className="error" id="username-error" role="alert">
            {usernameError}
          </p>
        ) : null}
        <button type="submit" disabled={usernameBusy || usernameUnchanged}>
          {usernameBusy ? "保存中…" : "保存用户名"}
        </button>
      </form>

      <div className="read-only-field">
        <label>邮箱</label>
        <p>{user.email}</p>
      </div>

      {user.is_admin ? <p className="muted">管理员</p> : null}

      <p className="muted initial-hint">
        未设置头像时显示「{accountInitial(user)}」作为占位图。
      </p>
    </div>
  );
}
