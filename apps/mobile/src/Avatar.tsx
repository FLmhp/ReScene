import { accountInitial } from "@rescene/schemas";
import type { User } from "@rescene/schemas";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";

import { client } from "./api";
import { useAppearance } from "./appearance";
import { ScaledText as Text } from "./ui";

export function Avatar({
  user,
  size = 48,
  showImage = true,
}: {
  user: Pick<User, "id" | "username" | "email" | "avatar_revision">;
  size?: number;
  showImage?: boolean;
}) {
  const { theme } = useAppearance();
  const [image, setImage] = useState<{ userId: string; revision: string; uri: string } | null>(null);
  const uri = showImage && image?.userId === user.id && image.revision === user.avatar_revision ? image.uri : "";

  useEffect(() => {
    setImage(null);
    if (!showImage || !user.avatar_revision) return;
    let active = true;
    void client
      .getAvatar(user.id)
      .then((avatar) => {
        if (!active || avatar.revision !== user.avatar_revision) return;
        setImage({ userId: user.id, revision: avatar.revision, uri: `data:image/jpeg;base64,${avatar.image_base64}` });
      })
      .catch(() => {
        // The account initial stays visible on a failed read.
      });
    return () => {
      active = false;
    };
  }, [user.id, user.avatar_revision, showImage]);

  const initial = accountInitial(user);
  const radius = size / 2;
  const fontSize = Math.round(size * 0.45);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: theme.accentStrong,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {uri ? (
        <Image
          accessibilityLabel="头像"
          source={{ uri }}
          resizeMode="cover"
          style={{ width: size, height: size }}
          onError={() => setImage((current) => current?.uri === uri ? null : current)}
        />
      ) : (
        <Text
          style={{
            color: theme.onAccent,
            fontSize,
            lineHeight: Math.round(fontSize * 1.2),
            fontWeight: "600",
          }}
        >
          {initial}
        </Text>
      )}
    </View>
  );
}
