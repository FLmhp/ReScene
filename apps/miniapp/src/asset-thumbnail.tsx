import type { Asset } from "@rescene/schemas";
import { Button, Image, Text, View } from "@tarojs/components";
import { useEffect, useState } from "react";
import { client } from "./api";

export function AssetThumbnail({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const eligible = asset.status === "READY" && /\.(png|jpe?g)$/i.test(asset.filename);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    setFailed(false);
    void client.getAssetPreview(asset.id).then((value) => { if (active) setUrl(value.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [asset.id, eligible, attempt]);
  if (url && !failed) return <Image className="preview-image" src={url} lazyLoad mode="aspectFill" onError={() => setFailed(true)} />;
  return <View className="preview-image preview-placeholder">
    {failed ? <Button className="button ghost compact" onClick={() => { setUrl(""); setAttempt((value) => value + 1); }}>重试预览</Button> : <Text>{eligible ? "图片" : "文件"}</Text>}
  </View>;
}
