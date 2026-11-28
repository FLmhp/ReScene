"use client";

import { accountInitial } from "@rescene/schemas";

export type AvatarUser = { username: string | null; email: string };

export type AvatarThumbnailProps = {
  user: AvatarUser;
  src?: string | null;
  size?: number;
  alt?: string;
  className?: string;
};

export function AvatarThumbnail({ user, src, size = 48, alt, className = "" }: AvatarThumbnailProps) {
  const initial = accountInitial(user);
  return (
    <span
      className={`avatar-thumbnail ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      title={alt ?? `${user.username ?? user.email} 的头像`}
      role={src ? undefined : "img"}
      aria-label={src ? undefined : (alt ?? `${user.username ?? user.email} 的头像`)}
    >
      {src ? (
        <img src={src} alt={alt ?? `${user.username ?? user.email} 的头像`} width={size} height={size} />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}
