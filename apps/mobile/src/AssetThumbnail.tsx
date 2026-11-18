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
  return <Pressable disabled={!eligible} accessibilityRole="button" accessibilityLabel={`预览 ${asset.filename}`} onPress={() => { setUrl(""); setAttempt((value) => value + 1); }} style={{ width: 68, height: 68, margin: 8, borderRadius: 8, overflow: "hidden", backgroundColor: theme.bgDeep, alignItems: "center", justifyContent: "center" }}>
    {url && !failed ? <Image accessibilityLabel={asset.filename} source={{ uri: url }} resizeMode="cover" style={{ width: 68, height: 68 }} onError={() => setFailed(true)} /> :
      <Text style={{ color: theme.muted, fontSize: 12 }}>{failed ? "重试预览" : eligible ? "图片" : "文件"}</Text>}
  </Pressable>;
}
