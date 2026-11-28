import { explainError, isOfflineError, ResceneApiError } from "@rescene/api-client";
import type { User } from "@rescene/schemas";
import { MAX_AVATAR_BYTES, accountInitial } from "@rescene/schemas";
import { Button, Image, Input, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueOwner } from "@rescene/uploader";
import { currentQueueOwner, isQueueOwnerCurrent } from "./api";

type ClientLike = {
  getMe(): Promise<User>;
  updateProfile(patch: { username: string }): Promise<User>;
  setAvatar(imageBase64: string): Promise<User>;
  removeAvatar(): Promise<User>;
  getAvatar(userId: string): Promise<{ image_base64: string; revision: string }>;
};

function userDataRoot(): string {
  const env = Taro.env;
  if (env && typeof env === "object" && "USER_DATA_PATH" in env && typeof env.USER_DATA_PATH === "string") {
    return env.USER_DATA_PATH;
  }
  return "wxfile://usr";
}

function avatarTempDirectory(): string {
  return `${userDataRoot()}/rescene-avatar/`;
}

let avatarFileNumber = 0;

function avatarTempPath(userId: string, revision: string): string {
  const suffix = revision.slice(0, 32);
  return `${avatarTempDirectory()}avatar_${encodeURIComponent(userId)}_${suffix}_${Date.now()}_${++avatarFileNumber}.jpg`;
}

export function writeAvatarTemp(userId: string, revision: string, base64: string): string | null {
  const fs = Taro.getFileSystemManager();
  const path = avatarTempPath(userId, revision);
  try {
    if (!managedMediaExists(avatarTempDirectory())) fs.mkdirSync(avatarTempDirectory(), true);
    fs.writeFileSync(path, base64, "base64");
    return managedMediaExists(path) ? path : null;
  } catch {
    return null;
  }
}

export function removeAvatarTemp(path: string): void {
  try {
    Taro.getFileSystemManager().unlinkSync(path);
  } catch {
    /* already gone or platform temp; ignore */
  }
}

function managedMediaExists(path: string): boolean {
  try {
    Taro.getFileSystemManager().accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function readFileBase64(path: string): string {
  const data = Taro.getFileSystemManager().readFileSync(path, "base64");
  if (typeof data === "string") return data;
  throw new Error("无法读取所选图片");
}

function chosenFileSize(path: string, reported: number): number {
  if (reported > MAX_AVATAR_BYTES) return reported;
  try {
    const stats = Taro.getFileSystemManager().statSync(path);
    if (stats && typeof stats === "object" && "size" in stats && typeof stats.size === "number") {
      return stats.size;
    }
    return reported;
  } catch {
    return reported;
  }
}

function apiMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ResceneApiError) return explainError(reason, reason.detail || fallback);
  if (reason instanceof Error) return reason.message;
  return fallback;
}

function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim();
}

function validateUsername(value: string): string | null {
  const normalized = normalizeUsername(value);
  if (normalized.length === 0) return "用户名不能为空。";
  if (normalized.length < 3 || normalized.length > 32) return "用户名长度为 3–32 个字符。";
  if (normalized.includes("@")) return "用户名不能包含 @。";
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(normalized)) {
    return "用户名只能使用字母、数字、下划线、连字符或常用汉字。";
  }
  if (!/[a-zA-Z0-9\u4e00-\u9fff]/.test(normalized)) {
    return "用户名至少需要包含一个字母、数字或汉字。";
  }
  return null;
}


export function AvatarThumbnail({
  user,
  src,
  size = "large",
}: {
  user: { username: string | null; email: string };
  src?: string | null;
  size?: "small" | "large";
}) {
  const initial = accountInitial(user);
  const [broken, setBroken] = useState(false);
  return (
    <View className={`avatar-thumbnail ${size}`}>
      {src && !broken ? (
        <Image
          className="preview-image"
          src={src}
          mode="aspectFill"
          onError={() => setBroken(true)}
        />
      ) : (
        <View className="avatar-initial">
          <Text>{initial}</Text>
        </View>
      )}
    </View>
  );
}

