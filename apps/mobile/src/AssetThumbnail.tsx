import { useEffect, useState } from "react";
import { Image, Pressable, Text } from "react-native";
import type { Asset } from "@rescene/schemas";
import { client } from "./api";
import { useAppearance } from "./appearance";

export function AssetThumbnail({ asset }: { asset: Asset }) {
  const { theme } = useAppearance();
  const [url, setUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const eligible = asset.status === "READY" && /\.(jpg|png|jpeg)$/i.test(asset.filename);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    setFailed(false);
    void client.getAssetPreview(asset.id).then((value) => { if (active) setUrl(value.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [asset.id, eligible, attempt]);
  return <Pressable disabled={!failed} accessibilityRole={failed ? "button" : undefined} accessibilityLabel={failed ? `重试预览 ${asset.filename}` : undefined} onPress={() => { setUrl(""); setAttempt((value) => value + 1); }} style={{ width: "100%", aspectRatio: 4 / 3, overflow: "hidden", backgroundColor: theme.bgDeep, alignItems: "center", justifyContent: "center" }}>
    {url && !failed ? <Image accessibilityLabel={asset.filename} source={{ uri: url }} resizeMode="cover" style={{ width: "100%", height: "100%" }} onError={() => setFailed(true)} /> :
      <Text style={{ color: theme.muted, fontSize: 13 }}>{failed ? "重试预览" : eligible ? "图片" : "文件"}</Text>}
  </Pressable>;
}