export function AvatarProfile({ client }: { client: ClientLike }) {
  const [user, setUser] = useState<User | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [pending, setPending] = useState<{ path: string; base64: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const createdPaths = useRef<Set<string>>(new Set());
  const activePath = useRef<string | null>(null);
  const shown = useRef(false);
  const loadRequest = useRef(0);
  const avatarRequest = useRef(0);

  const cleanupPaths = useCallback((paths: Iterable<string>) => {
    for (const path of paths) {
      if (path) removeAvatarTemp(path);
    }
  }, []);

  const clearPending = useCallback(() => {
    if (pending) {
      createdPaths.current.delete(pending.path);
      removeAvatarTemp(pending.path);
      setPending(null);
    }
  }, [pending]);

  const setManagedAvatarPath = useCallback((path: string | null) => {
    const previous = activePath.current;
    if (previous && previous !== path) {
      createdPaths.current.delete(previous);
      removeAvatarTemp(previous);
    }
    if (path) createdPaths.current.add(path);
    activePath.current = path;
    setAvatarPath(path);
  }, []);

  const loadAvatar = useCallback(async (owner: QueueOwner, revision: string) => {
    const generation = ++avatarRequest.current;
    try {
      const avatar = await client.getAvatar(owner.id);
      if (!shown.current || !isQueueOwnerCurrent(owner) || generation !== avatarRequest.current || revision !== avatar.revision) return;
      const path = writeAvatarTemp(owner.id, avatar.revision, avatar.image_base64);
      if (path) {
        setManagedAvatarPath(path);
      } else {
        // Fallback to data URI if the platform cannot create a temp file.
        setManagedAvatarPath(`data:image/jpeg;base64,${avatar.image_base64}`);
      }
    } catch (reason) {
      if (shown.current && generation === avatarRequest.current && isQueueOwnerCurrent(owner)) setError(apiMessage(reason, "读取头像失败。"));
    }
  }, [client, setManagedAvatarPath]);

  const load = useCallback(async () => {
    const owner = currentQueueOwner();
    if (!owner) {
      setError("登录会话已过期，请重新登录。");
      return;
    }
    const request = ++loadRequest.current;
    avatarRequest.current += 1;
    setManagedAvatarPath(null);
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const me = await client.getMe();
      if (!shown.current || request !== loadRequest.current || !isQueueOwnerCurrent(owner) || me.id !== owner.id) return;
      setUser(me);
      setUsernameDraft(me.username ?? "");
      if (me.avatar_revision) {
        await loadAvatar(owner, me.avatar_revision);
      } else {
        setManagedAvatarPath(null);
      }
    } catch (reason) {
      if (shown.current && request === loadRequest.current && isQueueOwnerCurrent(owner)) {
        setError(apiMessage(reason, isOfflineError(reason) ? "网络不可用，请联网后重试。" : "加载账户资料失败。"));
      }
    } finally {
      if (shown.current && request === loadRequest.current && isQueueOwnerCurrent(owner)) setLoading(false);
    }
  }, [client, loadAvatar, setManagedAvatarPath]);

  useDidShow(() => {
    if (shown.current) return;
    shown.current = true;
    void load();
  });
  const reload = useRef(load);
  reload.current = load;
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      void reload.current();
    }
    return () => {
      shown.current = false;
      loadRequest.current += 1;
      avatarRequest.current += 1;
      cleanupPaths(createdPaths.current);
    };
  }, [cleanupPaths]);
  useDidHide(() => {
    shown.current = false;
    loadRequest.current += 1;
    avatarRequest.current += 1;
    clearPending();
    setManagedAvatarPath(null);
  });

  async function chooseAvatar() {
    const owner = currentQueueOwner();
    if (lock.current || !shown.current || !owner || !user || owner.id !== user.id) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await Taro.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album"],
      });
      const file = result.tempFiles[0];
      if (!file) return;
      if (!shown.current || !isQueueOwnerCurrent(owner)) {
        removeAvatarTemp(file.tempFilePath);
        return;
      }
      const actualSize = chosenFileSize(file.tempFilePath, file.size);
      if (actualSize > MAX_AVATAR_BYTES) {
        removeAvatarTemp(file.tempFilePath);
        setError("图片超过 1 MiB，请选择更小的图片。");
        return;
      }
      if (!(actualSize > 0)) {
        removeAvatarTemp(file.tempFilePath);
        setError("无法读取所选图片，请重试。");
        return;
      }
      const base64 = readFileBase64(file.tempFilePath);
      clearPending();
      createdPaths.current.add(file.tempFilePath);
      setPending({ path: file.tempFilePath, base64 });
    } catch (reason) {
      const text = reason && typeof reason === "object" && "errMsg" in reason
        ? String(reason.errMsg)
        : reason instanceof Error ? reason.message : String(reason);
      if (/cancel|取消/.test(text)) return;
      if (shown.current && isQueueOwnerCurrent(owner)) setError(apiMessage(reason, "选择图片失败。"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function saveAvatar() {
    if (lock.current || !pending) return;
    const owner = currentQueueOwner();
    if (!shown.current || !owner || owner.id !== user?.id) return;
    loadRequest.current += 1;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const me = await client.setAvatar(pending.base64);
      if (!shown.current || !isQueueOwnerCurrent(owner) || me.id !== owner.id) return;
      setManagedAvatarPath(null);
      setUser(me);
      clearPending();
      if (me.avatar_revision) {
        await loadAvatar(owner, me.avatar_revision);
      } else {
        setManagedAvatarPath(null);
      }
      setNotice("头像已保存。");
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) {
        setError(apiMessage(reason, isOfflineError(reason) ? "网络不可用，头像未保存。" : "保存头像失败。"));
      }
    } finally {
      if (isQueueOwnerCurrent(owner)) setBusy(false);
      lock.current = false;
    }
  }

  async function removeAvatar() {
    const owner = currentQueueOwner();
    if (lock.current || !shown.current || !owner || owner.id !== user?.id) return;
    const confirm = await Taro.showModal({
      title: "移除头像",
      content: "确定移除当前头像并恢复为默认首字头像？",
      confirmText: "移除",
    });
    if (!confirm.confirm || lock.current || !shown.current || !isQueueOwnerCurrent(owner)) return;
    loadRequest.current += 1;
    avatarRequest.current += 1;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const me = await client.removeAvatar();
      if (!shown.current || !isQueueOwnerCurrent(owner) || me.id !== owner.id) return;
      setUser(me);
      clearPending();
      setManagedAvatarPath(null);
      setNotice("头像已移除。");
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) {
        setError(apiMessage(reason, isOfflineError(reason) ? "网络不可用，请联网后重试。" : "移除头像失败。"));
      }
    } finally {
      if (isQueueOwnerCurrent(owner)) setBusy(false);
      lock.current = false;
    }
  }

  async function saveUsername() {
    if (lock.current) return;
    const validation = validateUsername(usernameDraft);
    if (validation) { setError(validation); return; }
    const owner = currentQueueOwner();
    if (!shown.current || !owner || owner.id !== user?.id) return;
    loadRequest.current += 1;
    const next = normalizeUsername(usernameDraft);
    if (next === (user?.username ?? "")) { setNotice("用户名未更改。"); return; }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const me = await client.updateProfile({ username: next });
      if (!shown.current || !isQueueOwnerCurrent(owner) || me.id !== owner.id) return;
      setUser(me);
      setUsernameDraft(me.username ?? "");
      setNotice("用户名已保存。");
    } catch (reason) {
      if (isQueueOwnerCurrent(owner)) {
        setError(apiMessage(reason, isOfflineError(reason) ? "网络不可用，用户名未保存。" : "保存用户名失败。"));
      }
    } finally {
      if (isQueueOwnerCurrent(owner)) setBusy(false);
      lock.current = false;
    }
  }

  const previewSrc = pending?.path ?? avatarPath ?? null;
  const hasAvatar = Boolean(user?.avatar_revision);
  const displayUser = user ?? { username: null, email: "" };

  return (
    <View className="card">
      <View className="avatar-row">
        <AvatarThumbnail user={displayUser} src={previewSrc} />
        <View className="avatar-meta">
          <Text className="label">{pending ? "新头像预览" : hasAvatar ? "当前头像" : "默认头像"}</Text>
          <Text className="muted">仅支持相册图片，不超过 1 MiB。</Text>
        </View>
      </View>
      <View className="avatar-actions">
        <Button className="button ghost" disabled={busy || !user} onClick={() => void chooseAvatar()}>
          {hasAvatar || pending ? "更换头像" : "选择头像"}
        </Button>
        {hasAvatar && !pending ? (
          <Button className="button ghost danger-action" disabled={busy} onClick={() => void removeAvatar()}>
            移除头像
          </Button>
        ) : null}
        {pending ? (
          <>
            <Button className="button" loading={busy} disabled={busy} onClick={() => void saveAvatar()}>
              保存头像
            </Button>
            <Button className="button ghost" disabled={busy} onClick={clearPending}>取消</Button>
          </>
        ) : null}
      </View>

      <Text className="label">用户名</Text>
      <Input
        className="input"
        maxlength={32}
        value={usernameDraft}
        onInput={(e) => setUsernameDraft(e.detail.value)}
        placeholder="设置显示用户名（3–32 个字符）"
      />
      <Button className="button" loading={busy} disabled={busy || !usernameDraft.trim()} onClick={() => void saveUsername()}>
        保存用户名
      </Button>

      <Text className="label">邮箱</Text>
      <Text className="muted">{user?.email ?? "—"}</Text>

      {loading ? <Text className="muted">加载中…</Text> : null}
      {error ? <Text className="error">{error}</Text> : null}
      {notice ? <Text className="success-state">{notice}</Text> : null}
    </View>
  );
}
